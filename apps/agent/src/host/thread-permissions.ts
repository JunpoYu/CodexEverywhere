import type {
  AskForApproval,
  SandboxMode,
  SandboxPolicy,
} from "@codex-everywhere/codex-app-server-schema/v2";

import type { HostStateStore } from "./state-store.js";

const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export type StoredThreadPermissions = {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
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
        `SELECT approval_policy_json, sandbox_mode, updated_at
           FROM thread_permissions WHERE thread_id = ?`,
      );
      try {
        statement.bind([threadId]);
        if (!statement.step()) return undefined;
        const [approvalJson, sandbox, updatedAt] = statement.get();
        if (
          typeof approvalJson !== "string" ||
          typeof sandbox !== "string" ||
          !isSandboxMode(sandbox) ||
          typeof updatedAt !== "string"
        ) {
          throw new Error("Stored thread permissions are invalid");
        }
        const approvalPolicy: unknown = JSON.parse(approvalJson);
        if (!isApprovalPolicy(approvalPolicy))
          throw new Error("Stored thread approval policy is invalid");
        return { approvalPolicy, sandbox, updatedAt };
      } finally {
        statement.free();
      }
    });
  }

  async save(
    threadId: string,
    approvalPolicy: AskForApproval,
    sandboxPolicy: SandboxPolicy,
  ): Promise<StoredThreadPermissions | undefined> {
    requireThreadId(threadId);
    if (!isApprovalPolicy(approvalPolicy))
      throw new Error("Invalid thread approval policy");
    const sandbox = sandboxModeFromPolicy(sandboxPolicy);
    if (!sandbox) {
      await this.remove(threadId);
      return undefined;
    }
    const updatedAt = new Date().toISOString();
    await this.#state.transaction((database) => {
      database.run(
        `INSERT OR REPLACE INTO thread_permissions
          (thread_id, approval_policy_json, sandbox_mode, updated_at)
         VALUES (?, ?, ?, ?)`,
        [threadId, JSON.stringify(approvalPolicy), sandbox, updatedAt],
      );
    });
    return { approvalPolicy, sandbox, updatedAt };
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

function sandboxModeFromPolicy(policy: SandboxPolicy): SandboxMode | undefined {
  switch (policy.type) {
    case "readOnly":
      return "read-only";
    case "workspaceWrite":
      return "workspace-write";
    case "dangerFullAccess":
      return "danger-full-access";
    case "externalSandbox":
      return undefined;
  }
}

function isSandboxMode(value: string): value is SandboxMode {
  return SANDBOX_MODES.has(value as SandboxMode);
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

function requireThreadId(threadId: string): void {
  if (threadId.length === 0) throw new Error("Thread id must not be empty");
}
