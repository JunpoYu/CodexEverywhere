import { randomUUID } from "node:crypto";

import type { HostStateStore } from "./state-store.js";

export type QueueItem = {
  id: string;
  workspacePath: string;
  threadId: string;
  turnPayload: Record<string, unknown>;
  status: "pending" | "running" | "paused" | "done";
  createdAt: string;
  updatedAt: string;
};

export type SteerQueueClaim = {
  item: QueueItem;
  previousStatus: "pending" | "paused";
};

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
      database.run(
        "INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          item.id,
          item.workspacePath,
          JSON.stringify({
            threadId: item.threadId,
            turnPayload: item.turnPayload,
          }),
          item.status,
          item.createdAt,
          item.updatedAt,
        ],
      );
      return item;
    });
  }

  list(): Promise<QueueItem[]> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT * FROM queue_items WHERE status != 'done' ORDER BY created_at, id",
      );
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
        "SELECT * FROM queue_items WHERE id = ?",
      );
      try {
        statement.bind([id]);
        return statement.step() ? parseRow(statement.getAsObject()) : undefined;
      } finally {
        statement.free();
      }
    });
  }

  remove(id: string): Promise<boolean> {
    return this.#state.transaction((database) => {
      database.run(
        "DELETE FROM queue_items WHERE id = ? AND status IN ('pending', 'paused')",
        [id],
      );
      return database.getRowsModified() > 0;
    });
  }

  claimNext(threadId: string): Promise<QueueItem | undefined> {
    return this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT * FROM queue_items WHERE status = 'pending' ORDER BY created_at, id",
      );
      let item: QueueItem | undefined;
      try {
        while (statement.step()) {
          const candidate = parseRow(statement.getAsObject());
          if (candidate.threadId === threadId) {
            item = candidate;
            break;
          }
        }
      } finally {
        statement.free();
      }
      if (!item) return undefined;
      item.status = "running";
      item.updatedAt = new Date().toISOString();
      database.run(
        "UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ?",
        [item.status, item.updatedAt, item.id],
      );
      return item;
    });
  }

  claimForSteer(id: string): Promise<SteerQueueClaim | undefined> {
    return this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT * FROM queue_items WHERE id = ? AND status IN ('pending', 'paused')",
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
      const previousStatus = item.status;
      item.status = "running";
      item.updatedAt = new Date().toISOString();
      database.run(
        "UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
        [item.status, item.updatedAt, item.id, previousStatus],
      );
      if (database.getRowsModified() === 0) return undefined;
      return { item, previousStatus };
    });
  }

  restoreSteerClaim(
    id: string,
    status: SteerQueueClaim["previousStatus"],
  ): Promise<void> {
    return this.#state.transaction((database) => {
      database.run(
        "UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ? AND status = 'running'",
        [status, new Date().toISOString(), id],
      );
    });
  }

  pausePending(threadId: string): Promise<QueueItem[]> {
    return this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT * FROM queue_items WHERE status = 'pending' ORDER BY created_at, id",
      );
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
          "UPDATE queue_items SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'pending'",
          [now, item.id],
        );
        item.status = "paused";
        item.updatedAt = now;
      }
      return items;
    });
  }

  pauseInterruptedClaims(): Promise<number> {
    return this.#state.transaction((database) => {
      database.run(
        "UPDATE queue_items SET status = 'paused', updated_at = ? WHERE status = 'running'",
        [new Date().toISOString()],
      );
      return database.getRowsModified();
    });
  }

  finish(id: string): Promise<void> {
    return this.#setStatus(id, "done");
  }

  pause(id: string): Promise<void> {
    return this.#setStatus(id, "paused");
  }

  #setStatus(id: string, status: QueueItem["status"]): Promise<void> {
    return this.#state.transaction((database) => {
      database.run(
        "UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ?",
        [status, new Date().toISOString(), id],
      );
    });
  }
}

function parseRow(row: Record<string, unknown>): QueueItem {
  const request = JSON.parse(String(row.request_json)) as {
    threadId: string;
    turnPayload: Record<string, unknown>;
  };
  const status = String(row.status);
  if (!isQueueStatus(status))
    throw new Error("Invalid queue status in host database");
  return {
    id: String(row.id),
    workspacePath: String(row.workspace_path),
    threadId: request.threadId,
    turnPayload: request.turnPayload,
    status,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function isQueueStatus(value: string): value is QueueItem["status"] {
  return (
    value === "pending" ||
    value === "running" ||
    value === "paused" ||
    value === "done"
  );
}
