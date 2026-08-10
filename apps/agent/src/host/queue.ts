import { randomUUID } from "node:crypto";

import type { Database } from "sql.js";

import type { HostStateStore } from "./state-store.js";

export type QueueItem = {
  id: string;
  workspacePath: string;
  threadId: string;
  turnPayload: Record<string, unknown>;
  status:
    "pending" | "running" | "paused" | "delivering" | "indeterminate" | "done";
  createdAt: string;
  updatedAt: string;
};

export type QueueConsumptionOperation = "turn/start" | "turn/steer";

export type QueueConsumptionIdentity = {
  queueItemId: string;
  operation: QueueConsumptionOperation;
  threadId: string;
  clientUserMessageId: string;
};

export type QueueConsumptionRepairResult =
  "missing" | "indeterminate" | "settled";

export type QueueMissingConsumptionRepairResult =
  "paused" | "claimed" | "settled";

export type SteerQueueClaim = {
  item: QueueItem;
  previousStatus: "pending" | "paused";
};

const QUEUE_ROW_SELECT = `
  SELECT
    queue_items.*,
    queue_item_states.status AS logical_status,
    queue_item_states.updated_at AS logical_updated_at,
    queue_consumption_claims.queue_item_id AS consumption_claim_id,
    queue_consumption_claims.operation AS consumption_operation,
    queue_consumption_claims.outcome AS consumption_outcome
  FROM queue_items
  LEFT JOIN queue_item_states
    ON queue_item_states.queue_item_id = queue_items.id
  LEFT JOIN queue_consumption_claims
    ON queue_consumption_claims.queue_item_id = queue_items.id
`;

