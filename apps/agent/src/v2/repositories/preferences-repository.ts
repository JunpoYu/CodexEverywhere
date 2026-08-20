import type { Database } from "sql.js";

import { integer, nullableText, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export interface PreferencesRecord {
  readonly revision: number;
  readonly theme: "system" | "light" | "dark";
  readonly locale: string;
  readonly defaultWorkspaceId?: string;
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly updatedAt: string;
}

export type PreferencesPatch = Partial<
  Pick<
    PreferencesRecord,
    "theme" | "locale" | "defaultWorkspaceId" | "sandbox" | "approvalPolicy"
  >
>;

export interface PreferencesMutationLease {
  release(): Promise<void>;
}

export class PreferencesRevisionConflictError extends Error {
  constructor() {
    super("Preferences revision changed");
    this.name = "PreferencesRevisionConflictError";
  }
}

export class PreferencesRepository {
  readonly #file: SqliteStateFile;

  constructor(file: SqliteStateFile) {
    this.#file = file;
  }

  read(): Promise<PreferencesRecord> {
    return this.#file.read(readPreferences);
  }

  acquireMutation(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PreferencesMutationLease> {
    return this.#file.acquireCoordinationLock("preferences-mutation", options);
  }

  update(
    expectedRevision: number,
    patch: PreferencesPatch,
    now = new Date().toISOString(),
  ): Promise<PreferencesRecord> {
    return this.#file.transaction((database) => {
      const current = readPreferences(database);
      if (current.revision !== expectedRevision) {
        throw new PreferencesRevisionConflictError();
      }
      const next = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: now,
      };
      if (
        next.defaultWorkspaceId !== undefined &&
        queryRows(database, "SELECT 1 FROM workspaces WHERE id = ?", [
          next.defaultWorkspaceId,
        ]).length !== 1
      ) {
        throw new Error("Default workspace does not exist");
      }
      database.run(
        "UPDATE preferences SET theme = ?, locale = ?, default_sandbox = ?, default_approval_policy = ?, revision = ?, updated_at = ? WHERE id = 1 AND revision = ?",
        [
          next.theme,
          next.locale,
          next.sandbox,
          next.approvalPolicy,
          next.revision,
          next.updatedAt,
          expectedRevision,
        ],
      );
      if (database.getRowsModified() !== 1) {
        throw new PreferencesRevisionConflictError();
      }
      if (patch.defaultWorkspaceId !== undefined) {
        database.run(
          "UPDATE metadata SET default_workspace_id = ? WHERE id = 1",
          [patch.defaultWorkspaceId],
        );
      }
      return readPreferences(database);
    });
  }
}

function readPreferences(database: Database): PreferencesRecord {
  const row = queryRows(
    database,
    `SELECT p.theme, p.locale, p.default_sandbox, p.default_approval_policy,
            p.revision, p.updated_at, m.default_workspace_id
       FROM preferences p JOIN metadata m ON m.id = p.id
      WHERE p.id = 1`,
  )[0];
  if (row === undefined) throw new Error("Preferences are missing");
  const theme = text(row.theme, "preferences theme");
  const sandbox = text(row.default_sandbox, "preferences sandbox");
  const approvalPolicy = text(
    row.default_approval_policy,
    "preferences approval policy",
  );
  if (theme !== "system" && theme !== "light" && theme !== "dark") {
    throw new Error("Invalid preferences theme");
  }
  if (
    sandbox !== "read-only" &&
    sandbox !== "workspace-write" &&
    sandbox !== "danger-full-access"
  ) {
    throw new Error("Invalid preferences sandbox");
  }
  if (
    approvalPolicy !== "untrusted" &&
    approvalPolicy !== "on-request" &&
    approvalPolicy !== "never"
  ) {
    throw new Error("Invalid preferences approval policy");
  }
  const defaultWorkspaceId = nullableText(
    row.default_workspace_id,
    "default workspace id",
  );
  return {
    revision: integer(row.revision, "preferences revision"),
    theme,
    locale: text(row.locale, "preferences locale"),
    ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
    sandbox,
    approvalPolicy,
    updatedAt: text(row.updated_at, "preferences updated_at"),
  };
}
