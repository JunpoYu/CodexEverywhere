import { createHash } from "node:crypto";
import type { Database } from "sql.js";
import { nullableText, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";
import type { SideChatStateRecord } from "./state-snapshot.js";

/** Stores only branch ownership and operation boundaries; never transcripts. */
export class SideChatRepository {
  constructor(private readonly file: SqliteStateFile) {}

  lock(parentThreadId: string, signal?: AbortSignal) {
    const key = createHash("sha256").update(parentThreadId).digest("hex");
    return this.file.acquireCoordinationLock(
      `side-${key}`,
      signal === undefined ? {} : { signal },
    );
  }

  read(parentThreadId: string): Promise<SideChatStateRecord | undefined> {
    return this.file.read((db) =>
      readSideChats(db).find((row) => row.parentThreadId === parentThreadId),
    );
  }

  forThread(threadId: string): Promise<SideChatStateRecord | undefined> {
    return this.file.read((db) =>
      readSideChats(db).find((row) => row.threadId === threadId),
    );
  }

  list(): Promise<SideChatStateRecord[]> {
    return this.file.read(readSideChats);
  }

  save(record: SideChatStateRecord): Promise<void> {
    return this.file.transaction((db) => writeSideChat(db, record));
  }

  remove(parentThreadId: string): Promise<void> {
    return this.file.transaction((db) => {
      db.run("DELETE FROM side_chats WHERE parent_thread_id = ?", [
        parentThreadId,
      ]);
    });
  }

  recover(): Promise<void> {
    return this.file.transaction((db) => {
      db.run(
        "UPDATE side_chats SET status = 'indeterminate' WHERE status IN ('creating', 'deleting')",
      );
    });
  }
}

export function readSideChats(db: Database): SideChatStateRecord[] {
  return queryRows(
    db,
    "SELECT * FROM side_chats ORDER BY created_at, parent_thread_id",
  ).map((row) => {
    const threadId = nullableText(row.thread_id, "side thread");
    const boundaryTurnId = nullableText(row.boundary_turn_id, "side boundary");
    const status = text(row.status, "side status");
    if (
      status !== "creating" &&
      status !== "ready" &&
      status !== "deleting" &&
      status !== "indeterminate"
    )
      throw new Error("Invalid side state");
    return {
      parentThreadId: text(row.parent_thread_id, "parent thread"),
      ...(threadId === undefined ? {} : { threadId }),
      ...(boundaryTurnId === undefined ? {} : { boundaryTurnId }),
      status,
      operationKey: text(row.operation_key, "side operation"),
      createdAt: text(row.created_at, "side created at"),
    };
  });
}

export function writeSideChat(db: Database, row: SideChatStateRecord): void {
  db.run(
    "INSERT INTO side_chats (parent_thread_id, thread_id, boundary_turn_id, status, operation_key, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(parent_thread_id) DO UPDATE SET thread_id=excluded.thread_id, boundary_turn_id=excluded.boundary_turn_id, status=excluded.status, operation_key=excluded.operation_key, created_at=excluded.created_at",
    [
      row.parentThreadId,
      row.threadId ?? null,
      row.boundaryTurnId ?? null,
      row.status,
      row.operationKey,
      row.createdAt,
    ],
  );
}
