import type {
  ApprovalsReviewer,
  AskForApproval,
  SandboxMode,
} from "@codex-everywhere/codex-app-server-schema/v2";

import type { HostStateStore } from "./state-store.js";

const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const APPROVAL_REVIEWERS = new Set<ApprovalsReviewer>([
  "user",
  "auto_review",
  "guardian_subagent",
]);

export type ThreadPermissionSnapshot = {
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandboxPolicy: unknown;
};

export type StoredThreadPermissions = {
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  updatedAt: string;
};

export class ThreadPermissionRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  read(threadId: string): Promise<StoredThreadPermissions | undefined> {
    requireThreadId(threadId);
    return this.#state.read((database) => {
      const statement = database.prepare(
        `SELECT approval_policy_json, approvals_reviewer, sandbox_mode, updated_at
           FROM thread_permissions WHERE thread_id = ?`,
      );
      try {
        statement.bind([threadId]);
        if (!statement.step()) return undefined;
        const [approvalJson, reviewer, sandbox, updatedAt] = statement.get();
        if (
          typeof approvalJson !== "string" ||
          typeof reviewer !== "string" ||
          typeof sandbox !== "string" ||
          typeof updatedAt !== "string"
        ) {
          throw new Error("Stored thread permissions are invalid");
        }
        const approvalPolicy = parseApprovalPolicy(approvalJson);
        return {
          ...(approvalPolicy ? { approvalPolicy } : {}),
          ...(isApprovalsReviewer(reviewer)
            ? { approvalsReviewer: reviewer }
            : {}),
          ...(isSandboxMode(sandbox) ? { sandbox } : {}),
          updatedAt,
        };
      } finally {
        statement.free();
      }
    });
  }

  async save(
    threadId: string,
    snapshot: ThreadPermissionSnapshot,
  ): Promise<StoredThreadPermissions> {
    requireThreadId(threadId);
    const approvalPolicy = isApprovalPolicy(snapshot.approvalPolicy)
      ? snapshot.approvalPolicy
      : undefined;
    const approvalsReviewer = isApprovalsReviewer(snapshot.approvalsReviewer)
      ? snapshot.approvalsReviewer
      : undefined;
    const sandbox = sandboxModeFromPolicy(snapshot.sandboxPolicy);
    const updatedAt = new Date().toISOString();
    await this.#state.transaction((database) => {
      database.run(
        `INSERT OR REPLACE INTO thread_permissions
          (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          threadId,
          JSON.stringify(approvalPolicy ?? null),
          approvalsReviewer ?? "",
          sandbox ?? "",
          updatedAt,
        ],
      );
    });
    return {
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(approvalsReviewer ? { approvalsReviewer } : {}),
      ...(sandbox ? { sandbox } : {}),
      updatedAt,
    };
  }

  saveResponse(
    response: unknown,
  ): Promise<StoredThreadPermissions | undefined> {
    if (
      !isRecord(response) ||
      !isRecord(response.thread) ||
      typeof response.thread.id !== "string"
    ) {
      return Promise.resolve(undefined);
    }
    return this.save(response.thread.id, {
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      sandboxPolicy: response.sandbox,
    });
  }

  saveSettingsNotification(
    params: unknown,
  ): Promise<StoredThreadPermissions | undefined> {
    if (
      !isRecord(params) ||
      typeof params.threadId !== "string" ||
      !isRecord(params.threadSettings)
    ) {
      return Promise.resolve(undefined);
    }
    return this.save(params.threadId, {
      approvalPolicy: params.threadSettings.approvalPolicy,
      approvalsReviewer: params.threadSettings.approvalsReviewer,
      sandboxPolicy: params.threadSettings.sandboxPolicy,
    });
  }

  async applyToResume(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const threadId = requiredThreadId(payload.threadId);
    const stored = await this.read(threadId);
    if (!stored) return { ...payload };
    return {
      ...payload,
      ...(payload.approvalPolicy === undefined && stored.approvalPolicy
        ? { approvalPolicy: stored.approvalPolicy }
        : {}),
      ...(payload.approvalsReviewer === undefined && stored.approvalsReviewer
        ? { approvalsReviewer: stored.approvalsReviewer }
        : {}),
      ...(payload.sandbox === undefined && stored.sandbox
        ? { sandbox: stored.sandbox }
        : {}),
    };
  }

  async remove(threadId: string): Promise<boolean> {
    requireThreadId(threadId);
    return this.#state.transaction((database) => {
      database.run("DELETE FROM thread_permissions WHERE thread_id = ?", [
        threadId,
      ]);
      return database.getRowsModified() > 0;
    });
  }
}

function sandboxModeFromPolicy(policy: unknown): SandboxMode | undefined {
  if (!isRecord(policy) || typeof policy.type !== "string") return undefined;
  switch (policy.type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    default:
      return undefined;
  }
}

function parseApprovalPolicy(value: string): AskForApproval | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isApprovalPolicy(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isSandboxMode(value: string): value is SandboxMode {
  return SANDBOX_MODES.has(value as SandboxMode);
}

function isApprovalsReviewer(value: unknown): value is ApprovalsReviewer {
  return (
    typeof value === "string" &&
    APPROVAL_REVIEWERS.has(value as ApprovalsReviewer)
  );
}

function isApprovalPolicy(value: unknown): value is AskForApproval {
  if (value === "untrusted" || value === "on-request" || value === "never")
    return true;
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
  if (threadId.length === 0) throw new Error("Thread id must not be empty");
}
