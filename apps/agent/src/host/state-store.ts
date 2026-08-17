import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import { syncDirectoryForDurability } from "./durable-file.js";
import {
  acquireStateLock,
  assertAbortSignalsActive,
  type StateLock,
} from "./state-lock.js";

const require = createRequire(import.meta.url);
// user_preferences, thread_permissions, durable_mutation_claims,
// queue_item_states, and queue_consumption_claims are additive tables that
// schema-4 Agents safely ignore.
// Keep the persisted marker at 4 so a release rollback can still open the
// database. Version 5 was used briefly by the unreleased implementation and
// is normalized back to 4 when encountered.
export const LEGACY_STATE_SCHEMA_VERSION = 4;
const SCHEMA_VERSION = LEGACY_STATE_SCHEMA_VERSION;
const ROLLBACK_COMPATIBLE_DRAFT_VERSION = 5;
let sqlModule: Promise<SqlJsStatic> | undefined;

export class HostStateStore {
  readonly #path: string;
  readonly #coordinationAcquisitionAbort = new AbortController();
  #database: Database;
  #tail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  private constructor(path: string, database: Database) {
    this.#path = path;
    this.#database = database;
  }

  static async open(path: string): Promise<HostStateStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const SQL = await loadSqlModule();
    const lock = await acquireStateLock(`${path}.lock`);
    try {
      let bytes: Uint8Array | undefined;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const store = new HostStateStore(path, new SQL.Database(bytes));
      try {
        await store.#migrate(lock);
        return store;
      } catch (error) {
        store.#database.close();
        throw error;
      }
    } finally {
      await lock.release();
    }
  }

  transaction<T>(operation: (database: Database) => T): Promise<T> {
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

  read<T>(operation: (database: Database) => T): Promise<T> {
    return this.#serialize(async () => {
      this.#assertOpen();
      await this.#reload();
      return operation(this.#database);
    });
  }

  async acquireCoordinationLock(
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ release(): Promise<void> }> {
    this.#assertOpen();
    if (!/^[a-z0-9-]{1,128}$/u.test(name)) {
      throw new Error("Host state coordination lock name is invalid");
    }
    // A TUI or app-server permission update can legitimately outlive the
    // short transaction-lock budget. Coordination therefore waits until the
    // live owner releases, while callers may still cancel during shutdown.
    const signals = [
      this.#coordinationAcquisitionAbort.signal,
      ...(options.signal ? [options.signal] : []),
    ];
    const lock = await acquireStateLock(`${this.#path}.${name}.lock`, {
      waitIndefinitely: true,
      signals,
    });
    try {
      // Closing can race the final filesystem operation that acquired the
      // public lock. Recheck before and after publishing the commit fence so a
      // caller can never receive a new lease after this store starts closing.
      assertAbortSignalsActive(signals);
      // Coordination protects an external app-server side effect, so the
      // lease must not become reclaimable while a live owner is paused. The
      // non-leased commit fence is recoverable only after proving the same-host
      // process identity dead and therefore fails closed across long pauses.
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
    if (!this.#closePromise) {
      // Abort only acquisitions that have not returned a lease. A successfully
      // acquired coordination lease remains caller-owned so an in-flight
      // external side effect cannot be unfenced by store shutdown.
      this.#coordinationAcquisitionAbort.abort(
        new Error("Host state store is closed"),
      );
      this.#closePromise = (async () => {
        await this.#tail;
        if (this.#closed) return;
        this.#closed = true;
        this.#database.close();
      })();
    }
    return this.#closePromise;
  }

  async #migrate(lock: StateLock): Promise<void> {
    const applicationId = Number(
      this.#database.exec("PRAGMA application_id")[0]?.values[0]?.[0] ?? 0,
    );
    if (applicationId !== 0) {
      throw new Error(
        "Host state belongs to a newer schema kind; run an explicit state rollback migration",
      );
    }
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
    const hasLegacyThreadStartClaims = this.#hasTable("thread_start_claims");
    const hasQueueConsumptionClaims = this.#hasTable(
      "queue_consumption_claims",
    );
    const hasQueueItemStates = this.#hasTable("queue_item_states");
    const hasLegacyRawQueueItems =
      this.#hasTable("queue_items") && this.#hasNonDoneQueueItems();
    const schemaReady =
      version === SCHEMA_VERSION &&
      this.#hasTable("user_preferences") &&
      this.#hasTable("thread_permissions") &&
      this.#hasTable("thread_permission_observation_state") &&
      this.#hasTable("thread_permission_observations") &&
      this.#hasTable("durable_mutation_claims") &&
      hasQueueConsumptionClaims &&
      hasQueueItemStates &&
      !hasLegacyRawQueueItems &&
      !hasLegacyThreadStartClaims &&
      this.#hasTable("workspace_authorization_state") &&
      this.#hasColumn("thread_permissions", "approvals_reviewer");
    const sensitiveIdempotencyKeys = this.#sensitiveIdempotencyKeys();
    if (schemaReady && sensitiveIdempotencyKeys.length === 0) return;

    this.#database.run("BEGIN IMMEDIATE");
    let committed = false;
    try {
      this.#database.run(LEGACY_STATE_SCHEMA_V4);
      // A short-lived unreleased build used a thread/start-specific table.
      // Preserve its claims in the generic table, then securely remove the old
      // whole-payload fingerprints. A rollback recreates the additive table
      // and remains fail-closed through the permanent legacy mirror.
      if (hasLegacyThreadStartClaims) {
        this.#database.run("PRAGMA secure_delete = ON");
        this.#database.run(`
          INSERT OR IGNORE INTO durable_mutation_claims (
            key,
            method,
            request_fingerprint,
            result_json,
            created_at,
            completed_at
          )
          SELECT
            key,
            'thread/start',
            'legacy-thread-start-claim-v1',
            result_json,
            created_at,
            completed_at
          FROM thread_start_claims
        `);
        // The old fingerprint was a permanent hash of the whole payload. It
        // is neither needed for at-most-once execution nor safe to retain as
        // an offline oracle for paths or other low-entropy request data. A
        // rollback recreates this additive table and remains protected by the
        // permanent idempotency_keys mirror.
        this.#database.run("DROP TABLE thread_start_claims");
      }
      if (hasLegacyRawQueueItems || !hasQueueConsumptionClaims) {
        // Current Agents keep every Queue row physically `done` from enqueue
        // onward and store actionable state only in the additive table. Thus
        // any physical non-done row was created or restored while an old Agent
        // was running and cannot be proven side-effect free. Quarantine these
        // rows on every upgrade, including new -> old -> new rollbacks where
        // the consumption-claim table already exists.
        const rows = this.#database.prepare(
          "SELECT id, request_json, created_at FROM queue_items WHERE status IS NOT 'done'",
        );
        const now = new Date().toISOString();
        try {
          while (rows.step()) {
            const row = rows.getAsObject() as {
              id?: unknown;
              request_json?: unknown;
              created_at?: unknown;
            };
            const itemId = String(row.id);
            const identity = legacyQueueConsumptionIdentity(
              itemId,
              row.request_json,
            );
            this.#database.run(
              "DELETE FROM queue_item_states WHERE queue_item_id = ?",
              [itemId],
            );
            this.#database.run(
              "INSERT OR IGNORE INTO queue_consumption_claims (queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at) VALUES (?, 'legacy', ?, ?, 'indeterminate', NULL, ?, ?)",
              [
                itemId,
                identity.threadId,
                identity.clientUserMessageId,
                typeof row.created_at === "string" ? row.created_at : now,
                now,
              ],
            );
            this.#database.run(
              "UPDATE queue_consumption_claims SET outcome = 'indeterminate', completed_at = ? WHERE queue_item_id = ? AND (outcome IS NULL OR outcome NOT IN ('completed', 'abandoned'))",
              [now, itemId],
            );
            this.#database.run(
              "UPDATE queue_items SET status = 'done', updated_at = ? WHERE id = ?",
              [now, itemId],
            );
          }
        } finally {
          rows.free();
        }
      }
      if (!this.#hasColumn("thread_permissions", "approvals_reviewer")) {
        this.#database.run(
          "ALTER TABLE thread_permissions ADD COLUMN approvals_reviewer TEXT NOT NULL DEFAULT ''",
        );
      }
      if (sensitiveIdempotencyKeys.length > 0)
        this.#database.run("PRAGMA secure_delete = ON");
      for (const key of sensitiveIdempotencyKeys) {
        this.#database.run("DELETE FROM idempotency_keys WHERE key = ?", [key]);
      }
      this.#database.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.#database.run("COMMIT");
      committed = true;
      await this.#persist(lock);
    } catch (error) {
      if (!committed) this.#database.run("ROLLBACK");
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

  #hasColumn(table: string, column: string): boolean {
    const result = this.#database.exec(`PRAGMA table_info(${table})`);
    return (result[0]?.values ?? []).some((row) => row[1] === column);
  }

  #hasNonDoneQueueItems(): boolean {
    const statement = this.#database.prepare(
      "SELECT 1 FROM queue_items WHERE status IS NOT 'done' LIMIT 1",
    );
    try {
      return statement.step();
    } finally {
      statement.free();
    }
  }

  #sensitiveIdempotencyKeys(): string[] {
    if (!this.#hasTable("idempotency_keys")) return [];
    const statement = this.#database.prepare(
      "SELECT key, result_json FROM idempotency_keys",
    );
    const keys: string[] = [];
    try {
      while (statement.step()) {
        const row = statement.getAsObject() as {
          key?: unknown;
          result_json?: unknown;
        };
        if (typeof row.key !== "string") continue;
        if (typeof row.result_json !== "string") {
          keys.push(row.key);
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(row.result_json);
          if (containsSensitiveIdempotencyResult(parsed)) keys.push(row.key);
        } catch {
          // Fail closed: an unreadable historical replay row cannot be
          // demonstrated not to contain a one-time authentication secret.
          keys.push(row.key);
        }
      }
      return keys;
    } finally {
      statement.free();
    }
  }

  async #persist(lock: StateLock): Promise<void> {
    // Publishing the whole sql.js database cannot be fenced by rename alone:
    // an expired writer could otherwise pause after its ownership check and
    // overwrite a successor. The commit fence is a non-leased hard link to the
    // owner record. Reclaimers fail closed while it exists.
    const commitFence = await lock.beginCommit();
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(this.#database.export());
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A foreign host may have reclaimed an expired lease while this process
      // was paused or blocked in export/fsync. Never publish an old database
      // snapshot unless the stable lock name still belongs to this owner.
      await lock.assertOwned();
      await rename(temporary, this.#path);
      await syncDirectoryForDurability(dirname(this.#path));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    } finally {
      await commitFence.release();
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
    const applicationId = Number(
      replacement.exec("PRAGMA application_id")[0]?.values[0]?.[0] ?? 0,
    );
    if (applicationId !== 0 || version !== SCHEMA_VERSION) {
      replacement.close();
      throw new Error(
        `Host state schema changed while running: expected legacy schema ${SCHEMA_VERSION}`,
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

const SENSITIVE_IDEMPOTENCY_RESULT_KEYS = new Set([
  "handoffCode",
  "loginResponse",
  "recoveryCodes",
  "registrationResponse",
  "resumeToken",
  "userCode",
]);

function containsSensitiveIdempotencyResult(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(containsSensitiveIdempotencyResult);
  if (!value || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      SENSITIVE_IDEMPOTENCY_RESULT_KEYS.has(key) ||
      containsSensitiveIdempotencyResult(nested)
    ) {
      return true;
    }
  }
  return false;
}

function legacyQueueConsumptionIdentity(
  itemId: string,
  requestJson: unknown,
): { threadId: string; clientUserMessageId: string } {
  try {
    if (typeof requestJson !== "string") throw new Error("missing request");
    const request = JSON.parse(requestJson) as {
      threadId?: unknown;
      turnPayload?: { clientUserMessageId?: unknown };
    };
    return {
      threadId:
        typeof request.threadId === "string" && request.threadId !== ""
          ? request.threadId
          : `legacy:${itemId}`,
      clientUserMessageId:
        typeof request.turnPayload?.clientUserMessageId === "string" &&
        request.turnPayload.clientUserMessageId !== ""
          ? request.turnPayload.clientUserMessageId
          : `queue:${itemId}`,
    };
  } catch {
    return {
      threadId: `legacy:${itemId}`,
      clientUserMessageId: `queue:${itemId}`,
    };
  }
}

export const LEGACY_STATE_SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS workspace_roots (
  path TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_authorization_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO workspace_authorization_state (id, revision)
VALUES (1, 0);
CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_sandbox TEXT NOT NULL,
  default_approval_policy TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_permissions (
  thread_id TEXT PRIMARY KEY,
  approval_policy_json TEXT NOT NULL,
  approvals_reviewer TEXT NOT NULL,
  sandbox_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_permission_observation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL
);
INSERT OR IGNORE INTO thread_permission_observation_state (id, generation)
VALUES (1, 0);
CREATE TABLE IF NOT EXISTS thread_permission_observations (
  thread_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS durable_mutation_claims (
  key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS queue_consumption_claims (
  queue_item_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  client_user_message_id TEXT NOT NULL,
  outcome TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS queue_item_states (
  queue_item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
