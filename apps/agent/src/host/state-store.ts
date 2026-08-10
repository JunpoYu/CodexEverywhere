import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

import {
  processRecordMatches,
  processRecordUsesCurrentHostIdentity,
  readProcessRecord,
  writeProcessRecord,
} from "./process-files.js";
import { syncDirectoryForDurability } from "./durable-file.js";

const require = createRequire(import.meta.url);
// user_preferences, thread_permissions, durable_mutation_claims,
// queue_item_states, and queue_consumption_claims are additive tables that
// schema-4 Agents safely ignore.
// Keep the persisted marker at 4 so a release rollback can still open the
// database. Version 5 was used briefly by the unreleased implementation and
// is normalized back to 4 when encountered.
const SCHEMA_VERSION = 4;
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
      this.#database.run(SCHEMA_V1);
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

type StateLock = {
  beginCommit(): Promise<StateCommitFence>;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
};

type StateCommitFence = { release(): Promise<void> };

type FileIdentity = { dev: bigint; ino: bigint };

const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_POLL_MS = 25;
const STATE_LOCK_HEARTBEAT_MS = 5_000;
const STATE_LOCK_LEASE_MS = 60_000;
const abandonedStateLockOwners = new Map<string, Set<string>>();

type StateLockWait = {
  deadline?: number;
  signals?: readonly AbortSignal[];
};

async function acquireStateLock(
  path: string,
  options: {
    waitIndefinitely?: boolean;
    signals?: readonly AbortSignal[];
  } = {},
): Promise<StateLock> {
  const wait: StateLockWait = {
    ...(options.waitIndefinitely
      ? {}
      : { deadline: Date.now() + STATE_LOCK_TIMEOUT_MS }),
    ...(options.signals ? { signals: options.signals } : {}),
  };
  assertStateLockWaitActive(wait);
  await retryAbandonedStateLockReleases(path);
  while (true) {
    assertStateLockWaitActive(wait);
    if (
      (await stateCommitFenceIsBlocking(path, wait)) ||
      (await hasBlockingQuarantine(path))
    ) {
      await waitForStateLock(wait);
      continue;
    }

    const ownerPath = await createStateLockOwner(path);
    let acquired = false;
    let published = false;
    try {
      try {
        await link(ownerPath, path);
        published = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (!(await reclaimStaleStateLock(path, wait))) {
          await waitForStateLock(wait);
        }
        continue;
      }

      // A stale-lock reclaimer may have moved the previous owner after our
      // preflight check but before this hard link was published. Quarantine
      // entries gate new owners; relinquish this claim and retry once the
      // reclaimer has restored or removed the file it inspected.
      if (await hasBlockingQuarantine(path)) {
        await relinquishOwnedStateLock(path, ownerPath);
        published = false;
        await waitForStateLock(wait);
        continue;
      }

      assertStateLockWaitActive(wait);
      let released = false;
      const stopHeartbeat = startStateLockHeartbeat(ownerPath);
      acquired = true;
      return {
        beginCommit: () => acquireStateCommitFence(path, ownerPath),
        assertOwned: () => assertOwnedStateLock(path, ownerPath),
        release: async () => {
          if (released) return;
          stopHeartbeat();
          try {
            await relinquishOwnedStateLock(path, ownerPath);
            await rm(ownerPath, { force: true });
            forgetAbandonedStateLockOwner(path, ownerPath);
            released = true;
          } catch (error) {
            rememberAbandonedStateLockOwner(path, ownerPath);
            throw error;
          }
        },
      };
    } finally {
      // The hard link at `path` keeps the owner inode alive after acquisition.
      // On retries or errors, this removes only our unique auxiliary name.
      if (!acquired) {
        if (published) {
          try {
            await relinquishOwnedStateLock(path, ownerPath);
            published = false;
          } catch (error) {
            rememberAbandonedStateLockOwner(path, ownerPath);
            throw error;
          }
        }
        if (!published) await rm(ownerPath, { force: true });
      }
    }
  }
}

async function createStateLockOwner(path: string): Promise<string> {
  const token = randomUUID();
  const ownerPath = `${path}.owner.${token}`;
  await writeProcessRecord(ownerPath);
  return ownerPath;
}

