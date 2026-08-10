import { randomUUID } from "node:crypto";

import type {
  AdminAuditEvent,
  AdminUserAccessStatus,
  AdminUserSummary,
} from "@codex-everywhere/protocol";

import type { HostStateStore } from "../host/state-store.js";
import type { UnixAccount } from "./unix-accounts.js";

const ADMIN_IDEMPOTENCY_CLAIM_TTL_MS = 2 * 60_000;
const ADMIN_IDEMPOTENCY_RETENTION_MS = 7 * 86_400_000;
const INTERRUPTED_ADMIN_OPERATION =
  "A previous administrator operation was interrupted; its external outcome is unknown and it will not be repeated";

export type AdminIdempotencyState =
  | { status: "claimed" }
  | { status: "pending"; expiresAt: string }
  | { status: "succeeded"; result: unknown }
  | { status: "failed"; error: { message: string } };

type PersistedAdminIdempotency =
  | {
      version: 1;
      fingerprint: string;
      result: unknown;
    }
  | {
      version: 2;
      fingerprint: string;
      state: "pending";
      ownerToken: string;
      expiresAt: string;
    }
  | {
      version: 2;
      fingerprint: string;
      state: "failed";
      error: { message: string };
    };

export class AdminUserRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  register(account: UnixAccount): Promise<AdminUserSummary> {
    return this.#state.transaction((database) => {
      const byUid = findUserByUid(database, account.uid);
      const byUsername = findUser(database, account.username);
      if (byUid || byUsername) {
        const existing = byUid ?? byUsername;
        if (
          !existing ||
          existing.uid !== account.uid ||
          existing.username !== account.username ||
          existing.home !== account.home ||
          (byUid && byUsername && byUid.uid !== byUsername.uid)
        ) {
          throw new Error(
            "Unix account identity conflicts with an existing managed user; explicit administrator reconciliation is required",
          );
        }
        return existing;
      }
      const now = new Date().toISOString();
      database.run(
        `INSERT INTO admin_managed_users
          (uid, username, home, status, registered_at, updated_at, revision)
         VALUES (?, ?, ?, 'enabled', ?, ?, 1)`,
        [account.uid, account.username, account.home, now, now],
      );
      return requiredUser(database, account.username);
    });
  }

  list(): Promise<AdminUserSummary[]> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        `SELECT uid, username, home, status, registered_at, updated_at,
                revision, remove_after
           FROM admin_managed_users
          ORDER BY username COLLATE NOCASE`,
      );
      const users: AdminUserSummary[] = [];
      try {
        while (statement.step()) users.push(parseUser(statement.getAsObject()));
      } finally {
        statement.free();
      }
      return users;
    });
  }

  get(username: string): Promise<AdminUserSummary | undefined> {
    return this.#state.read((database) => findUser(database, username));
  }

  setStatus(options: {
    username: string;
    expectedRevision: number;
    status: AdminUserAccessStatus;
    removeAfter?: string;
  }): Promise<AdminUserSummary> {
    return this.#state.transaction((database) => {
      const current = requiredUser(database, options.username);
      if (current.revision !== options.expectedRevision) {
        throw new Error(
          `User state changed: expected revision ${options.expectedRevision}, current revision ${current.revision}`,
        );
      }
      database.run(
        `UPDATE admin_managed_users
            SET status = ?, remove_after = ?, updated_at = ?, revision = revision + 1
          WHERE username = ? AND revision = ?`,
        [
          options.status,
          options.removeAfter ?? null,
          new Date().toISOString(),
          options.username,
          options.expectedRevision,
        ],
      );
      if (database.getRowsModified() !== 1)
        throw new Error("User state changed while applying the operation");
      return requiredUser(database, options.username);
    });
  }

  dueRemovals(now = new Date()): Promise<AdminUserSummary[]> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        `SELECT uid, username, home, status, registered_at, updated_at,
                revision, remove_after
           FROM admin_managed_users
          WHERE (status = 'removing' OR
                (status = 'removal_pending' AND remove_after <= ?))
          ORDER BY remove_after`,
      );
      statement.bind([now.toISOString()]);
      const users: AdminUserSummary[] = [];
      try {
        while (statement.step()) users.push(parseUser(statement.getAsObject()));
      } finally {
        statement.free();
      }
      return users;
    });
  }

  audit(input: {
    requestId: string;
    actor: string;
    action: string;
    targetUsername?: string;
    result: "succeeded" | "failed";
  }): Promise<AdminAuditEvent> {
    const event: AdminAuditEvent = {
      version: 1,
      id: randomUUID(),
      requestId: input.requestId,
      actor: input.actor,
      action: input.action,
      ...(input.targetUsername ? { targetUsername: input.targetUsername } : {}),
      result: input.result,
      createdAt: new Date().toISOString(),
    };
    return this.#state.transaction((database) => {
      database.run(
        `INSERT INTO admin_audit_events
          (id, request_id, actor, action, target_username, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          event.requestId,
          event.actor,
          event.action,
          event.targetUsername ?? null,
          event.result,
          event.createdAt,
        ],
      );
      return event;
    });
  }

  listAudit(limit = 100): Promise<AdminAuditEvent[]> {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.#state.read((database) => {
      const statement = database.prepare(
        `SELECT id, request_id, actor, action, target_username, result, created_at
           FROM admin_audit_events
          ORDER BY created_at DESC
          LIMIT ?`,
      );
      statement.bind([safeLimit]);
      const events: AdminAuditEvent[] = [];
      try {
        while (statement.step()) {
          const row = statement.getAsObject() as Record<string, unknown>;
          events.push({
            version: 1,
            id: String(row.id),
            requestId: String(row.request_id),
            actor: String(row.actor),
            action: String(row.action),
            ...(typeof row.target_username === "string"
              ? { targetUsername: row.target_username }
              : {}),
            result: row.result === "failed" ? "failed" : "succeeded",
            createdAt: String(row.created_at),
          });
        }
      } finally {
        statement.free();
      }
      return events;
    });
  }

  claimIdempotent(
    requestId: string,
    fingerprint: string,
    ownerToken: string,
    now = new Date(),
  ): Promise<AdminIdempotencyState> {
    return this.#state.transaction((database) => {
      cleanupCompletedIdempotency(
        database,
        new Date(now.getTime() - ADMIN_IDEMPOTENCY_RETENTION_MS),
      );
      const current = readIdempotency(database, requestId);
      if (current !== undefined) {
        return resolveIdempotencyState(
          database,
          requestId,
          fingerprint,
          current,
          now,
        );
      }
      const pending: PersistedAdminIdempotency = {
        version: 2,
        fingerprint,
        state: "pending",
        ownerToken,
        expiresAt: new Date(
          now.getTime() + ADMIN_IDEMPOTENCY_CLAIM_TTL_MS,
        ).toISOString(),
      };
      database.run(
        `INSERT INTO admin_idempotency
          (request_id, result_json, created_at) VALUES (?, ?, ?)`,
        [requestId, JSON.stringify(pending), now.toISOString()],
      );
      return { status: "claimed" };
    });
  }

  async observeIdempotent(
    requestId: string,
    fingerprint: string,
    now = new Date(),
  ): Promise<Exclude<AdminIdempotencyState, { status: "claimed" }>> {
    const current = await this.#state.read((database) =>
      readIdempotency(database, requestId),
    );
    if (current === undefined) {
      throw new Error("Administrator idempotency claim disappeared");
    }
    const observed = inspectIdempotencyState(current, fingerprint);
    if (
      observed.status !== "pending" ||
      Date.parse(observed.expiresAt) > now.getTime()
    ) {
      return observed;
    }
    return this.#state.transaction((database) => {
      const latest = readIdempotency(database, requestId);
      if (latest === undefined) {
        throw new Error("Administrator idempotency claim disappeared");
      }
      return resolveIdempotencyState(
        database,
        requestId,
        fingerprint,
        latest,
        now,
      );
    });
  }

  completeIdempotent(
    requestId: string,
    fingerprint: string,
    ownerToken: string,
    result: unknown,
  ): Promise<void> {
    return this.#finishIdempotent(requestId, fingerprint, ownerToken, {
      version: 1,
      fingerprint,
      result,
    });
  }

  failIdempotent(
    requestId: string,
    fingerprint: string,
    ownerToken: string,
    error: unknown,
  ): Promise<void> {
    return this.#finishIdempotent(requestId, fingerprint, ownerToken, {
      version: 2,
      fingerprint,
      state: "failed",
      error: { message: adminErrorMessage(error) },
    });
  }

  #finishIdempotent(
    requestId: string,
    fingerprint: string,
    ownerToken: string,
    finalValue: PersistedAdminIdempotency,
  ): Promise<void> {
    return this.#state.transaction((database) => {
      const current = readIdempotency(database, requestId);
      if (!isPendingIdempotency(current)) {
        throw new Error("Administrator idempotency claim is no longer pending");
      }
      assertIdempotencyFingerprint(current, fingerprint);
      if (current.ownerToken !== ownerToken) {
        throw new Error("Administrator idempotency claim is owned elsewhere");
      }
      database.run(
        "UPDATE admin_idempotency SET result_json = ? WHERE request_id = ?",
        [JSON.stringify(finalValue), requestId],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("Administrator idempotency claim changed while saving");
      }
    });
  }
}

function cleanupCompletedIdempotency(
  database: import("sql.js").Database,
  cutoff: Date,
): void {
  const statement = database.prepare(
    "SELECT request_id, result_json FROM admin_idempotency WHERE created_at < ?",
  );
  statement.bind([cutoff.toISOString()]);
  const removable: string[] = [];
  try {
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (typeof row.result_json !== "string") continue;
      const value = JSON.parse(row.result_json) as unknown;
      // Pending and failed version-2 claims are retained: their external
      // outcome may be unknown and reusing the request ID must never repeat it.
      if (!isPendingIdempotency(value) && !isFailedIdempotency(value)) {
        removable.push(String(row.request_id));
      }
    }
  } finally {
    statement.free();
  }
  for (const requestId of removable) {
    database.run("DELETE FROM admin_idempotency WHERE request_id = ?", [
      requestId,
    ]);
  }
}

function readIdempotency(
  database: import("sql.js").Database,
  requestId: string,
): unknown | undefined {
  const statement = database.prepare(
    "SELECT result_json FROM admin_idempotency WHERE request_id = ?",
  );
  statement.bind([requestId]);
  try {
    if (!statement.step()) return undefined;
    const value = statement.getAsObject() as { result_json?: unknown };
    if (typeof value.result_json !== "string") return undefined;
    return JSON.parse(value.result_json) as unknown;
  } finally {
    statement.free();
  }
}

function resolveIdempotencyState(
  database: import("sql.js").Database,
  requestId: string,
  fingerprint: string,
  value: unknown,
  now: Date,
): Exclude<AdminIdempotencyState, { status: "claimed" }> {
  const current = inspectIdempotencyState(value, fingerprint);
  if (
    current.status !== "pending" ||
    Date.parse(current.expiresAt) > now.getTime()
  ) {
    return current;
  }
  const failed: PersistedAdminIdempotency = {
    version: 2,
    fingerprint,
    state: "failed",
    error: { message: INTERRUPTED_ADMIN_OPERATION },
  };
  database.run(
    "UPDATE admin_idempotency SET result_json = ? WHERE request_id = ?",
    [JSON.stringify(failed), requestId],
  );
  if (database.getRowsModified() !== 1) {
    throw new Error("Administrator idempotency claim changed while expiring");
  }
  return { status: "failed", error: failed.error };
}

function inspectIdempotencyState(
  value: unknown,
  fingerprint: string,
): Exclude<AdminIdempotencyState, { status: "claimed" }> {
  if (isSucceededIdempotency(value)) {
    assertIdempotencyFingerprint(value, fingerprint);
    return { status: "succeeded", result: value.result };
  }
  if (isPendingIdempotency(value)) {
    assertIdempotencyFingerprint(value, fingerprint);
    return { status: "pending", expiresAt: value.expiresAt };
  }
  if (isFailedIdempotency(value)) {
    assertIdempotencyFingerprint(value, fingerprint);
    return { status: "failed", error: value.error };
  }
  // Compatibility with records written before fingerprints were stored.
  return { status: "succeeded", result: value };
}

function assertIdempotencyFingerprint(
  value: { fingerprint: string },
  fingerprint: string,
): void {
  if (value.fingerprint !== fingerprint) {
    throw new Error("Administrator request ID was reused with different input");
  }
}

function isSucceededIdempotency(
  value: unknown,
): value is Extract<PersistedAdminIdempotency, { version: 1 }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).version === 1 &&
    typeof (value as Record<string, unknown>).fingerprint === "string" &&
    Object.prototype.hasOwnProperty.call(value, "result")
  );
}

function isPendingIdempotency(
  value: unknown,
): value is Extract<PersistedAdminIdempotency, { state: "pending" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).version === 2 &&
    (value as Record<string, unknown>).state === "pending" &&
    typeof (value as Record<string, unknown>).fingerprint === "string" &&
    typeof (value as Record<string, unknown>).ownerToken === "string" &&
    typeof (value as Record<string, unknown>).expiresAt === "string" &&
    Number.isFinite(
      Date.parse((value as Record<string, unknown>).expiresAt as string),
    )
  );
}

function isFailedIdempotency(
  value: unknown,
): value is Extract<PersistedAdminIdempotency, { state: "failed" }> {
  const error = (value as Record<string, unknown> | null)?.error;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).version === 2 &&
    (value as Record<string, unknown>).state === "failed" &&
    typeof (value as Record<string, unknown>).fingerprint === "string" &&
    typeof error === "object" &&
    error !== null &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

function adminErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "Administrator operation failed";
  return message.slice(0, 4_096);
}

function requiredUser(database: import("sql.js").Database, username: string) {
  const user = findUser(database, username);
  if (!user) throw new Error("User is not registered for CodexEverywhere");
  return user;
}

function findUser(
  database: import("sql.js").Database,
  username: string,
): AdminUserSummary | undefined {
  const statement = database.prepare(
    `SELECT uid, username, home, status, registered_at, updated_at,
            revision, remove_after
       FROM admin_managed_users WHERE username = ?`,
  );
  statement.bind([username]);
  try {
    return statement.step() ? parseUser(statement.getAsObject()) : undefined;
  } finally {
    statement.free();
  }
}

function findUserByUid(
  database: import("sql.js").Database,
  uid: number,
): AdminUserSummary | undefined {
  const statement = database.prepare(
    `SELECT uid, username, home, status, registered_at, updated_at,
            revision, remove_after
       FROM admin_managed_users WHERE uid = ?`,
  );
  statement.bind([uid]);
  try {
    return statement.step() ? parseUser(statement.getAsObject()) : undefined;
  } finally {
    statement.free();
  }
}

function parseUser(value: unknown): AdminUserSummary {
  const row = value as Record<string, unknown>;
  const status = String(row.status);
  if (
    status !== "enabled" &&
    status !== "disabled" &&
    status !== "removal_pending" &&
    status !== "removing" &&
    status !== "removed"
  )
    throw new Error("Invalid managed user status");
  return {
    version: 1,
    uid: Number(row.uid),
    username: String(row.username),
    home: String(row.home),
    status,
    agentOnline: false,
    registeredAt: String(row.registered_at),
    updatedAt: String(row.updated_at),
    revision: Number(row.revision),
    ...(typeof row.remove_after === "string"
      ? { removeAfter: row.remove_after }
      : {}),
  };
}