export class QueueRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  add(input: {
    workspacePath: string;
    threadId: string;
    turnPayload: Record<string, unknown>;
  }): Promise<QueueItem> {
    const now = new Date().toISOString();
    const item: QueueItem = {
      id: randomUUID(),
      ...input,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    return this.#state.transaction((database) => {
      // Physical `done` is a rollback barrier. Old Agents ignore the additive
      // state table and therefore cannot dispatch, Steer, pause, or remove a
      // Queue item created by this version.
      database.run(
        "INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?)",
        [
          item.id,
          item.workspacePath,
          JSON.stringify({
            threadId: item.threadId,
            turnPayload: item.turnPayload,
          }),
          item.createdAt,
          item.updatedAt,
        ],
      );
      database.run(
        "INSERT INTO queue_item_states (queue_item_id, status, updated_at) VALUES (?, 'pending', ?)",
        [item.id, item.updatedAt],
      );
      return item;
    });
  }

  list(): Promise<QueueItem[]> {
    return this.#state.read((database) => {
      const statement = database.prepare(`${QUEUE_ROW_SELECT}
        WHERE
          (queue_consumption_claims.queue_item_id IS NOT NULL AND
            (queue_consumption_claims.outcome IS NULL OR
             queue_consumption_claims.outcome NOT IN ('completed', 'abandoned')))
          OR
          (queue_consumption_claims.queue_item_id IS NULL AND
            queue_items.status = 'done' AND
            queue_item_states.status IN ('pending', 'running', 'paused'))
        ORDER BY queue_items.created_at, queue_items.id
      `);
      const items: QueueItem[] = [];
      try {
        while (statement.step()) items.push(parseRow(statement.getAsObject()));
      } finally {
        statement.free();
      }
      return items;
    });
  }

  get(id: string): Promise<QueueItem | undefined> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        `${QUEUE_ROW_SELECT} WHERE queue_items.id = ?`,
      );
      try {
        statement.bind([id]);
        return statement.step() ? parseRow(statement.getAsObject()) : undefined;
      } finally {
        statement.free();
      }
    });
  }

  remove(
    id: string,
    options: { acknowledgeIndeterminate?: boolean } = {},
  ): Promise<boolean> {
    return this.#state.transaction((database) => {
      const now = new Date().toISOString();
      if (options.acknowledgeIndeterminate) {
        database.run(
          "UPDATE queue_consumption_claims SET outcome = 'abandoned', completed_at = ? WHERE queue_item_id = ? AND (outcome = 'indeterminate' OR (outcome IS NULL AND operation NOT IN ('turn/start', 'turn/steer')) OR (outcome IS NOT NULL AND outcome NOT IN ('completed', 'abandoned'))) AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_consumption_claims.queue_item_id AND queue_items.status = 'done')",
          [now, id],
        );
        if (database.getRowsModified() !== 1) return false;
        database.run("DELETE FROM queue_item_states WHERE queue_item_id = ?", [
          id,
        ]);
        this.#deletePhysicalItem(database, id);
        return true;
      }

      database.run(
        "DELETE FROM queue_item_states WHERE queue_item_id = ? AND status IN ('pending', 'paused') AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
        [id],
      );
      if (database.getRowsModified() !== 1) return false;
      this.#deletePhysicalItem(database, id);
      return true;
    });
  }

  beginConsumption(
    item: QueueItem,
    operation: QueueConsumptionOperation,
  ): Promise<{ claimed: boolean; identity: QueueConsumptionIdentity }> {
    const identity = queueConsumptionIdentity(item, operation);
    return this.#state.transaction((database) => {
      const itemStatement = database.prepare(
        `${QUEUE_ROW_SELECT} WHERE queue_items.id = ? AND queue_items.status = 'done'`,
      );
      let current: QueueItem | undefined;
      try {
        itemStatement.bind([item.id]);
        if (itemStatement.step())
          current = parseRow(itemStatement.getAsObject());
      } finally {
        itemStatement.free();
      }
      if (!current || current.status !== "running") {
        throw new Error("Queued message is not reserved for consumption");
      }
      const currentIdentity = queueConsumptionIdentity(current, operation);
      if (
        currentIdentity.threadId !== identity.threadId ||
        currentIdentity.clientUserMessageId !== identity.clientUserMessageId
      ) {
        throw new Error("Queued message identity changed before consumption");
      }

      const now = new Date().toISOString();
      database.run(
        "INSERT INTO queue_consumption_claims (queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at) SELECT ?, ?, ?, ?, NULL, NULL, ?, NULL WHERE EXISTS (SELECT 1 FROM queue_item_states JOIN queue_items ON queue_items.id = queue_item_states.queue_item_id WHERE queue_item_states.queue_item_id = ? AND queue_item_states.status = 'running' AND queue_items.status = 'done')",
        [
          identity.queueItemId,
          identity.operation,
          identity.threadId,
          identity.clientUserMessageId,
          now,
          identity.queueItemId,
        ],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error(
          "Queued message already has a durable consumption claim",
        );
      }
      database.run(
        "DELETE FROM queue_item_states WHERE queue_item_id = ? AND status = 'running'",
        [identity.queueItemId],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("Queued message reservation changed before delivery");
      }
      database.run(
        "UPDATE queue_items SET status = 'done', updated_at = ? WHERE id = ?",
        [now, identity.queueItemId],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("Queue item disappeared before delivery");
      }
      return { claimed: true, identity };
    });
  }

  completeConsumption(
    identity: QueueConsumptionIdentity,
    turnId: string,
  ): Promise<void> {
    if (turnId === "") throw new Error("Queue consumption returned no turn ID");
    return this.#state.transaction((database) => {
      const now = new Date().toISOString();
      database.run(
        "UPDATE queue_consumption_claims SET outcome = 'completed', turn_id = ?, completed_at = ? WHERE queue_item_id = ? AND operation = ? AND thread_id = ? AND client_user_message_id = ? AND outcome IS NULL",
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
        throw new Error("Queue consumption claim changed before completion");
      }
      database.run(
        "UPDATE queue_items SET status = 'done', updated_at = ? WHERE id = ?",
        [now, identity.queueItemId],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("Queue item disappeared before claim completion");
      }
    });
  }

  markConsumptionIndeterminate(
    item: QueueItem,
    operation: QueueConsumptionOperation,
  ): Promise<void> {
    return this.repairConsumptionIndeterminate(
      queueConsumptionIdentity(item, operation),
    ).then(() => undefined);
  }

  /**
   * Repairs only an already-published consumption claim. A missing claim is
   * deliberately left missing: beginConsumption may have failed before its
   * transaction was published, in which case manufacturing a tombstone would
   * turn a local reservation failure into a false external outcome.
   */
  repairConsumptionIndeterminate(
    identity: QueueConsumptionIdentity,
  ): Promise<QueueConsumptionRepairResult> {
    return this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT outcome FROM queue_consumption_claims WHERE queue_item_id = ?",
      );
      let outcome: unknown;
      try {
        statement.bind([identity.queueItemId]);
        if (!statement.step()) return "missing";
        outcome = statement.getAsObject().outcome;
      } finally {
        statement.free();
      }
      if (outcome === "completed" || outcome === "abandoned") {
        return "settled";
      }

      const now = new Date().toISOString();
      database.run(
        "UPDATE queue_consumption_claims SET outcome = 'indeterminate', completed_at = ? WHERE queue_item_id = ? AND (outcome IS NULL OR outcome NOT IN ('completed', 'abandoned'))",
        [now, identity.queueItemId],
      );
      database.run("DELETE FROM queue_item_states WHERE queue_item_id = ?", [
        identity.queueItemId,
      ]);
      database.run(
        "UPDATE queue_items SET status = 'done', updated_at = ? WHERE id = ?",
        [now, identity.queueItemId],
      );
      return "indeterminate";
    });
  }

  /** Creates a minimal tombstone only after the caller knows that the claim
   * transaction returned successfully. This is the fail-closed recovery for
   * an externally crossed boundary whose claim was later found missing. */
  ensureConsumptionIndeterminate(
    identity: QueueConsumptionIdentity,
  ): Promise<Exclude<QueueConsumptionRepairResult, "missing">> {
    return this.#state.transaction((database) => {
      const now = new Date().toISOString();
      database.run(
        "INSERT OR IGNORE INTO queue_consumption_claims (queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at) VALUES (?, ?, ?, ?, 'indeterminate', NULL, ?, ?)",
        [
          identity.queueItemId,
          identity.operation,
          identity.threadId,
          identity.clientUserMessageId,
          now,
          now,
        ],
      );
      const statement = database.prepare(
        "SELECT outcome FROM queue_consumption_claims WHERE queue_item_id = ?",
      );
      let outcome: unknown;
      try {
        statement.bind([identity.queueItemId]);
        if (!statement.step()) {
          throw new Error("Failed to create queue consumption tombstone");
        }
        outcome = statement.getAsObject().outcome;
      } finally {
        statement.free();
      }
      if (outcome === "completed" || outcome === "abandoned") {
        return "settled";
      }
      database.run(
        "UPDATE queue_consumption_claims SET outcome = 'indeterminate', completed_at = ? WHERE queue_item_id = ? AND (outcome IS NULL OR outcome NOT IN ('completed', 'abandoned'))",
        [now, identity.queueItemId],
      );
      database.run("DELETE FROM queue_item_states WHERE queue_item_id = ?", [
        identity.queueItemId,
      ]);
      database.run(
        "UPDATE queue_items SET status = 'done', updated_at = ? WHERE id = ?",
        [now, identity.queueItemId],
      );
      return "indeterminate";
    });
  }

  pauseMissingConsumptionReservation(
    identity: QueueConsumptionIdentity,
  ): Promise<QueueMissingConsumptionRepairResult> {
    return this.#state.transaction((database) => {
      const claim = database.exec(
        "SELECT 1 FROM queue_consumption_claims WHERE queue_item_id = ? LIMIT 1",
        [identity.queueItemId],
      )[0]?.values[0];
      if (claim) return "claimed";
      database.run(
        "UPDATE queue_item_states SET status = 'paused', updated_at = ? WHERE queue_item_id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
        [new Date().toISOString(), identity.queueItemId],
      );
      return database.getRowsModified() === 1 ? "paused" : "settled";
    });
  }

  async claimNext(threadId: string): Promise<QueueItem | undefined> {
    let reservedId: string | undefined;
    try {
      return await this.#state.transaction((database) => {
        if (hasUnresolvedConsumption(database, threadId)) return undefined;
        const item = earliestUnconsumedQueueItem(database, threadId);
        if (item && item.status !== "pending") return undefined;
        if (!item) return undefined;
        item.status = "running";
        item.updatedAt = new Date().toISOString();
        database.run(
          "UPDATE queue_item_states SET status = 'running', updated_at = ? WHERE queue_item_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
          [item.updatedAt, item.id],
        );
        if (database.getRowsModified() !== 1) return undefined;
        reservedId = item.id;
        return item;
      });
    } catch (error) {
      if (reservedId) {
        try {
          await this.#restoreUnconsumedReservation(reservedId, "pending");
        } catch {
          // A second storage failure leaves logical `running` fail-closed;
          // startup pauses it once storage becomes writable again.
        }
      }
      throw error;
    }
  }

  async claimForSteer(id: string): Promise<SteerQueueClaim | undefined> {
    let reservation:
      | { id: string; previousStatus: SteerQueueClaim["previousStatus"] }
      | undefined;
    try {
      return await this.#state.transaction((database) => {
        const statement = database.prepare(
          `${QUEUE_ROW_SELECT}
           WHERE queue_items.id = ?
             AND queue_items.status = 'done'
             AND queue_consumption_claims.queue_item_id IS NULL
             AND queue_item_states.status IN ('pending', 'paused')`,
        );
        let item: QueueItem | undefined;
        try {
          statement.bind([id]);
          if (statement.step()) item = parseRow(statement.getAsObject());
        } finally {
          statement.free();
        }
        if (!item || (item.status !== "pending" && item.status !== "paused")) {
          return undefined;
        }
        if (hasUnresolvedConsumption(database, item.threadId)) return undefined;
        if (
          earliestUnconsumedQueueItem(database, item.threadId)?.id !== item.id
        ) {
          return undefined;
        }
        const previousStatus = item.status;
        item.status = "running";
        item.updatedAt = new Date().toISOString();
        database.run(
          "UPDATE queue_item_states SET status = 'running', updated_at = ? WHERE queue_item_id = ? AND status = ? AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
          [item.updatedAt, item.id, previousStatus],
        );
        if (database.getRowsModified() !== 1) return undefined;
        reservation = { id: item.id, previousStatus };
        return { item, previousStatus };
      });
    } catch (error) {
      if (reservation) {
        try {
          await this.#restoreUnconsumedReservation(
            reservation.id,
            reservation.previousStatus,
          );
        } catch {
          // Preserve the original error; logical `running` remains fail-closed
          // and startup will pause it after storage recovers.
        }
      }
      throw error;
    }
  }

  restoreSteerClaim(
    id: string,
    status: SteerQueueClaim["previousStatus"],
  ): Promise<void> {
    return this.#restoreUnconsumedReservation(id, status);
  }

  pausePending(threadId: string): Promise<QueueItem[]> {
    return this.#state.transaction((database) => {
      const statement = database.prepare(`${QUEUE_ROW_SELECT}
        WHERE queue_consumption_claims.queue_item_id IS NULL
          AND queue_items.status = 'done'
          AND queue_item_states.status = 'pending'
        ORDER BY queue_items.created_at, queue_items.id
      `);
      const items: QueueItem[] = [];
      try {
        while (statement.step()) {
          const item = parseRow(statement.getAsObject());
          if (item.threadId === threadId) items.push(item);
        }
      } finally {
        statement.free();
      }
      const now = new Date().toISOString();
      for (const item of items) {
        database.run(
          "UPDATE queue_item_states SET status = 'paused', updated_at = ? WHERE queue_item_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
          [now, item.id],
        );
        if (database.getRowsModified() === 1) {
          item.status = "paused";
          item.updatedAt = now;
        }
      }
      return items;
    });
  }

  pauseInterruptedClaims(): Promise<number> {
    return this.#state.transaction((database) => {
      const now = new Date().toISOString();
      database.run(
        "UPDATE queue_consumption_claims SET outcome = 'indeterminate', completed_at = ? WHERE outcome IS NULL OR outcome NOT IN ('completed', 'abandoned')",
        [now],
      );
      const indeterminate = database.getRowsModified();
      database.run(
        "DELETE FROM queue_item_states WHERE EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
      );
      database.run(
        "UPDATE queue_items SET status = 'done', updated_at = ? WHERE EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_items.id) AND status IS NOT 'done'",
        [now],
      );
      database.run(
        "UPDATE queue_item_states SET status = 'paused', updated_at = ? WHERE status = 'running' AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
        [now],
      );
      return indeterminate + database.getRowsModified();
    });
  }

  pause(id: string): Promise<void> {
    return this.#restoreUnconsumedReservation(id, "paused");
  }

  #restoreUnconsumedReservation(
    id: string,
    status: SteerQueueClaim["previousStatus"],
  ): Promise<void> {
    return this.#state.transaction((database) => {
      database.run(
        "UPDATE queue_item_states SET status = ?, updated_at = ? WHERE queue_item_id = ? AND status = 'running' AND EXISTS (SELECT 1 FROM queue_items WHERE queue_items.id = queue_item_states.queue_item_id AND queue_items.status = 'done') AND NOT EXISTS (SELECT 1 FROM queue_consumption_claims WHERE queue_consumption_claims.queue_item_id = queue_item_states.queue_item_id)",
        [status, new Date().toISOString(), id],
      );
    });
  }

  #deletePhysicalItem(database: Database, id: string): void {
    database.run("DELETE FROM queue_items WHERE id = ? AND status = 'done'", [
      id,
    ]);
    if (database.getRowsModified() !== 1) {
      throw new Error("Queue item changed before removal");
    }
  }
}

