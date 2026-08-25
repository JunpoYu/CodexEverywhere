import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { Database } from "sql.js";

import { syncDirectoryForDurability } from "../../host/durable-file.js";
import {
  acquireStateLock,
  assertAbortSignalsActive,
} from "../../host/state-lock.js";
import { loadSqliteRuntime } from "./sqlite-runtime.js";

export interface SqliteStateSpec {
  readonly kind: "user" | "admin";
  readonly applicationId: number;
  readonly schemaVersion: number;
  readonly schema: string;
  readonly requiredTables: readonly string[];
}

export interface SqliteStateOwner {
  readonly uid: number;
  readonly gid: number;
}

type StateFileRevision = {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
  readonly changedMs: number;
};

/** Internal persistence primitive. Raw Database access cannot leave repositories. */
export class SqliteStateFile {
  readonly #path: string;
  readonly #spec: SqliteStateSpec;
  readonly #owner: SqliteStateOwner | undefined;
  readonly #coordinationAcquisitionAbort = new AbortController();
  #database: Database;
  #revision: StateFileRevision | undefined;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    path: string,
    spec: SqliteStateSpec,
    database: Database,
    revision: StateFileRevision | undefined,
    owner?: SqliteStateOwner,
  ) {
    this.#path = path;
    this.#spec = spec;
    this.#database = database;
    this.#revision = revision;
    this.#owner = owner;
  }

  static async open(
    path: string,
    spec: SqliteStateSpec,
    options: {
      readonly create?: boolean;
      readonly owner?: SqliteStateOwner;
    } = {},
  ): Promise<SqliteStateFile> {
    validateOwner(options.owner);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await acquireStateLock(`${path}.lock`, {
      ...(options.owner === undefined ? {} : { fileOwner: options.owner }),
    });
    try {
      const stored = await readSecureFile(path, options.owner?.uid);
      const SQL = await loadSqliteRuntime();
      if (stored === undefined) {
        if (options.create !== true)
          throw new Error("State database is missing");
        const database = new SQL.Database();
        const state = new SqliteStateFile(
          path,
          spec,
          database,
          undefined,
          options.owner,
        );
        try {
          database.run(spec.schema);
          state.#validate();
          await state.#persist(lock);
          return state;
        } catch (error) {
          database.close();
          throw error;
        }
      }
      const database = new SQL.Database(stored.bytes);
      const state = new SqliteStateFile(
        path,
        spec,
        database,
        stored.revision,
        options.owner,
      );
      try {
        state.#validate();
        return state;
      } catch (error) {
        database.close();
        throw error;
      }
    } finally {
      await lock.release();
    }
  }

  read<Result>(operation: (database: Database) => Result): Promise<Result> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const lock = await this.#acquireStateLock();
      try {
        await this.#reload();
        return operation(this.#database);
      } finally {
        await lock.release();
      }
    });
  }

  transaction<Result>(
    operation: (database: Database) => Result,
  ): Promise<Result> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const lock = await this.#acquireStateLock();
      try {
        await this.#reload();
        this.#database.run("BEGIN IMMEDIATE");
        let committed = false;
        try {
          const result = operation(this.#database);
          this.#database.run("COMMIT");
          committed = true;
          await this.#persist(lock);
          return result;
        } catch (error) {
          if (!committed) this.#database.run("ROLLBACK");
          throw error;
        }
      } finally {
        await lock.release();
      }
    });
  }

  async verify(): Promise<void> {
    await this.read((database) => {
      const integrity = database.exec("PRAGMA integrity_check")[0]
        ?.values[0]?.[0];
      if (integrity !== "ok")
        throw new Error("State database integrity check failed");
      const foreignKeys = database.exec("PRAGMA foreign_key_check");
      if (foreignKeys.some((result) => result.values.length > 0)) {
        throw new Error("State database foreign key check failed");
      }
      this.#validate();
    });
  }

  async acquireCoordinationLock(
    name: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ release(): Promise<void> }> {
    this.#assertOpen();
    if (!/^[a-z0-9-]{1,128}$/u.test(name)) {
      throw new Error("State coordination lock name is invalid");
    }
    const signals = [
      this.#coordinationAcquisitionAbort.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ];
    const lock = await acquireStateLock(`${this.#path}.${name}.lock`, {
      waitIndefinitely: true,
      signals,
      ...(this.#owner === undefined ? {} : { fileOwner: this.#owner }),
    });
    try {
      assertAbortSignalsActive(signals);
      const fence = await lock.beginCommit();
      try {
        assertAbortSignalsActive(signals);
        let released = false;
        return {
          release: async () => {
            if (released) return;
            await fence.release();
            await lock.release();
            released = true;
          },
        };
      } catch (error) {
        await fence.release();
        throw error;
      }
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  close(): Promise<void> {
    this.#coordinationAcquisitionAbort.abort(
      new Error("State database is closed"),
    );
    return this.#serialize(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#database.close();
    });
  }

  async #reload(): Promise<void> {
    const stored = await readSecureFile(this.#path, this.#owner?.uid);
    if (stored === undefined) throw new Error("State database disappeared");
    if (sameRevision(this.#revision, stored.revision)) return;
    const SQL = await loadSqliteRuntime();
    const replacement = new SQL.Database(stored.bytes);
    const previous = this.#database;
    this.#database = replacement;
    try {
      this.#validate();
    } catch (error) {
      this.#database = previous;
      replacement.close();
      throw error;
    }
    this.#revision = stored.revision;
    previous.close();
  }

  #validate(): void {
    const applicationId = pragmaNumber(this.#database, "application_id");
    const schemaVersion = pragmaNumber(this.#database, "user_version");
    if (applicationId !== this.#spec.applicationId) {
      throw new Error(
        `State database kind mismatch: expected ${this.#spec.kind}`,
      );
    }
    if (schemaVersion !== this.#spec.schemaVersion) {
      throw new Error(
        `Unsupported ${this.#spec.kind} state schema ${schemaVersion}`,
      );
    }
    const tables = new Set(
      this.#database
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .flatMap((result) => result.values)
        .map((row) => String(row[0])),
    );
    const missing = this.#spec.requiredTables.filter(
      (table) => !tables.has(table),
    );
    if (missing.length > 0) {
      throw new Error(
        `State database is missing tables: ${missing.join(", ")}`,
      );
    }
  }

  async #persist(
    lock: Awaited<ReturnType<typeof acquireStateLock>>,
  ): Promise<void> {
    const fence = await lock.beginCommit();
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    let writtenRevision: StateFileRevision | undefined;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        if (this.#owner !== undefined) {
          await handle.chown(this.#owner.uid, this.#owner.gid);
        }
        await handle.writeFile(this.#database.export());
        await handle.sync();
        writtenRevision = stateFileRevision(await handle.stat());
      } finally {
        await handle.close();
      }
      await lock.assertOwned();
      await rename(temporary, this.#path);
      await syncDirectoryForDurability(dirname(this.#path));
      this.#revision = writtenRevision;
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await fence.release();
    }
  }

  #serialize<Result>(
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #acquireStateLock() {
    return acquireStateLock(`${this.#path}.lock`, {
      ...(this.#owner === undefined ? {} : { fileOwner: this.#owner }),
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("State database is closed");
  }
}

async function readSecureFile(
  path: string,
  expectedOwnerUid = process.getuid?.(),
): Promise<
  | { readonly bytes: Uint8Array; readonly revision: StateFileRevision }
  | undefined
> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("State database is not a regular file");
    if (expectedOwnerUid !== undefined && metadata.uid !== expectedOwnerUid) {
      throw new Error("State database is not owned by the current user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("State database permissions must be 0600 or stricter");
    }
    return {
      bytes: await handle.readFile(),
      revision: stateFileRevision(metadata),
    };
  } finally {
    await handle.close();
  }
}

function stateFileRevision(metadata: Stats): StateFileRevision {
  return {
    device: metadata.dev,
    inode: metadata.ino,
    size: metadata.size,
    modifiedMs: metadata.mtimeMs,
    changedMs: metadata.ctimeMs,
  };
}

function sameRevision(
  left: StateFileRevision | undefined,
  right: StateFileRevision,
): boolean {
  return (
    left !== undefined &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs &&
    left.changedMs === right.changedMs
  );
}

function validateOwner(owner: SqliteStateOwner | undefined): void {
  if (owner === undefined) return;
  if (
    process.getuid?.() !== 0 ||
    !Number.isSafeInteger(owner.uid) ||
    owner.uid <= 0 ||
    !Number.isSafeInteger(owner.gid) ||
    owner.gid < 0
  ) {
    throw new Error("State owner override requires root and a valid UID/GID");
  }
}

function pragmaNumber(database: Database, name: string): number {
  return Number(database.exec(`PRAGMA ${name}`)[0]?.values[0]?.[0] ?? -1);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
