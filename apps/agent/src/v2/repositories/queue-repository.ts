import { randomUUID } from "node:crypto";

import type { Database } from "sql.js";

import { nullableText, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export type QueueDeliveryOperation = "turn/start" | "turn/steer";
export type QueueRecordStatus =
  "pending" | "paused" | "delivering" | "completed" | "indeterminate";

export interface QueueRecord {
  readonly id: string;
  readonly workspacePath: string;
  readonly threadId: string;
  readonly text: string;
  readonly status: QueueRecordStatus;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly indeterminateReason?: string;
}

export interface QueueDeliveryIdentity {
  readonly queueItemId: string;
  readonly operation: QueueDeliveryOperation;
  readonly threadId: string;
  readonly clientUserMessageId: string;
}

export interface ClaimedQueueDelivery {
  readonly item: QueueRecord;
  readonly identity: QueueDeliveryIdentity;
}

export class QueueStateConflictError extends Error {
  constructor(
    readonly itemId: string,
    message: string,
  ) {
    super(message);
    this.name = "QueueStateConflictError";
  }
}

/** SQLite queue state machine. Every external delivery starts after claim(). */
export class QueueRepository {
  readonly #file: SqliteStateFile;

  constructor(file: SqliteStateFile) {
    this.#file = file;
  }

  add(input: {
    readonly workspacePath: string;
    readonly threadId: string;
    readonly text: string;
    readonly id?: string;
    readonly now?: string;
  }): Promise<QueueRecord> {
    const now = input.now ?? new Date().toISOString();
    const item: QueueRecord = {
      id: input.id ?? randomUUID(),
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      text: input.text,
      status: "pending",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    return this.#file.transaction((database) => {
      database.run(
        "INSERT INTO queue_items (id, workspace_path, thread_id, request_json, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)",
        [
          item.id,
          item.workspacePath,
          item.threadId,
          requestJson(item.text),
          item.createdAt,
          item.updatedAt,
        ],
      );
      return item;
    });
  }

  list(
    options: {
      readonly threadId?: string;
      readonly includeCompleted?: boolean;
    } = {},
  ): Promise<QueueRecord[]> {
    return this.#file.read((database) => {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (!options.includeCompleted) clauses.push("q.status <> 'completed'");
      if (options.threadId !== undefined) {
        clauses.push("q.thread_id = ?");
        parameters.push(options.threadId);
      }
      const where =
        clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
      return queryRows(
        database,
        `${QUEUE_SELECT} ${where} ORDER BY q.created_at, q.id`,
        parameters,
      ).map(parseQueueRow);
    });
  }

  get(id: string): Promise<QueueRecord | undefined> {
    return this.#file.read((database) => readQueue(database, id));
  }

  nextPending(): Promise<QueueRecord | undefined> {
    return this.#file.read((database) => {
      const row = queryRows(
        database,
        `${QUEUE_SELECT} WHERE q.status = 'pending' ORDER BY q.created_at, q.id LIMIT 1`,
      )[0];
      return row === undefined ? undefined : parseQueueRow(row);
    });
  }

  remove(id: string): Promise<boolean> {
    return this.#file.transaction((database) => {
      database.run(
        "DELETE FROM queue_items WHERE id = ? AND status IN ('pending', 'paused') AND NOT EXISTS (SELECT 1 FROM queue_delivery_claims WHERE queue_item_id = ?)",
        [id, id],
      );
      return database.getRowsModified() === 1;
    });
  }

  pause(id: string): Promise<QueueRecord> {
    return this.#transitionWithoutClaim(id, "pending", "paused");
  }

  resume(id: string): Promise<QueueRecord> {
    return this.#transitionWithoutClaim(id, "paused", "pending");
  }

  claim(input: {
    readonly itemId: string;
    readonly expectedRevision: number;
    readonly operation: QueueDeliveryOperation;
    readonly replacementText?: string;
    readonly clientUserMessageId?: string;
    readonly now?: string;
  }): Promise<ClaimedQueueDelivery> {
    const now = input.now ?? new Date().toISOString();
    const clientUserMessageId = input.clientUserMessageId ?? randomUUID();
    return this.#file.transaction((database) => {
      const current = readQueue(database, input.itemId);
      if (
        current === undefined ||
        current.revision !== input.expectedRevision ||
        (input.operation === "turn/start"
          ? current.status !== "pending"
          : current.status !== "pending" && current.status !== "paused")
      ) {
        throw new QueueStateConflictError(
          input.itemId,
          "Queue item is no longer eligible for delivery",
        );
      }
      const text = input.replacementText ?? current.text;
      database.run(
        "UPDATE queue_items SET request_json = ?, status = 'delivering', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = ?",
        [
          requestJson(text),
          now,
          input.itemId,
          input.expectedRevision,
          current.status,
        ],
      );
      if (database.getRowsModified() !== 1) {
        throw new QueueStateConflictError(
          input.itemId,
          "Queue item changed while claiming delivery",
        );
      }
      database.run(
        "INSERT INTO queue_delivery_claims (queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)",
        [
          current.id,
          input.operation,
          current.threadId,
          clientUserMessageId,
          now,
        ],
      );
      const claimed = readQueue(database, current.id);
      if (claimed === undefined)
        throw new Error("Claimed queue item disappeared");
      return {
        item: claimed,
        identity: {
          queueItemId: current.id,
          operation: input.operation,
          threadId: current.threadId,
          clientUserMessageId,
        },
      };
    });
  }

  complete(
    identity: QueueDeliveryIdentity,
    turnId: string,
    now = new Date().toISOString(),
  ): Promise<QueueRecord> {
    if (turnId.length === 0)
      throw new Error("Queue delivery returned no turn ID");
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE queue_delivery_claims SET outcome = 'completed', turn_id = ?, completed_at = ? WHERE queue_item_id = ? AND operation = ? AND thread_id = ? AND client_user_message_id = ? AND outcome IS NULL",
        [
          turnId,
          now,
          identity.queueItemId,
          identity.operation,
          identity.threadId,
          identity.clientUserMessageId,
        ],
      );
      if (database.getRowsModified() !== 1) {
        const settled = readClaim(database, identity.queueItemId);
        if (
          settled?.outcome === "completed" &&
          settled.turnId === turnId &&
          claimMatches(settled, identity)
        ) {
          const current = readQueue(database, identity.queueItemId);
          if (current !== undefined && current.status === "completed") {
            return current;
          }
        }
        throw new QueueStateConflictError(
          identity.queueItemId,
          "Queue delivery claim changed before completion",
        );
      }
      updateQueueStatus(database, identity.queueItemId, "completed", now);
      return requiredQueue(database, identity.queueItemId);
    });
  }

  markIndeterminate(
    identity: QueueDeliveryIdentity,
    now = new Date().toISOString(),
  ): Promise<QueueRecord> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE queue_delivery_claims SET outcome = 'indeterminate', completed_at = ? WHERE queue_item_id = ? AND operation = ? AND thread_id = ? AND client_user_message_id = ? AND outcome IS NULL",
        [
          now,
          identity.queueItemId,
          identity.operation,
          identity.threadId,
          identity.clientUserMessageId,
        ],
      );
      const claim = readClaim(database, identity.queueItemId);
      if (
        claim === undefined ||
        !claimMatches(claim, identity) ||
        (claim.outcome !== "indeterminate" && claim.outcome !== "completed")
      ) {
        throw new QueueStateConflictError(
          identity.queueItemId,
          "Queue delivery claim cannot be marked indeterminate",
        );
      }
      if (claim.outcome === "completed") {
        return requiredQueue(database, identity.queueItemId);
      }
      updateQueueStatus(database, identity.queueItemId, "indeterminate", now);
      return requiredQueue(database, identity.queueItemId);
    });
  }

  recoverDelivering(now = new Date().toISOString()): Promise<number> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE queue_delivery_claims SET outcome = 'indeterminate', completed_at = ? WHERE outcome IS NULL AND EXISTS (SELECT 1 FROM queue_items q WHERE q.id = queue_delivery_claims.queue_item_id AND q.status = 'delivering')",
        [now],
      );
      database.run(
        "UPDATE queue_items SET status = 'indeterminate', revision = revision + 1, updated_at = ? WHERE status = 'delivering'",
        [now],
      );
      return database.getRowsModified();
    });
  }

  acknowledgeIndeterminate(
    id: string,
    disposition: "retry" | "dismiss",
    now = new Date().toISOString(),
  ): Promise<QueueRecord> {
    return this.#file.transaction((database) => {
      const current = readQueue(database, id);
      const claim = readClaim(database, id);
      if (
        current?.status !== "indeterminate" ||
        (claim !== undefined && claim.outcome !== "indeterminate")
      ) {
        throw new QueueStateConflictError(
          id,
          "Queue item does not have an indeterminate outcome",
        );
      }
      if (disposition === "retry") {
        database.run(
          "DELETE FROM queue_delivery_claims WHERE queue_item_id = ?",
          [id],
        );
        updateQueueStatus(database, id, "pending", now);
      } else {
        if (claim !== undefined) {
          database.run(
            "UPDATE queue_delivery_claims SET outcome = 'abandoned', completed_at = ? WHERE queue_item_id = ? AND outcome = 'indeterminate'",
            [now, id],
          );
        }
        updateQueueStatus(database, id, "completed", now);
      }
      database.run(
        "INSERT INTO audit_events (id, kind, subject_id, created_at) VALUES (?, ?, ?, ?)",
        [randomUUID(), `queue/indeterminate/${disposition}`, id, now],
      );
      return requiredQueue(database, id);
    });
  }

  #transitionWithoutClaim(
    id: string,
    from: "pending" | "paused",
    to: "pending" | "paused",
  ): Promise<QueueRecord> {
    return this.#file.transaction((database) => {
      const now = new Date().toISOString();
      database.run(
        "UPDATE queue_items SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status = ? AND NOT EXISTS (SELECT 1 FROM queue_delivery_claims WHERE queue_item_id = ?)",
        [to, now, id, from, id],
      );
      if (database.getRowsModified() !== 1) {
        throw new QueueStateConflictError(id, "Queue item state changed");
      }
      return requiredQueue(database, id);
    });
  }
}