function parseRow(row: Record<string, unknown>): QueueItem {
  const request = JSON.parse(String(row.request_json)) as {
    threadId: string;
    turnPayload: Record<string, unknown>;
  };
  const hasConsumptionClaim =
    typeof row.consumption_claim_id === "string" &&
    row.consumption_claim_id !== "";
  const logicalStatus = String(row.logical_status ?? "");
  const status = hasConsumptionClaim
    ? (row.consumption_outcome === null ||
        row.consumption_outcome === undefined) &&
      isQueueConsumptionOperation(row.consumption_operation)
      ? "delivering"
      : row.consumption_outcome === "completed" ||
          row.consumption_outcome === "abandoned"
        ? "done"
        : "indeterminate"
    : row.status === "done" && isLogicalQueueStatus(logicalStatus)
      ? logicalStatus
      : "done";
  return {
    id: String(row.id),
    workspacePath: String(row.workspace_path),
    threadId: request.threadId,
    turnPayload: request.turnPayload,
    status,
    createdAt: String(row.created_at),
    updatedAt:
      typeof row.logical_updated_at === "string"
        ? row.logical_updated_at
        : String(row.updated_at),
  };
}

function isLogicalQueueStatus(
  value: string,
): value is "pending" | "running" | "paused" {
  return value === "pending" || value === "running" || value === "paused";
}

