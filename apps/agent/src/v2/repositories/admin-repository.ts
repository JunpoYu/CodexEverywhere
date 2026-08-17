import { randomUUID } from "node:crypto";

import type { Database, SqlValue } from "sql.js";

import { integer, nullableText, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export type ManagedUserStatus =
  "enabled" | "disabled" | "removal_pending" | "removing" | "removed";

export interface ManagedUserRecord {
  readonly uid: number;
  readonly username: string;
  readonly home: string;
  readonly status: ManagedUserStatus;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly removeAfter?: string;
}

export interface AdminAuditRecord {
  readonly id: string;
  readonly requestId: string;
  readonly actor: string;
  readonly action: string;
  readonly targetUsername?: string;
  readonly result: "succeeded" | "failed";
  readonly createdAt: string;
}

export interface AdminAuditPage {
  readonly events: readonly AdminAuditRecord[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export class ManagedUserConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedUserConflictError";
  }
}

export class ManagedUserRevisionConflictError extends Error {
  constructor(readonly username: string) {
    super("Managed user revision changed");
    this.name = "ManagedUserRevisionConflictError";
  }
}

export class AdminAuditCursorError extends Error {
  constructor() {
    super("Administrator audit cursor is invalid");
    this.name = "AdminAuditCursorError";
  }
}

/** The only SQL boundary for the v0.4 administrator domain. */
export class AdminRepository {
  readonly #file: SqliteStateFile;

  constructor(file: SqliteStateFile) {
    this.#file = file;
  }

  get(username: string): Promise<ManagedUserRecord | undefined> {
    return this.#file.read((database) =>
      readUserByUsername(database, username),
    );
  }

  list(): Promise<ManagedUserRecord[]> {
    return this.#file.read((database) =>
      queryRows(
        database,
        "SELECT uid, username, home, status, registered_at, updated_at, revision, remove_after FROM managed_users ORDER BY username COLLATE NOCASE, uid",
      ).map(parseUser),
    );
  }

  counts(): Promise<{
    readonly managedUsers: number;
    readonly enabledUsers: number;
    readonly disabledUsers: number;
    readonly pendingRemovals: number;
  }> {
    return this.#file.read((database) => {
      const rows = queryRows(
        database,
        "SELECT status, COUNT(*) AS count FROM managed_users GROUP BY status",
      );
      const byStatus = new Map(
        rows.map((row) => [
          managedUserStatus(row.status),
          integer(row.count, "managed user count"),
        ]),
      );
      const count = (status: ManagedUserStatus): number =>
        byStatus.get(status) ?? 0;
      return {
        managedUsers: [...byStatus.values()].reduce(
          (total, value) => total + value,
          0,
        ),
        enabledUsers: count("enabled"),
        disabledUsers: count("disabled") + count("removed"),
        pendingRemovals: count("removal_pending") + count("removing"),
      };
    });
  }

  register(input: {
    readonly uid: number;
    readonly username: string;
    readonly home: string;
    readonly now?: string;
  }): Promise<ManagedUserRecord> {
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      const byUid = readUserByUid(database, input.uid);
      const byUsername = readUserByUsername(database, input.username);
      const existing = byUid ?? byUsername;
      if (existing !== undefined) {
        if (
          existing.uid !== input.uid ||
          existing.username !== input.username ||
          existing.home !== input.home ||
          (byUid !== undefined &&
            byUsername !== undefined &&
            byUid.uid !== byUsername.uid)
        ) {
          throw new ManagedUserConflictError(
            "Unix identity conflicts with an existing managed user",
          );
        }
        return existing;
      }
      database.run(
        "INSERT INTO managed_users (uid, username, home, status, registered_at, updated_at, revision, remove_after) VALUES (?, ?, ?, 'enabled', ?, ?, 1, NULL)",
        [input.uid, input.username, input.home, now, now],
      );
      return requiredUser(database, input.username);
    });
  }

  setStatus(input: {
    readonly username: string;
    readonly expectedRevision: number;
    readonly status: ManagedUserStatus;
    readonly removeAfter?: string;
    readonly now?: string;
  }): Promise<ManagedUserRecord> {
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      const current = requiredUser(database, input.username);
      if (current.revision !== input.expectedRevision) {
        throw new ManagedUserRevisionConflictError(input.username);
      }
      database.run(
        "UPDATE managed_users SET status = ?, remove_after = ?, updated_at = ?, revision = revision + 1 WHERE username = ? AND revision = ?",
        [
          input.status,
          input.removeAfter ?? null,
          now,
          input.username,
          input.expectedRevision,
        ],
      );
      if (database.getRowsModified() !== 1) {
        throw new ManagedUserRevisionConflictError(input.username);
      }
      return requiredUser(database, input.username);
    });
  }

  dueRemovals(now = new Date().toISOString()): Promise<ManagedUserRecord[]> {
    return this.#file.read((database) =>
      queryRows(
        database,
        "SELECT uid, username, home, status, registered_at, updated_at, revision, remove_after FROM managed_users WHERE status = 'removing' OR (status = 'removal_pending' AND remove_after <= ?) ORDER BY remove_after, username",
        [now],
      ).map(parseUser),
    );
  }

  appendAudit(input: {
    readonly requestId: string;
    readonly actor: string;
    readonly action: string;
    readonly targetUsername?: string;
    readonly result: "succeeded" | "failed";
    readonly now?: string;
    readonly id?: string;
  }): Promise<AdminAuditRecord> {
    const record: AdminAuditRecord = {
      id: input.id ?? randomUUID(),
      requestId: input.requestId,
      actor: input.actor,
      action: input.action,
      ...(input.targetUsername === undefined
        ? {}
        : { targetUsername: input.targetUsername }),
      result: input.result,
      createdAt: input.now ?? new Date().toISOString(),
    };
    return this.#file.transaction((database) => {
      database.run(
        "INSERT INTO admin_audit (id, request_id, actor, action, target_username, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          record.id,
          record.requestId,
          record.actor,
          record.action,
          record.targetUsername ?? null,
          record.result,
          record.createdAt,
        ],
      );
      return record;
    });
  }

  listAudit(input: {
    readonly username?: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<AdminAuditPage> {
    const boundary =
      input.cursor === undefined ? undefined : decodeAuditCursor(input.cursor);
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit)));
    return this.#file.read((database) => {
      const clauses: string[] = [];
      const parameters: Array<string | number> = [];
      if (input.username !== undefined) {
        clauses.push("target_username = ?");
        parameters.push(input.username);
      }
      if (boundary !== undefined) {
        clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
        parameters.push(boundary.createdAt, boundary.createdAt, boundary.id);
      }
      parameters.push(limit + 1);
      const rows = queryRows(
        database,
        `SELECT id, request_id, actor, action, target_username, result, created_at FROM admin_audit${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`} ORDER BY created_at DESC, id DESC LIMIT ?`,
        parameters,
      ).map(parseAudit);
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit);
      const last = events.at(-1);
      return {
        events,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeAuditCursor(last) }
          : {}),
        hasMore,
      };
    });
  }
}

function readUserByUsername(
  database: Database,
  username: string,
): ManagedUserRecord | undefined {
  const row = queryRows(
    database,
    "SELECT uid, username, home, status, registered_at, updated_at, revision, remove_after FROM managed_users WHERE username = ?",
    [username],
  )[0];
  return row === undefined ? undefined : parseUser(row);
}

function readUserByUid(
  database: Database,
  uid: number,
): ManagedUserRecord | undefined {
  const row = queryRows(
    database,
    "SELECT uid, username, home, status, registered_at, updated_at, revision, remove_after FROM managed_users WHERE uid = ?",
    [uid],
  )[0];
  return row === undefined ? undefined : parseUser(row);
}

function requiredUser(database: Database, username: string): ManagedUserRecord {
  const user = readUserByUsername(database, username);
  if (user === undefined) throw new Error("Managed user does not exist");
  return user;
}

function parseUser(
  row: ReturnType<typeof queryRows>[number],
): ManagedUserRecord {
  const removeAfter = nullableText(
    row.remove_after,
    "managed user remove_after",
  );
  return {
    uid: integer(row.uid, "managed user uid"),
    username: text(row.username, "managed username"),
    home: text(row.home, "managed user home"),
    status: managedUserStatus(row.status),
    registeredAt: text(row.registered_at, "managed user registered_at"),
    updatedAt: text(row.updated_at, "managed user updated_at"),
    revision: integer(row.revision, "managed user revision"),
    ...(removeAfter === undefined ? {} : { removeAfter }),
  };
}

function parseAudit(
  row: ReturnType<typeof queryRows>[number],
): AdminAuditRecord {
  const targetUsername = nullableText(
    row.target_username,
    "admin audit target_username",
  );
  const result = text(row.result, "admin audit result");
  if (result !== "succeeded" && result !== "failed") {
    throw new Error("Invalid administrator audit result");
  }
  return {
    id: text(row.id, "admin audit id"),
    requestId: text(row.request_id, "admin audit request_id"),
    actor: text(row.actor, "admin audit actor"),
    action: text(row.action, "admin audit action"),
    ...(targetUsername === undefined ? {} : { targetUsername }),
    result,
    createdAt: text(row.created_at, "admin audit created_at"),
  };
}

function managedUserStatus(value: SqlValue | undefined): ManagedUserStatus {
  const status = text(value, "managed user status");
  if (
    status !== "enabled" &&
    status !== "disabled" &&
    status !== "removal_pending" &&
    status !== "removing" &&
    status !== "removed"
  ) {
    throw new Error("Invalid managed user status");
  }
  return status;
}

function encodeAuditCursor(record: AdminAuditRecord): string {
  return Buffer.from(
    JSON.stringify({ version: 1, createdAt: record.createdAt, id: record.id }),
    "utf8",
  ).toString("base64url");
}

function decodeAuditCursor(value: string): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.version === 1 &&
      typeof decoded.createdAt === "string" &&
      Number.isFinite(Date.parse(decoded.createdAt)) &&
      typeof decoded.id === "string" &&
      decoded.id.length > 0
    ) {
      return { createdAt: decoded.createdAt, id: decoded.id };
    }
  } catch {
    // Fall through to a protocol-safe cursor error.
  }
  throw new AdminAuditCursorError();
}