const QUEUE_SELECT = `
  SELECT q.id, q.workspace_path, q.thread_id, q.request_json, q.status,
         q.revision, q.created_at, q.updated_at, c.outcome
  FROM queue_items q
  LEFT JOIN queue_delivery_claims c ON c.queue_item_id = q.id
`;

interface ClaimRow {
  readonly operation: string;
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly outcome?: string;
  readonly turnId?: string;
}

function readQueue(database: Database, id: string): QueueRecord | undefined {
  const row = queryRows(database, `${QUEUE_SELECT} WHERE q.id = ?`, [id])[0];
  return row === undefined ? undefined : parseQueueRow(row);
}

function requiredQueue(database: Database, id: string): QueueRecord {
  const item = readQueue(database, id);
  if (item === undefined) throw new Error("Queue item disappeared");
  return item;
}

function parseQueueRow(row: ReturnType<typeof queryRows>[number]): QueueRecord {
  const status = queueStatus(row.status);
  const outcome = nullableText(row.outcome, "queue claim outcome");
  return {
    id: text(row.id, "queue id"),
    workspacePath: text(row.workspace_path, "queue workspace path"),
    threadId: text(row.thread_id, "queue thread id"),
    text: parseRequestJson(text(row.request_json, "queue request")),
    status,
    revision: nonnegativeInteger(row.revision, "queue revision"),
    createdAt: text(row.created_at, "queue created_at"),
    updatedAt: text(row.updated_at, "queue updated_at"),
    ...(status === "indeterminate"
      ? {
          indeterminateReason:
            outcome === "indeterminate"
              ? "Delivery crossed the external boundary but its result is unknown"
              : "A delivering item was recovered without a complete claim",
        }
      : {}),
  };
}