function isQueueConsumptionOperation(
  value: unknown,
): value is QueueConsumptionOperation {
  return value === "turn/start" || value === "turn/steer";
}

export function queueConsumptionIdentity(
  item: QueueItem,
  operation: QueueConsumptionOperation,
): QueueConsumptionIdentity {
  const clientUserMessageId = item.turnPayload.clientUserMessageId;
  return {
    queueItemId: item.id,
    operation,
    threadId: item.threadId,
    clientUserMessageId:
      typeof clientUserMessageId === "string" && clientUserMessageId !== ""
        ? clientUserMessageId
        : `queue:${item.id}`,
  };
}

function hasUnresolvedConsumption(
  database: Database,
  threadId: string,
): boolean {
  const statement = database.prepare(
    "SELECT 1 FROM queue_consumption_claims JOIN queue_items ON queue_items.id = queue_consumption_claims.queue_item_id WHERE queue_consumption_claims.thread_id = ? AND (queue_consumption_claims.outcome IS NULL OR queue_consumption_claims.outcome NOT IN ('completed', 'abandoned')) LIMIT 1",
  );
  try {
    statement.bind([threadId]);
    return statement.step();
  } finally {
    statement.free();
  }
}

function earliestUnconsumedQueueItem(
  database: Database,
  threadId: string,
): QueueItem | undefined {
  const statement = database.prepare(`${QUEUE_ROW_SELECT}
    WHERE queue_consumption_claims.queue_item_id IS NULL
      AND queue_items.status = 'done'
      AND queue_item_states.status IN ('pending', 'running', 'paused')
    ORDER BY queue_items.created_at, queue_items.id
  `);
  try {
    while (statement.step()) {
      const candidate = parseRow(statement.getAsObject());
      if (candidate.threadId === threadId) return candidate;
    }
    return undefined;
  } finally {
    statement.free();
  }
}
