import { createHash } from "node:crypto";

import type {
  ApprovalsReviewer,
  AskForApproval,
  SandboxMode,
  ThreadResumeResponse,
} from "@codex-everywhere/codex-app-server-schema/v2";
import type { Database } from "sql.js";

import { integer, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export interface StoredThreadSettings {
  readonly revision: number;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
  readonly updatedAt?: string;
}

export interface ThreadSettingsObservation {
  readonly generation: number;
  readonly observedAt: string;
}

export interface ThreadSettingsMutationLease {
  release(): Promise<void>;
}

export interface TuiThreadPermissionSnapshot {
  readonly approvalPolicy?: unknown;
  readonly approvalsReviewer?: unknown;
  readonly sandboxPolicy?: unknown;
}

interface TuiStoredThreadPermissions {
  readonly approvalPolicy?: AskForApproval;
  readonly approvalsReviewer?: ApprovalsReviewer;
  readonly sandbox?: SandboxMode;
  readonly revision: number;
  readonly updatedAt?: string;
}

export class ThreadSettingsRevisionConflictError extends Error {
  constructor(readonly threadId: string) {
    super("Thread settings revision changed");
    this.name = "ThreadSettingsRevisionConflictError";
  }
}

export class ThreadSettingsRepository {
  readonly #file: SqliteStateFile;

  constructor(file: SqliteStateFile) {
    this.#file = file;
  }

  read(threadId: string): Promise<StoredThreadSettings> {
    requireThreadId(threadId);
    return this.#file.read((database) => readSettings(database, threadId));
  }

  save(
    threadId: string,
    expectedRevision: number,
    patch: Omit<StoredThreadSettings, "revision" | "updatedAt">,
    now = new Date().toISOString(),
  ): Promise<StoredThreadSettings> {
    requireThreadId(threadId);
    return this.#file.transaction((database) => {
      const current = readSettings(database, threadId);
      if (current.revision !== expectedRevision) {
        throw new ThreadSettingsRevisionConflictError(threadId);
      }
      const next = { ...current, ...patch };
      const revision = expectedRevision + 1;
      const generation = nextGeneration(database);
      if (expectedRevision === 0 && current.updatedAt === undefined) {
        database.run(
          "INSERT INTO thread_permissions (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, revision, updated_at) VALUES (?, ?, 'user', ?, ?, ?)",
          [
            threadId,
            JSON.stringify(next.approvalPolicy ?? null),
            next.sandbox ?? "",
            revision,
            now,
          ],
        );
      } else {
        database.run(
          "UPDATE thread_permissions SET approval_policy_json = ?, sandbox_mode = ?, revision = ?, updated_at = ? WHERE thread_id = ? AND revision = ?",
          [
            JSON.stringify(next.approvalPolicy ?? null),
            next.sandbox ?? "",
            revision,
            now,
            threadId,
            expectedRevision,
          ],
        );
        if (database.getRowsModified() !== 1) {
          throw new ThreadSettingsRevisionConflictError(threadId);
        }
      }
      database.run(
        "INSERT OR REPLACE INTO thread_permission_observations (thread_id, generation) VALUES (?, ?)",
        [threadId, generation],
      );
      return { ...next, revision, updatedAt: now };
    });
  }

  remove(threadId: string): Promise<void> {
    requireThreadId(threadId);
    return this.#file.transaction((database) => {
      const generation = nextGeneration(database);
      writeThreadObservation(database, threadId, generation);
      database.run("DELETE FROM thread_permissions WHERE thread_id = ?", [
        threadId,
      ]);
    });
  }

  beginObservation(threadId?: string): Promise<ThreadSettingsObservation> {
    if (threadId !== undefined) requireThreadId(threadId);
    return this.#file.transaction((database) => {
      const generation = nextGeneration(database);
      if (threadId !== undefined) {
        writeThreadObservation(database, threadId, generation);
      }
      return { generation, observedAt: new Date().toISOString() };
    });
  }

  claimRepairObservation(
    threadId: string,
    expected: ThreadSettingsObservation,
  ): Promise<ThreadSettingsObservation | undefined> {
    requireThreadId(threadId);
    requireGeneration(expected.generation);
    return this.#file.transaction((database) => {
      if (readThreadObservation(database, threadId) !== expected.generation) {
        return undefined;
      }
      const generation = nextGeneration(database);
      writeThreadObservation(database, threadId, generation);
      return { generation, observedAt: new Date().toISOString() };
    });
  }

  acquireMutation(
    threadId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ThreadSettingsMutationLease> {
    requireThreadId(threadId);
    const digest = createHash("sha256").update(threadId).digest("hex");
    return this.#file.acquireCoordinationLock(
      `thread-permission-${digest}`,
      options,
    );
  }

  async applyToResume(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const threadId = requiredThreadId(payload.threadId);
    const stored = await this.#file.read((database) =>
      readTuiSettings(database, threadId),
    );
    return {
      ...payload,
      ...(payload.approvalPolicy == null && stored.approvalPolicy !== undefined
        ? { approvalPolicy: stored.approvalPolicy }
        : {}),
      ...(payload.approvalsReviewer == null &&
      stored.approvalsReviewer !== undefined
        ? { approvalsReviewer: stored.approvalsReviewer }
        : {}),
      ...(payload.sandbox == null && stored.sandbox !== undefined
        ? { sandbox: stored.sandbox }
        : {}),
    };
  }

  async saveObserved(
    threadId: string,
    snapshot: TuiThreadPermissionSnapshot,
    observation?: ThreadSettingsObservation,
  ): Promise<void> {
    requireThreadId(threadId);
    const causal = observation ?? (await this.beginObservation(threadId));
    requireGeneration(causal.generation);
    await this.#file.transaction((database) => {
      const currentGeneration = readThreadObservation(database, threadId);
      if (
        currentGeneration !== undefined &&
        currentGeneration > causal.generation
      ) {
        return;
      }
      ensureGeneration(database, causal.generation);
      writeThreadObservation(database, threadId, causal.generation);
      const current = readTuiSettings(database, threadId);
      const approvalPolicy = Object.hasOwn(snapshot, "approvalPolicy")
        ? isApprovalPolicy(snapshot.approvalPolicy)
          ? snapshot.approvalPolicy
          : undefined
        : current.approvalPolicy;
      const approvalsReviewer = Object.hasOwn(snapshot, "approvalsReviewer")
        ? isApprovalsReviewer(snapshot.approvalsReviewer)
          ? snapshot.approvalsReviewer
          : undefined
        : current.approvalsReviewer;
      const sandbox = Object.hasOwn(snapshot, "sandboxPolicy")
        ? sandboxModeFromPolicy(snapshot.sandboxPolicy)
        : current.sandbox;
      const revision = current.revision + 1;
      database.run(
        `INSERT OR REPLACE INTO thread_permissions
          (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          JSON.stringify(approvalPolicy ?? null),
          approvalsReviewer ?? "",
          sandbox ?? "",
          revision,
          causal.observedAt,
        ],
      );
    });
  }
}

/**
 * app-server may apply the TUI process defaults during thread/resume even
 * after CE has restored the persisted per-thread settings. Repair that race
 * before exposing the response to the TUI, and send the same authoritative
 * values back to app-server under the per-thread mutation fence.
 */
export function resumeThreadSettingsRepair(
  requested: Record<string, unknown>,
  response: ThreadResumeResponse,
):
  | { update: Record<string, unknown>; response: ThreadResumeResponse }
  | undefined {
  const update: Record<string, unknown> = {};
  let approvalPolicy = response.approvalPolicy;
  let approvalsReviewer = response.approvalsReviewer;
  let sandbox = response.sandbox;
  if (
    requested.approvalPolicy !== undefined &&
    requested.approvalPolicy !== null &&
    !permissionValuesEqual(requested.approvalPolicy, response.approvalPolicy)
  ) {
    update.approvalPolicy = requested.approvalPolicy;
    approvalPolicy = requested.approvalPolicy as typeof approvalPolicy;
  }
  if (
    requested.approvalsReviewer !== undefined &&
    requested.approvalsReviewer !== null &&
    requested.approvalsReviewer !== response.approvalsReviewer
  ) {
    update.approvalsReviewer = requested.approvalsReviewer;
    approvalsReviewer = requested.approvalsReviewer as typeof approvalsReviewer;
  }
  if (
    typeof requested.sandbox === "string" &&
    sandboxModeFromPolicy(response.sandbox) !== requested.sandbox
  ) {
    sandbox = sandboxPolicyForResumeMode(requested.sandbox, response.sandbox);
    update.sandboxPolicy = sandbox;
  }
  if (Object.keys(update).length === 0) return undefined;
  return {
    update,
    response: {
      ...response,
      approvalPolicy,
      approvalsReviewer,
      sandbox,
    },
  };
}

function readSettings(
  database: Database,
  threadId: string,
): StoredThreadSettings {
  const row = queryRows(
    database,
    "SELECT approval_policy_json, sandbox_mode, revision, updated_at FROM thread_permissions WHERE thread_id = ?",
    [threadId],
  )[0];
  if (row === undefined) return { revision: 0 };
  let approval: unknown;
  try {
    approval = JSON.parse(text(row.approval_policy_json, "approval policy"));
  } catch {
    throw new Error("Stored approval policy is invalid");
  }
  const sandbox = text(row.sandbox_mode, "sandbox mode");
  return {
    revision: integer(row.revision, "thread settings revision"),
    ...(sandbox === "read-only" ||
    sandbox === "workspace-write" ||
    sandbox === "danger-full-access"
      ? { sandbox }
      : {}),
    ...(approval === "untrusted" ||
    approval === "on-request" ||
    approval === "never"
      ? { approvalPolicy: approval }
      : {}),
    updatedAt: text(row.updated_at, "thread settings updated_at"),
  };
}

function nextGeneration(database: Database): number {
  database.run(
    "UPDATE metadata SET thread_permission_generation = thread_permission_generation + 1 WHERE id = 1",
  );
  if (database.getRowsModified() !== 1)
    throw new Error("User metadata is missing");
  const row = queryRows(
    database,
    "SELECT thread_permission_generation FROM metadata WHERE id = 1",
  )[0];
  if (row === undefined) throw new Error("User metadata is missing");
  return integer(row.thread_permission_generation, "permission generation");
}

function readThreadObservation(
  database: Database,
  threadId: string,
): number | undefined {
  const row = queryRows(
    database,
    "SELECT generation FROM thread_permission_observations WHERE thread_id = ?",
    [threadId],
  )[0];
  if (row === undefined) return undefined;
  return integer(row.generation, "thread permission observation");
}

function writeThreadObservation(
  database: Database,
  threadId: string,
  generation: number,
): void {
  requireGeneration(generation);
  database.run(
    "INSERT OR REPLACE INTO thread_permission_observations (thread_id, generation) VALUES (?, ?)",
    [threadId, generation],
  );
}

function ensureGeneration(database: Database, generation: number): void {
  requireGeneration(generation);
  const current = queryRows(
    database,
    "SELECT thread_permission_generation FROM metadata WHERE id = 1",
  )[0];
  if (current === undefined) throw new Error("User metadata is missing");
  if (
    integer(current.thread_permission_generation, "permission generation") <
    generation
  ) {
    database.run(
      "UPDATE metadata SET thread_permission_generation = ? WHERE id = 1",
      [generation],
    );
  }
}

function readTuiSettings(
  database: Database,
  threadId: string,
): TuiStoredThreadPermissions {
  const row = queryRows(
    database,
    "SELECT approval_policy_json, approvals_reviewer, sandbox_mode, revision, updated_at FROM thread_permissions WHERE thread_id = ?",
    [threadId],
  )[0];
  if (row === undefined) return { revision: 0 };
  let approvalPolicy: unknown;
  try {
    approvalPolicy = JSON.parse(
      text(row.approval_policy_json, "approval policy"),
    ) as unknown;
  } catch {
    throw new Error("Stored approval policy is invalid");
  }
  const reviewer = text(row.approvals_reviewer, "approvals reviewer");
  const sandbox = text(row.sandbox_mode, "sandbox mode");
  return {
    revision: integer(row.revision, "thread settings revision"),
    ...(isApprovalPolicy(approvalPolicy) ? { approvalPolicy } : {}),
    ...(isApprovalsReviewer(reviewer) ? { approvalsReviewer: reviewer } : {}),
    ...(isSandboxMode(sandbox) ? { sandbox } : {}),
    updatedAt: text(row.updated_at, "thread settings updated_at"),
  };
}

function sandboxModeFromPolicy(policy: unknown): SandboxMode | undefined {
  if (!isRecord(policy) || typeof policy.type !== "string") return undefined;
  if (policy.type === "readOnly") return "read-only";
  if (policy.type === "workspaceWrite") return "workspace-write";
  if (policy.type === "dangerFullAccess") return "danger-full-access";
  return undefined;
}

function permissionValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function sandboxPolicyForResumeMode(
  mode: string,
  current: ThreadResumeResponse["sandbox"],
): ThreadResumeResponse["sandbox"] {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") {
    return {
      type: "readOnly",
      networkAccess:
        current.type === "readOnly" ? current.networkAccess : false,
    };
  }
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots:
        current.type === "workspaceWrite" ? current.writableRoots : [],
      networkAccess:
        current.type === "workspaceWrite" ? current.networkAccess : false,
      excludeTmpdirEnvVar:
        current.type === "workspaceWrite" ? current.excludeTmpdirEnvVar : false,
      excludeSlashTmp:
        current.type === "workspaceWrite" ? current.excludeSlashTmp : false,
    };
  }
  return current;
}

function isSandboxMode(value: string): value is SandboxMode {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

function isApprovalsReviewer(value: unknown): value is ApprovalsReviewer {
  return (
    value === "user" || value === "auto_review" || value === "guardian_subagent"
  );
}

function isApprovalPolicy(value: unknown): value is AskForApproval {
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return true;
  }
  if (!isRecord(value) || !isRecord(value.granular)) return false;
  const granular = value.granular;
  return [
    "sandbox_approval",
    "rules",
    "skill_approval",
    "request_permissions",
    "mcp_elicitations",
  ].every((key) => typeof granular[key] === "boolean");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredThreadId(value: unknown): string {
  if (typeof value !== "string") throw new Error("Thread id must be a string");
  requireThreadId(value);
  return value;
}

function requireThreadId(threadId: string): void {
  if (threadId.length === 0 || threadId.length > 1_024) {
    throw new Error("Thread id is invalid");
  }
}

function requireGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Thread permission observation is invalid");
  }
}