function readClaim(database: Database, id: string): ClaimRow | undefined {
  const row = queryRows(
    database,
    "SELECT operation, thread_id, client_user_message_id, outcome, turn_id FROM queue_delivery_claims WHERE queue_item_id = ?",
    [id],
  )[0];
  if (row === undefined) return undefined;
  const outcome = nullableText(row.outcome, "queue claim outcome");
  const turnId = nullableText(row.turn_id, "queue claim turn id");
  return {
    operation: text(row.operation, "queue claim operation"),
    threadId: text(row.thread_id, "queue claim thread id"),
    clientUserMessageId: text(
      row.client_user_message_id,
      "queue claim client message id",
    ),
    ...(outcome === undefined ? {} : { outcome }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function claimMatches(row: ClaimRow, identity: QueueDeliveryIdentity): boolean {
  return (
    row.operation === identity.operation &&
    row.threadId === identity.threadId &&
    row.clientUserMessageId === identity.clientUserMessageId
  );
}

function updateQueueStatus(
  database: Database,
  id: string,
  status: QueueRecordStatus,
  now: string,
): void {
  database.run(
    "UPDATE queue_items SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
    [status, now, id],
  );
  if (database.getRowsModified() !== 1) {
    throw new Error("Queue item disappeared during transition");
  }
}

function requestJson(value: string): string {
  return JSON.stringify({ version: 1, text: value });
}

function parseRequestJson(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Queue request is invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== 1 ||
    typeof (parsed as Record<string, unknown>).text !== "string"
  ) {
    throw new Error("Queue request has an invalid shape");
  }
  return (parsed as { text: string }).text;
}

function queueStatus(value: unknown): QueueRecordStatus {
  if (
    value === "pending" ||
    value === "paused" ||
    value === "delivering" ||
    value === "completed" ||
    value === "indeterminate"
  ) {
    return value;
  }
  throw new Error("Invalid queue status");
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return Number(value);
}
