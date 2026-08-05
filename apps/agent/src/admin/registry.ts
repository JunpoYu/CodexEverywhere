import { randomUUID } from "node:crypto";

import type {
  AdminAuditEvent,
  AdminUserAccessStatus,
  AdminUserSummary,
} from "@codex-everywhere/protocol";

import type { HostStateStore } from "../host/state-store.js";
import type { UnixAccount } from "./unix-accounts.js";

export class AdminUserRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  register(account: UnixAccount): Promise<AdminUserSummary> {
    return this.#state.transaction((database) => {
      const now = new Date().toISOString();
      database.run(
        `INSERT INTO admin_managed_users
          (uid, username, home, status, registered_at, updated_at, revision)
         VALUES (?, ?, ?, 'enabled', ?, ?, 1)
         ON CONFLICT(uid) DO UPDATE SET
          username = excluded.username,
          home = excluded.home,
          updated_at = excluded.updated_at`,
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

  readIdempotent(requestId: string): Promise<unknown | undefined> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT result_json FROM admin_idempotency WHERE request_id = ?",
      );
      statement.bind([requestId]);
      try {
        if (!statement.step()) return undefined;
        const value = statement.getAsObject() as { result_json?: unknown };
        return typeof value.result_json === "string"
          ? (JSON.parse(value.result_json) as unknown)
          : undefined;
      } finally {
        statement.free();
      }
    });
  }

  saveIdempotent(requestId: string, result: unknown): Promise<void> {
    return this.#state.transaction((database) => {
      database.run(
        `INSERT OR IGNORE INTO admin_idempotency
          (request_id, result_json, created_at) VALUES (?, ?, ?)`,
        [requestId, JSON.stringify(result), new Date().toISOString()],
      );
      database.run("DELETE FROM admin_idempotency WHERE created_at < ?", [
        new Date(Date.now() - 7 * 86_400_000).toISOString(),
      ]);
    });
  }
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
