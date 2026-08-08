import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import { isProcessAlive, readProcessRecord } from "./process-files.js";

const require = createRequire(import.meta.url);
// user_preferences is an additive table that schema-4 Agents safely ignore.
// Keep the persisted marker at 4 so a release rollback can still open the
// database. Version 5 was used briefly by the unreleased implementation and
// is normalized back to 4 when encountered.
const SCHEMA_VERSION = 4;
const ROLLBACK_COMPATIBLE_DRAFT_VERSION = 5;
let sqlModule: Promise<SqlJsStatic> | undefined;

export class HostStateStore {
  readonly #path: string;
  #database: Database;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(path: string, database: Database) {
    this.#path = path;
    this.#database = database;
  }

  static async open(path: string): Promise<HostStateStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const SQL = await loadSqlModule();
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const store = new HostStateStore(path, new SQL.Database(bytes));
    try {
      await store.#migrate();
      return store;
    } catch (error) {
      store.#database.close();
      throw error;
    }
  }

  transaction<T>(operation: (database: Database) => T): Promise<T> {
    return this.#serialize(async () => {
      this.#assertOpen();
      const lock = await acquireStateLock(`${this.#path}.lock`);
      try {
        await this.#reload();
        this.#database.run("BEGIN IMMEDIATE");
        try {
          const result = operation(this.#database);
          this.#database.run("COMMIT");
          await this.#persist();
          return result;
        } catch (error) {
          this.#database.run("ROLLBACK");
          throw error;
        }
      } finally {
        await lock.release();
      }
    });
  }

  read<T>(operation: (database: Database) => T): Promise<T> {
    return this.#serialize(async () => {
      this.#assertOpen();
      await this.#reload();
      return operation(this.#database);
    });
  }

  async close(): Promise<void> {
    await this.#tail;
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  async #migrate(): Promise<void> {
    const version = Number(
      this.#database.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? 0,
    );
    if (
      version > SCHEMA_VERSION &&
      version !== ROLLBACK_COMPATIBLE_DRAFT_VERSION
    ) {
      throw new Error(
        `Host state schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (version === SCHEMA_VERSION && this.#hasTable("user_preferences"))
      return;

    this.#database.run("BEGIN IMMEDIATE");
    try {
      this.#database.run(SCHEMA_V1);
      this.#database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.#database.run("COMMIT");
      await this.#persist();
    } catch (error) {
      this.#database.run("ROLLBACK");
      throw error;
    }
  }

  #hasTable(name: string): boolean {
    const statement = this.#database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    );
    try {
      statement.bind([name]);
      return statement.step();
    } finally {
      statement.free();
    }
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(this.#database.export());
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#path);
      const directory = await open(dirname(this.#path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #reload(): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.#path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const SQL = await loadSqlModule();
    const replacement = new SQL.Database(bytes);
    const version = Number(
      replacement.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? 0,
    );
    if (version !== SCHEMA_VERSION) {
      replacement.close();
      throw new Error(
        `Host state schema changed while running: expected ${SCHEMA_VERSION}, got ${version}`,
      );
    }
    const previous = this.#database;
    this.#database = replacement;
    previous.close();
  }

  #serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Host state store is closed");
  }
}

type StateLock = { release(): Promise<void> };

async function acquireStateLock(path: string): Promise<StateLock> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.sync();
      return {
        release: async () => {
          await handle.close();
          await rm(path, { force: true });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const owner = await readProcessRecord(path);
    if (owner && !isProcessAlive(owner.pid)) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for host state transaction lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function loadSqlModule(): Promise<SqlJsStatic> {
  sqlModule ??= initSqlJs({
    locateFile: (file) =>
      file.endsWith(".wasm")
        ? require.resolve("sql.js/dist/sql-wasm.wasm")
        : file,
  });
  return sqlModule;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS workspace_roots (
  path TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_sandbox TEXT NOT NULL,
  default_approval_policy TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trusted_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key BLOB NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id BLOB PRIMARY KEY,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  hash BLOB PRIMARY KEY,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS admin_recovery_tickets (
  hash BLOB PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS web_password (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_record TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_items (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  status TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES trusted_devices(id),
  subscription_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  subject_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_cache (
  thread_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_managed_users (
  uid INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  home TEXT NOT NULL,
  status TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  remove_after TEXT
);
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_username TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_events_created_at
  ON admin_audit_events(created_at DESC);
CREATE TABLE IF NOT EXISTS admin_idempotency (
  request_id TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
