import { createHash } from "node:crypto";

import type {
  ApprovalsReviewer,
  AskForApproval,
  SandboxMode,
  ThreadResumeResponse,
} from "@codex-everywhere/codex-app-server-schema/v2";
import type { Database } from "sql.js";

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
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
};

export type StoredThreadPermissions = {
  approvalPolicy?: AskForApproval;
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: SandboxMode;
  updatedAt: string;
};

export type ThreadPermissionObservation = {
  generation: number;
  observedAt: string;
};

export type ThreadPermissionMutationLease = {
  release(): Promise<void>;
};

export class ThreadPermissionRegistry {
  readonly #state: HostStateStore;
  readonly #threadMutations = new Map<string, Promise<void>>();

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

  /**
   * Allocate a Host-wide generation before sending a request or awaiting any
   * asynchronous authorization work. The generation and the per-thread latest
   * marker are committed under the Host state lock, so independent Agent/TUI
   * processes share one causal order without consulting wall-clock time.
   */
  beginObservation(threadId?: string): Promise<ThreadPermissionObservation> {
    if (threadId !== undefined) requireThreadId(threadId);
    return this.#state.transaction((database) => {
      const generation = nextObservationGeneration(database);
      if (threadId !== undefined) {
        writeThreadObservationGeneration(database, threadId, generation);
      }
      return { generation, observedAt: new Date().toISOString() };
    });
  }

  observationIsCurrent(
    threadId: string,
    observation: ThreadPermissionObservation,
  ): Promise<boolean> {
    requireThreadId(threadId);
    return this.#state.read(
      (database) =>
        readThreadObservationGeneration(database, threadId) ===
        observation.generation,
    );
  }

  /**
   * Atomically claim a new generation for a repair only if no newer explicit
   * update, notification, or response has superseded the resume observation.
   */
  claimRepairObservation(
    threadId: string,
    expected: ThreadPermissionObservation,
  ): Promise<ThreadPermissionObservation | undefined> {
    requireThreadId(threadId);
    return this.#state.transaction((database) => {
      if (
        readThreadObservationGeneration(database, threadId) !==
        expected.generation
      ) {
        return undefined;
      }
      const generation = nextObservationGeneration(database);
      writeThreadObservationGeneration(database, threadId, generation);
      return { generation, observedAt: new Date().toISOString() };
    });
  }

  /**
   * Serialize permission-changing app-server calls across Gateway sessions
   * and the background queue dispatcher, which share this registry instance.
   */
  serializeMutation<T>(
    threadId: string,
    operation: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    requireThreadId(threadId);
    const previous = this.#threadMutations.get(threadId);
    const result = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const lease = await this.acquireMutation(threadId, options);
        try {
          return await operation();
        } finally {
          await lease.release();
        }
      });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#threadMutations.set(threadId, tail);
    void tail.then(() => {
      if (this.#threadMutations.get(threadId) === tail) {
        this.#threadMutations.delete(threadId);
      }
    });
    return result;
  }

  acquireMutation(
    threadId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ThreadPermissionMutationLease> {
    requireThreadId(threadId);
    const digest = createHash("sha256").update(threadId).digest("hex");
    return this.#state.acquireCoordinationLock(
      `thread-permission-${digest}`,
      options,
    );
  }

  async save(
    threadId: string,
    snapshot: ThreadPermissionSnapshot,
    observation?: ThreadPermissionObservation,
  ): Promise<StoredThreadPermissions | undefined> {
    requireThreadId(threadId);
    const causalObservation =
      observation ?? (await this.beginObservation(threadId));
    return this.#state.transaction((database) => {
      const existing = readStoredPermissions(database, threadId);
      const currentGeneration = readThreadObservationGeneration(
        database,
        threadId,
      );
      if (
        currentGeneration !== undefined &&
        currentGeneration > causalObservation.generation
      ) {
        return existing;
      }
      ensureObservationGeneration(database, causalObservation.generation);
      writeThreadObservationGeneration(
        database,
        threadId,
        causalObservation.generation,
      );
      const approvalPolicy = Object.hasOwn(snapshot, "approvalPolicy")
        ? isApprovalPolicy(snapshot.approvalPolicy)
          ? snapshot.approvalPolicy
          : undefined
        : existing?.approvalPolicy;
      const approvalsReviewer = Object.hasOwn(snapshot, "approvalsReviewer")
        ? isApprovalsReviewer(snapshot.approvalsReviewer)
          ? snapshot.approvalsReviewer
          : undefined
        : existing?.approvalsReviewer;
      const sandbox = Object.hasOwn(snapshot, "sandboxPolicy")
        ? sandboxModeFromPolicy(snapshot.sandboxPolicy)
        : existing?.sandbox;
      database.run(
        `INSERT OR REPLACE INTO thread_permissions
          (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          threadId,
          JSON.stringify(approvalPolicy ?? null),
          approvalsReviewer ?? "",
          sandbox ?? "",
          causalObservation.observedAt,
        ],
      );
      return {
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(approvalsReviewer ? { approvalsReviewer } : {}),
        ...(sandbox ? { sandbox } : {}),
        updatedAt: causalObservation.observedAt,
      };
    });
  }

  saveResponse(
    response: unknown,
    observation?: ThreadPermissionObservation,
  ): Promise<StoredThreadPermissions | undefined> {
    if (
      !isRecord(response) ||
      !isRecord(response.thread) ||
      typeof response.thread.id !== "string"
    ) {
      return Promise.resolve(undefined);
    }
    return this.save(
      response.thread.id,
      {
        ...(response.approvalPolicy != null
          ? { approvalPolicy: response.approvalPolicy }
          : {}),
        ...(response.approvalsReviewer != null
          ? { approvalsReviewer: response.approvalsReviewer }
          : {}),
        ...(response.sandbox != null
          ? { sandboxPolicy: response.sandbox }
          : {}),
      },
      observation,
    );
  }

  saveSettingsNotification(
    params: unknown,
    observation?: ThreadPermissionObservation,
  ): Promise<StoredThreadPermissions | undefined> {
    if (
      !isRecord(params) ||
      typeof params.threadId !== "string" ||
      !isRecord(params.threadSettings)
    ) {
      return Promise.resolve(undefined);
    }
    return this.save(
      params.threadId,
      {
        ...(params.threadSettings.approvalPolicy != null
          ? { approvalPolicy: params.threadSettings.approvalPolicy }
          : {}),
        ...(params.threadSettings.approvalsReviewer != null
          ? { approvalsReviewer: params.threadSettings.approvalsReviewer }
          : {}),
        ...(params.threadSettings.sandboxPolicy != null
          ? { sandboxPolicy: params.threadSettings.sandboxPolicy }
          : {}),
      },
      observation,
    );
  }

  saveSettingsUpdate(
    threadId: string,
    payload: Record<string, unknown>,
    observation?: ThreadPermissionObservation,
  ): Promise<StoredThreadPermissions | undefined> {
    return this.save(
      threadId,
      {
        ...(payload.approvalPolicy != null
          ? { approvalPolicy: payload.approvalPolicy }
          : {}),
        ...(payload.approvalsReviewer != null
          ? { approvalsReviewer: payload.approvalsReviewer }
          : {}),
        ...(payload.sandboxPolicy != null
          ? { sandboxPolicy: payload.sandboxPolicy }
          : {}),
      },
      observation,
    );
  }

  async applyToResume(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const threadId = requiredThreadId(payload.threadId);
    const stored = await this.read(threadId);
    if (!stored) return { ...payload };
    return {
      ...payload,
      ...(payload.approvalPolicy == null && stored.approvalPolicy
        ? { approvalPolicy: stored.approvalPolicy }
        : {}),
      ...(payload.approvalsReviewer == null && stored.approvalsReviewer
        ? { approvalsReviewer: stored.approvalsReviewer }
        : {}),
      ...(payload.sandbox == null && stored.sandbox
        ? { sandbox: stored.sandbox }
        : {}),
    };
  }

  async remove(threadId: string): Promise<boolean> {
    requireThreadId(threadId);
    return this.#state.transaction((database) => {
      const generation = nextObservationGeneration(database);
      writeThreadObservationGeneration(database, threadId, generation);
      database.run("DELETE FROM thread_permissions WHERE thread_id = ?", [
        threadId,
      ]);
      // Advance and retain the observation generation as a tombstone so a
      // delayed start/fork/resume response allocated before deletion cannot
      // recreate the permission row, even if it had not previously been
      // associated with this thread id.
      return database.getRowsModified() > 0;
    });
  }
}

export function resumePermissionRepair(
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

function readStoredPermissions(
  database: Database,
  threadId: string,
): StoredThreadPermissions | undefined {
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
      ...(isApprovalsReviewer(reviewer) ? { approvalsReviewer: reviewer } : {}),
      ...(isSandboxMode(sandbox) ? { sandbox } : {}),
      updatedAt,
    };
  } finally {
    statement.free();
  }
}

function nextObservationGeneration(database: Database): number {
  const current = readGlobalObservationGeneration(database);
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Thread permission observation generation is exhausted");
  }
  const generation = current + 1;
  database.run(
    "UPDATE thread_permission_observation_state SET generation = ? WHERE id = 1",
    [generation],
  );
  if (database.getRowsModified() !== 1) {
    throw new Error("Thread permission observation state is missing");
  }
  return generation;
}

function ensureObservationGeneration(
  database: Database,
  generation: number,
): void {
  requireObservationGeneration(generation);
  if (readGlobalObservationGeneration(database) >= generation) return;
  database.run(
    "UPDATE thread_permission_observation_state SET generation = ? WHERE id = 1",
    [generation],
  );
}

function readGlobalObservationGeneration(database: Database): number {
  const statement = database.prepare(
    "SELECT generation FROM thread_permission_observation_state WHERE id = 1",
  );
  try {
    if (!statement.step()) {
      throw new Error("Thread permission observation state is missing");
    }
    const value = statement.get()[0];
    requireObservationGeneration(value);
    return value;
  } finally {
    statement.free();
  }
}

function readThreadObservationGeneration(
  database: Database,
  threadId: string,
): number | undefined {
  const statement = database.prepare(
    "SELECT generation FROM thread_permission_observations WHERE thread_id = ?",
  );
  try {
    statement.bind([threadId]);
    if (!statement.step()) return undefined;
    const value = statement.get()[0];
    requireObservationGeneration(value);
    return value;
  } finally {
    statement.free();
  }
}

function writeThreadObservationGeneration(
  database: Database,
  threadId: string,
  generation: number,
): void {
  requireObservationGeneration(generation);
  database.run(
    `INSERT OR REPLACE INTO thread_permission_observations
       (thread_id, generation) VALUES (?, ?)`,
    [threadId, generation],
  );
}

function requireObservationGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Stored thread permission observation is invalid");
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
