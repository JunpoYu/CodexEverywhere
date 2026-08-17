import { randomUUID } from "node:crypto";

import type { Database } from "sql.js";

import { integer, nullableText, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export interface WorkspaceRecord {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly isDefault: boolean;
}

export interface WorkspaceAuthorizationSnapshot {
  readonly revision: number;
  readonly roots: readonly string[];
}

export class WorkspaceRevisionConflictError extends Error {
  constructor(readonly workspaceId: string) {
    super("Workspace revision changed");
    this.name = "WorkspaceRevisionConflictError";
  }
}

export class WorkspaceInUseError extends Error {
  constructor(readonly workspaceId: string) {
    super("Workspace has unfinished Queue items");
    this.name = "WorkspaceInUseError";
  }
}

export class WorkspaceRepository {
  readonly #file: SqliteStateFile;

  constructor(file: SqliteStateFile) {
    this.#file = file;
  }

  list(): Promise<WorkspaceRecord[]> {
    return this.#file.read(readWorkspaces);
  }

  authorizationSnapshot(): Promise<WorkspaceAuthorizationSnapshot> {
    return this.#file.read((database) => {
      const metadata = queryRows(
        database,
        "SELECT workspace_authorization_revision FROM metadata WHERE id = 1",
      )[0];
      if (metadata === undefined) throw new Error("User metadata is missing");
      return {
        revision: integer(
          metadata.workspace_authorization_revision,
          "workspace authorization revision",
        ),
        roots: readWorkspaces(database).map((workspace) => workspace.path),
      };
    });
  }

  add(input: {
    readonly path: string;
    readonly label: string;
    readonly now?: string;
    readonly id?: string;
  }): Promise<WorkspaceRecord> {
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      const existing = readWorkspaceByPath(database, input.path);
      if (existing !== undefined) return existing;
      const revision = incrementAuthorizationRevision(database);
      const id = input.id ?? randomUUID();
      database.run(
        "INSERT INTO workspaces (id, path, label, created_at, revision) VALUES (?, ?, ?, ?, ?)",
        [id, input.path, input.label, now, revision],
      );
      const defaultId = readDefaultId(database);
      if (defaultId === undefined) {
        database.run(
          "UPDATE metadata SET default_workspace_id = ? WHERE id = 1",
          [id],
        );
      }
      return requiredWorkspace(database, id);
    });
  }

  remove(id: string, expectedRevision: number): Promise<boolean> {
    return this.#file.transaction((database) => {
      const current = readWorkspace(database, id);
      if (current === undefined) return false;
      if (current.revision !== expectedRevision) {
        throw new WorkspaceRevisionConflictError(id);
      }
      if (
        queryRows(
          database,
          "SELECT 1 FROM queue_items WHERE workspace_path = ? AND status <> 'completed' LIMIT 1",
          [current.path],
        ).length > 0
      ) {
        throw new WorkspaceInUseError(id);
      }
      database.run("DELETE FROM workspaces WHERE id = ? AND revision = ?", [
        id,
        expectedRevision,
      ]);
      if (database.getRowsModified() !== 1) {
        throw new WorkspaceRevisionConflictError(id);
      }
      incrementAuthorizationRevision(database);
      if (readDefaultId(database) === id) {
        const next = queryRows(
          database,
          "SELECT id FROM workspaces ORDER BY path LIMIT 1",
        )[0];
        database.run(
          "UPDATE metadata SET default_workspace_id = ? WHERE id = 1",
          [next === undefined ? null : text(next.id, "workspace id")],
        );
      }
      return true;
    });
  }

  defaultId(): Promise<string | undefined> {
    return this.#file.read(readDefaultId);
  }

  setDefault(id: string): Promise<string> {
    return this.#file.transaction((database) => {
      if (readWorkspace(database, id) === undefined) {
        throw new WorkspaceRevisionConflictError(id);
      }
      database.run(
        "UPDATE metadata SET default_workspace_id = ? WHERE id = 1",
        [id],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("User metadata is missing");
      }
      return id;
    });
  }
}

function readWorkspaces(database: Database): WorkspaceRecord[] {
  const defaultId = readDefaultId(database);
  return queryRows(
    database,
    "SELECT id, path, label, created_at, revision FROM workspaces ORDER BY path",
  ).map((row) => parseWorkspace(row, defaultId));
}

function readWorkspace(
  database: Database,
  id: string,
): WorkspaceRecord | undefined {
  const row = queryRows(
    database,
    "SELECT id, path, label, created_at, revision FROM workspaces WHERE id = ?",
    [id],
  )[0];
  return row === undefined
    ? undefined
    : parseWorkspace(row, readDefaultId(database));
}

function readWorkspaceByPath(
  database: Database,
  path: string,
): WorkspaceRecord | undefined {
  const row = queryRows(
    database,
    "SELECT id, path, label, created_at, revision FROM workspaces WHERE path = ?",
    [path],
  )[0];
  return row === undefined
    ? undefined
    : parseWorkspace(row, readDefaultId(database));
}

function requiredWorkspace(database: Database, id: string): WorkspaceRecord {
  const workspace = readWorkspace(database, id);
  if (workspace === undefined) throw new Error("Workspace disappeared");
  return workspace;
}

function parseWorkspace(
  row: ReturnType<typeof queryRows>[number],
  defaultId: string | undefined,
): WorkspaceRecord {
  const id = text(row.id, "workspace id");
  return {
    id,
    path: text(row.path, "workspace path"),
    label: text(row.label, "workspace label"),
    createdAt: text(row.created_at, "workspace created_at"),
    revision: integer(row.revision, "workspace revision"),
    isDefault: id === defaultId,
  };
}

function readDefaultId(database: Database): string | undefined {
  const row = queryRows(
    database,
    "SELECT default_workspace_id FROM metadata WHERE id = 1",
  )[0];
  if (row === undefined) throw new Error("User metadata is missing");
  return nullableText(row.default_workspace_id, "default workspace id");
}

function incrementAuthorizationRevision(database: Database): number {
  database.run(
    "UPDATE metadata SET workspace_authorization_revision = workspace_authorization_revision + 1 WHERE id = 1",
  );
  if (database.getRowsModified() !== 1) {
    throw new Error("User metadata is missing");
  }
  const row = queryRows(
    database,
    "SELECT workspace_authorization_revision FROM metadata WHERE id = 1",
  )[0];
  if (row === undefined) throw new Error("User metadata is missing");
  return integer(
    row.workspace_authorization_revision,
    "workspace authorization revision",
  );
}
