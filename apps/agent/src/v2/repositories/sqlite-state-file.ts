import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type { Database } from "sql.js";

import { syncDirectoryForDurability } from "../../host/durable-file.js";
import { acquireStateLock } from "../../host/state-lock.js";
import { loadSqliteRuntime } from "./sqlite-runtime.js";

export interface SqliteStateSpec {
  readonly kind: "user" | "admin";
  readonly applicationId: number;
  readonly schemaVersion: number;
  readonly schema: string;
  readonly requiredTables: readonly string[];
}

/** Internal persistence primitive. Raw Database access cannot leave repositories. */
export class SqliteStateFile {
  readonly #path: string;
  readonly #spec: SqliteStateSpec;
  #database: Database;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(path: string, spec: SqliteStateSpec, database: Database) {
    this.#path = path;
    this.#spec = spec;
    this.#database = database;
  }

  static async open(
    path: string,
    spec: SqliteStateSpec,
    options: { readonly create?: boolean } = {},
  ): Promise<SqliteStateFile> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await acquireStateLock(`${path}.lock`);
    try {
      const bytes = await readSecureFile(path);
      const SQL = await loadSqliteRuntime();
      if (bytes === undefined) {
        if (options.create !== true)
          throw new Error("State database is missing");
        const database = new SQL.Database();
        const state = new SqliteStateFile(path, spec, database);
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
      const database = new SQL.Database(bytes);
      const state = new SqliteStateFile(path, spec, database);
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
      const lock = await acquireStateLock(`${this.#path}.lock`);
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
      const lock = await acquireStateLock(`${this.#path}.lock`);
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

  close(): Promise<void> {
    return this.#serialize(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#database.close();
    });
  }

  async #reload(): Promise<void> {
    const bytes = await readSecureFile(this.#path);
    if (bytes === undefined) throw new Error("State database disappeared");
    const SQL = await loadSqliteRuntime();
    const replacement = new SQL.Database(bytes);
    const previous = this.#database;
    this.#database = replacement;
    try {
      this.#validate();
    } catch (error) {
      this.#database = previous;
      replacement.close();
      throw error;
    }
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
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(this.#database.export());
        await handle.sync();
      } finally {
        await handle.close();
      }
      await lock.assertOwned();
      await rename(temporary, this.#path);
      await syncDirectoryForDurability(dirname(this.#path));
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

  #assertOpen(): void {
    if (this.#closed) throw new Error("State database is closed");
  }
}

async function readSecureFile(path: string): Promise<Uint8Array | undefined> {
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
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && metadata.uid !== currentUid) {
      throw new Error("State database is not owned by the current user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("State database permissions must be 0600 or stricter");
    }
    return handle.readFile();
  } finally {
    await handle.close();
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
