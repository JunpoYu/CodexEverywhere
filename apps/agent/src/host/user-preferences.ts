import type {
  SessionApprovalDefault,
  SessionPermissionDefaults,
  SessionSandboxDefault,
} from "@codex-everywhere/protocol";

import type { HostStateStore } from "./state-store.js";

export const INITIAL_SESSION_PERMISSION_DEFAULTS = {
  version: 1,
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
} as const satisfies SessionPermissionDefaults;

const SANDBOX_DEFAULTS = new Set<SessionSandboxDefault>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const APPROVAL_DEFAULTS = new Set<SessionApprovalDefault>([
  "untrusted",
  "on-request",
  "never",
]);

export class UserPreferencesRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  readSessionPermissionDefaults(): Promise<SessionPermissionDefaults> {
    return this.#state.read((database) => {
      const result = database.exec(
        "SELECT default_sandbox, default_approval_policy, updated_at FROM user_preferences WHERE id = 1",
      );
      const row = result[0]?.values[0];
      if (!row) return INITIAL_SESSION_PERMISSION_DEFAULTS;
      const sandbox = row[0];
      const approvalPolicy = row[1];
      const updatedAt = row[2];
      if (
        typeof sandbox !== "string" ||
        !isSandboxDefault(sandbox) ||
        typeof approvalPolicy !== "string" ||
        !isApprovalDefault(approvalPolicy) ||
        typeof updatedAt !== "string"
      ) {
        throw new Error("Stored session permission defaults are invalid");
      }
      return { version: 1, sandbox, approvalPolicy, updatedAt };
    });
  }

  async updateSessionPermissionDefaults(input: {
    sandbox: unknown;
    approvalPolicy: unknown;
  }): Promise<SessionPermissionDefaults> {
    if (!isSandboxDefault(input.sandbox))
      throw new Error("Invalid default session sandbox");
    if (!isApprovalDefault(input.approvalPolicy))
      throw new Error("Invalid default session approval policy");
    const sandbox = input.sandbox;
    const approvalPolicy = input.approvalPolicy;
    const updatedAt = new Date().toISOString();
    await this.#state.transaction((database) => {
      database.run(
        `INSERT OR REPLACE INTO user_preferences
          (id, default_sandbox, default_approval_policy, updated_at)
         VALUES (1, ?, ?, ?)`,
        [sandbox, approvalPolicy, updatedAt],
      );
    });
    return {
      version: 1,
      sandbox,
      approvalPolicy,
      updatedAt,
    };
  }
}

function isSandboxDefault(value: unknown): value is SessionSandboxDefault {
  return (
    typeof value === "string" &&
    SANDBOX_DEFAULTS.has(value as SessionSandboxDefault)
  );
}

function isApprovalDefault(value: unknown): value is SessionApprovalDefault {
  return (
    typeof value === "string" &&
    APPROVAL_DEFAULTS.has(value as SessionApprovalDefault)
  );
}