async function reclaimStaleStateLock(
  path: string,
  wait: StateLockWait,
): Promise<boolean> {
  if (await stateCommitFenceIsBlocking(path, wait)) return false;
  const proofPath = `${path}.proof.${randomUUID()}`;
  try {
    try {
      // Pin the exact inode we inspected. If another reclaimer replaces the
      // public lock name before our rename, the inode comparison below detects
      // that replacement and restores it instead of deleting the new owner.
      await link(path, proofPath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }

    const snapshot = await readStateLockSnapshot(proofPath);
    if (!snapshot) return true;
    if (await stateLockLeaseIsActive(snapshot)) return false;

    const quarantinePath = stateLockQuarantinePath(path, "reclaim");
    try {
      await rename(path, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }

    if (await sameFile(quarantinePath, proofPath)) {
      // The expired owner may have resumed after the first lease observation.
      // Re-read only after moving the stable name: a resumed writer either
      // refreshes this inode before the move (and is restored here), or sees
      // that it lost the public name and fails its fencing assertion.
      const current = await readStateLockSnapshot(quarantinePath);
      if (
        (await stateCommitFenceIsBlocking(path, wait)) ||
        (current && (await stateLockLeaseIsActive(current)))
      ) {
        await restoreQuarantinedStateLock(quarantinePath, path, wait);
        return false;
      }
      await rm(quarantinePath, { force: true });
      return true;
    }

    await restoreQuarantinedStateLock(quarantinePath, path, wait);
    return false;
  } finally {
    await rm(proofPath, { force: true });
  }
}

async function acquireStateCommitFence(
  path: string,
  ownerPath: string,
): Promise<StateCommitFence> {
  const fencePath = stateCommitFencePath(path);
  try {
    await link(ownerPath, fencePath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    throw new Error("Host state commit fence is already held");
  }
  try {
    await assertOwnedStateLock(path, ownerPath);
  } catch (error) {
    await relinquishOwnedStateCommitFence(fencePath, ownerPath);
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      await relinquishOwnedStateCommitFence(fencePath, ownerPath);
      released = true;
    },
  };
}

async function stateCommitFenceIsBlocking(
  path: string,
  wait: StateLockWait = boundedStateLockWait(),
): Promise<boolean> {
  const fencePath = stateCommitFencePath(path);
  const proofPath = `${fencePath}.proof.${randomUUID()}`;
  try {
    try {
      await link(fencePath, proofPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const snapshot = await readStateLockSnapshot(proofPath);
    if (
      !snapshot?.record ||
      !(await processRecordUsesCurrentHostIdentity(snapshot.record)) ||
      (await stateLockProcessIdentityMatches(snapshot.record))
    ) {
      return true;
    }

    // Only a process identity proven dead on this boot can be recovered
    // automatically. Foreign commit fences deliberately fail closed because a
    // paused writer is indistinguishable from a crashed one across hosts.
    const quarantinePath = `${fencePath}.quarantine.reclaim.${randomUUID()}`;
    try {
      await rename(fencePath, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (await sameFile(quarantinePath, proofPath)) {
      await rm(quarantinePath, { force: true });
      return false;
    }
    await restoreQuarantinedStateLock(quarantinePath, fencePath, wait);
    return true;
  } finally {
    await rm(proofPath, { force: true });
  }
}

async function relinquishOwnedStateCommitFence(
  fencePath: string,
  ownerPath: string,
): Promise<void> {
  const quarantinePath = `${fencePath}.quarantine.release.${randomUUID()}`;
  try {
    await rename(fencePath, quarantinePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (await sameFile(quarantinePath, ownerPath)) {
    await rm(quarantinePath, { force: true });
  } else if (await pathExists(quarantinePath)) {
    await restoreQuarantinedStateLock(quarantinePath, fencePath);
  }
}

function stateCommitFencePath(path: string): string {
  return `${path}.commit`;
}

async function assertOwnedStateLock(
  path: string,
  ownerPath: string,
): Promise<void> {
  try {
    const now = new Date();
    await utimes(ownerPath, now, now);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new Error("Host state transaction lease was lost before commit");
  }
  if (!(await sameFile(path, ownerPath))) {
    throw new Error("Host state transaction lease was lost before commit");
  }
}

async function relinquishOwnedStateLock(
  path: string,
  ownerPath: string,
): Promise<void> {
  const quarantinePath = stateLockQuarantinePath(path, "release");
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (await sameFile(quarantinePath, ownerPath)) {
    await rm(quarantinePath, { force: true });
  } else if (await pathExists(quarantinePath)) {
    await restoreQuarantinedStateLock(quarantinePath, path);
  }

  // A racing stale reclaimer can temporarily move our inode away from the
  // stable path. Its quarantine name is unique, so deleting only names that
  // still resolve to our owner inode cannot affect a replacement lock.
  for (const candidate of await stateLockQuarantines(path)) {
    if (await sameFile(candidate, ownerPath)) {
      await rm(candidate, { force: true });
    }
  }
}

async function hasBlockingQuarantine(path: string): Promise<boolean> {
  let blocked = false;
  for (const candidate of await stateLockQuarantines(path)) {
    const snapshot = await readStateLockSnapshot(candidate);
    if (!snapshot) continue;
    if (await stateLockLeaseIsActive(snapshot)) {
      blocked = true;
      continue;
    }
    // Quarantine names are random and never reused, so stale entries can be
    // removed without touching the stable lock name or a successor owner.
    await rm(candidate, { force: true });
  }
  return blocked;
}

async function stateLockLeaseIsActive(
  snapshot: NonNullable<Awaited<ReturnType<typeof readStateLockSnapshot>>>,
): Promise<boolean> {
  // A record tied to this host can be reclaimed immediately once its PID and
  // process identity no longer match. Foreign and legacy records are safe to
  // reclaim only after their filesystem lease has clearly expired.
  if (
    snapshot.record &&
    (await processRecordUsesCurrentHostIdentity(snapshot.record))
  )
    return stateLockProcessIdentityMatches(snapshot.record);
  return Date.now() - snapshot.mtimeMs >= 0
    ? Date.now() - snapshot.mtimeMs < STATE_LOCK_LEASE_MS
    : true;
}

function stateLockProcessIdentityMatches(
  record: NonNullable<Awaited<ReturnType<typeof readProcessRecord>>>,
): Promise<boolean> {
  // executable and cmdline may legitimately change when an on-disk runtime is
  // upgraded. PID starttime, boot ID, and UID are the immutable identity used
  // to decide whether a state writer can still be alive.
  const { executable: _executable, cmdline: _cmdline, ...identity } = record;
  return processRecordMatches(identity);
}

function startStateLockHeartbeat(ownerPath: string): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(ownerPath, now, now).catch(() => undefined);
  }, STATE_LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function rememberAbandonedStateLockOwner(
  path: string,
  ownerPath: string,
): void {
  const owners = abandonedStateLockOwners.get(path) ?? new Set<string>();
  owners.add(ownerPath);
  abandonedStateLockOwners.set(path, owners);
}

function forgetAbandonedStateLockOwner(path: string, ownerPath: string): void {
  const owners = abandonedStateLockOwners.get(path);
  owners?.delete(ownerPath);
  if (owners?.size === 0) abandonedStateLockOwners.delete(path);
}

async function retryAbandonedStateLockReleases(path: string): Promise<void> {
  const owners = abandonedStateLockOwners.get(path);
  if (!owners) return;
  for (const ownerPath of [...owners]) {
    try {
      await relinquishOwnedStateLock(path, ownerPath);
      await rm(ownerPath, { force: true });
      forgetAbandonedStateLockOwner(path, ownerPath);
    } catch {
      // The regular acquisition timeout remains the final backstop when the
      // filesystem error is persistent rather than transient.
    }
  }
}

async function restoreQuarantinedStateLock(
  quarantinePath: string,
  path: string,
  wait: StateLockWait = boundedStateLockWait(),
): Promise<void> {
  while (await pathExists(quarantinePath)) {
    try {
      await link(quarantinePath, path);
      await rm(quarantinePath, { force: true });
      return;
    } catch (error) {
      if (isMissing(error)) return;
      if (!isAlreadyExists(error)) throw error;
    }
    if (await sameFile(quarantinePath, path)) {
      await rm(quarantinePath, { force: true });
      return;
    }
    await waitForStateLock(wait);
  }
}

async function stateLockQuarantines(path: string): Promise<string[]> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.quarantine.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(directory, entry));
}

function stateLockQuarantinePath(
  path: string,
  purpose: "reclaim" | "release",
): string {
  return `${path}.quarantine.${purpose}.${randomUUID()}`;
}

async function readStateLockSnapshot(path: string): Promise<
  | {
      record: Awaited<ReturnType<typeof readProcessRecord>>;
      mtimeMs: number;
    }
  | undefined
> {
  try {
    const metadata = await stat(path);
    const record = await readProcessRecord(path);
    return { record, mtimeMs: metadata.mtimeMs };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function sameFile(first: string, second: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      fileIdentity(first),
      fileIdentity(second),
    ]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const metadata = await stat(path, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function boundedStateLockWait(): StateLockWait {
  return { deadline: Date.now() + STATE_LOCK_TIMEOUT_MS };
}

function assertStateLockWaitActive(wait: StateLockWait): void {
  assertAbortSignalsActive(wait.signals ?? []);
  if (wait.deadline !== undefined && Date.now() >= wait.deadline)
    throw new Error("Timed out waiting for host state transaction lock");
}

function assertAbortSignalsActive(signals: readonly AbortSignal[]): void {
  const aborted = signals.find((signal) => signal.aborted);
  if (!aborted) return;
  throw aborted.reason instanceof Error
    ? aborted.reason
    : new Error("Host state lock acquisition was cancelled");
}

async function waitForStateLock(wait: StateLockWait): Promise<void> {
  assertStateLockWaitActive(wait);
  await new Promise<void>((resolve, reject) => {
    const listeners = new Map<AbortSignal, () => void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.clear();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const cancel = (signal: AbortSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Host state lock acquisition was cancelled"),
      );
    };
    timer = setTimeout(finish, STATE_LOCK_POLL_MS);
    for (const signal of wait.signals ?? []) {
      const listener = () => cancel(signal);
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
      // AbortSignal does not replay an abort to listeners attached after the
      // event, so close the check/listener race explicitly.
      if (signal.aborted) {
        cancel(signal);
        break;
      }
    }
  });
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

const SCHEMA_V1 = `
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
