import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayRemoteError,
  gatewayEventEnvelopeV2,
  gatewayMethodDefinitions,
  type GatewayEventEnvelopeV2,
  type GatewayEventName,
  type GatewayEventPayload,
  type GatewayMethodName,
  type InputOf,
  type JsonValue,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";

import type { GatewayPort } from "./gateway-port.js";

type Workspace = OutputOf<"workspace/list">["workspaces"][number];
type Thread = OutputOf<"thread/list">["threads"][number];
type TimelineItem = OutputOf<"thread/history">["items"][number];
type QueueItem = OutputOf<"queue/list">["items"][number];
type Preferences = OutputOf<"preferences/read">;
type Interaction = OutputOf<"interaction/list">["interactions"][number];
type AdminUser = OutputOf<"admin/user/register">["user"];
type AdminAudit = OutputOf<"admin/audit/list">["events"][number];
type MutationStatus = OutputOf<"mutation/status">;
type ThreadSettings = OutputOf<"thread/settings/update">;

interface ScenarioThread {
  summary: Thread;
  items: TimelineItem[];
}

export interface ScenarioGatewayOptions {
  readonly changePreferencesAfterInitialRead?: boolean;
  readonly delaySecondPreferencesReadOnce?: boolean;
  readonly failFirstPreferencesReadOnce?: boolean;
  readonly failWorkspaceListAfterMutationOnce?: boolean;
  readonly preferencesAlreadyAppliedConflictOnce?: boolean;
  readonly preferencesConflictRefreshFailureOnce?: boolean;
  readonly threadSettingsConflictOnce?: boolean;
}

/** Deterministic no-model backend for actor, Storybook-like and Playwright flows. */
export class ScenarioGateway implements GatewayPort {
  readonly #scope = new Scope("scenario-gateway");
  readonly #events = new Set<(event: GatewayEventEnvelopeV2) => void>();
  readonly #connectionListeners = new Set<(error: Error) => void>();
  readonly #restoredListeners = new Set<() => void>();
  readonly #workspaces = new Map<string, Workspace>();
  readonly #threads = new Map<string, ScenarioThread>();
  readonly #threadSettings = new Map<string, ThreadSettings>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #interactionTurns = new Map<
    string,
    { readonly threadId: string; readonly turnId: string }
  >();
  readonly #queue = new Map<string, QueueItem>();
  readonly #adminUsers = new Map<string, AdminUser>();
  readonly #adminAudit: AdminAudit[] = [];
  readonly #mutationStatuses = new Map<string, MutationStatus>();
  #failWorkspaceListAfterMutationOnce: boolean;
  #workspaceListFailureArmed = false;
  #changePreferencesAfterInitialRead: boolean;
  #delaySecondPreferencesReadOnce: boolean;
  #failFirstPreferencesReadOnce: boolean;
  #taskPrerequisiteFailureDisarmScheduled = false;
  #unmatchedWorkspaceReads = 0;
  #workspaceReadResetScheduled = false;
  #preferencesAlreadyAppliedConflictOnce: boolean;
  #preferencesConflictRefreshFailureOnce: boolean;
  #preferencesReadFailureArmed = false;
  #threadSettingsConflictOnce: boolean;
  #networkMode: "direct" | "proxy" = "direct";
  #codexInstalled = true;
  #codexAuthenticated = true;
  #preferences: Preferences = {
    version: 1,
    revision: 0,
    theme: "system",
    locale: "zh-CN",
    defaultWorkspaceId: "workspace-demo",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  };

  constructor(options: ScenarioGatewayOptions = {}) {
    this.#changePreferencesAfterInitialRead =
      options.changePreferencesAfterInitialRead ?? false;
    this.#delaySecondPreferencesReadOnce =
      options.delaySecondPreferencesReadOnce ?? false;
    this.#failFirstPreferencesReadOnce =
      options.failFirstPreferencesReadOnce ?? false;
    this.#failWorkspaceListAfterMutationOnce =
      options.failWorkspaceListAfterMutationOnce ?? false;
    this.#preferencesAlreadyAppliedConflictOnce =
      options.preferencesAlreadyAppliedConflictOnce ?? false;
    this.#preferencesConflictRefreshFailureOnce =
      options.preferencesConflictRefreshFailureOnce ?? false;
    this.#threadSettingsConflictOnce =
      options.threadSettingsConflictOnce ?? false;
    const now = new Date().toISOString();
    this.#workspaces.set("workspace-demo", {
      version: 1,
      id: "workspace-demo",
      path: "/public/demo",
      label: "Demo",
      isDefault: true,
      revision: 1,
    });
    this.#threads.set("thread-welcome", {
      summary: {
        version: 1,
        id: "thread-welcome",
        workspaceId: "workspace-demo",
        title: "欢迎使用 CodexEverywhere",
        state: "idle",
        archived: false,
        createdAt: now,
        updatedAt: now,
      },
      items: [
        {
          version: 1,
          id: "message-welcome",
          type: "message",
          createdAt: now,
          data: {
            role: "assistant",
            text: "这是 v0.4 ScenarioGateway。连接真实宿主机后，任务状态由 Codex app-server 提供。",
          },
        },
      ],
    });
    this.#threadSettings.set("thread-welcome", {
      version: 1,
      revision: 0,
    });
  }

  async request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    this.#scope.throwIfClosed();
    const definition = gatewayMethodDefinitions[method];
    const parsed = definition.input.parse(input);
    const operationKey = (options as { readonly operationKey?: string })
      .operationKey;
    if (definition.idempotency === "durable" && operationKey !== undefined) {
      const existing = this.#mutationStatuses.get(operationKey);
      if (existing !== undefined && existing.status !== "missing") {
        if (existing.method !== method) {
          throw new Error("Scenario operation key belongs to another method");
        }
        if (existing.status === "completed") {
          if (existing.outcome.kind === "error") {
            throw new Error(existing.outcome.error.message);
          }
          return definition.output.parse(
            existing.outcome.result,
          ) as OutputOf<Method>;
        }
        throw new Error("Scenario operation is already pending");
      }
      this.#mutationStatuses.set(operationKey, {
        version: 1,
        status: "pending",
        method,
        startedAt: new Date().toISOString(),
      });
    }
    try {
      const result = definition.output.parse(
        await this.#dispatch(method, parsed),
      );
      if (definition.idempotency === "durable" && operationKey !== undefined) {
        this.#mutationStatuses.set(operationKey, {
          version: 1,
          status: "completed",
          method,
          completedAt: new Date().toISOString(),
          outcome: {
            version: 1,
            kind: "success",
            result: result as JsonValue,
          },
        });
      }
      return result as OutputOf<Method>;
    } catch (error) {
      if (definition.idempotency === "durable" && operationKey !== undefined) {
        this.#mutationStatuses.set(operationKey, {
          version: 1,
          status: "completed",
          method,
          completedAt: new Date().toISOString(),
          outcome: {
            version: 1,
            kind: "error",
            error: {
              code: "SCENARIO_OPERATION_FAILED",
              message: message(error),
            },
          },
        });
      }
      throw error;
    }
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  onConnectionRestored(listener: () => void): () => void {
    this.#restoredListeners.add(listener);
    return () => this.#restoredListeners.delete(listener);
  }

  close(): Promise<void> {
    return this.#scope.close("scenario-closed");
  }

  disconnect(reason = new Error("Scenario connection lost")): void {
    for (const listener of [...this.#connectionListeners]) listener(reason);
  }

  restore(): void {
    for (const listener of [...this.#restoredListeners]) listener();
  }

  async #dispatch(method: GatewayMethodName, input: unknown): Promise<unknown> {
    const record = input as Record<string, unknown>;
    switch (method) {
      case "host/ping":
        return {
          version: 1,
          hostId: "scenario-host",
          serverTime: new Date().toISOString(),
          gatewayApiVersion: 2,
        };
      case "auth/status":
        return {
          version: 1,
          initialized: true,
          authenticated: true,
          passkeyAvailable: true,
          passwordAvailable: true,
          temporary: false,
        };
      case "auth/register/options":
      case "auth/login/options":
        return {
          version: 1,
          challengeId: crypto.randomUUID(),
          options: {
            challenge: "scenario-challenge",
            rpId: "scenario.local",
          },
          expiresAt: futureTimestamp(5),
        };
      case "auth/register/verify":
        return authenticationResult(Boolean(record.rememberDevice), true);
      case "auth/login/verify":
      case "auth/password/register/finish":
      case "auth/password/login/finish":
      case "auth/recover":
        return authenticationResult(Boolean(record.rememberDevice));
      case "auth/password/register/start":
      case "auth/password/login/start":
        return {
          version: 1,
          challengeId: crypto.randomUUID(),
          message: "scenario-opaque-server-message",
          expiresAt: futureTimestamp(5),
        };
      case "auth/recovery/rotate":
        return {
          version: 1,
          recoveryCodes: ["SCENARIO-RECOVERY-01", "SCENARIO-RECOVERY-02"],
        };
      case "setup/status":
        return {
          version: 1,
          networkConfigured: true,
          networkMode: this.#networkMode,
          codexInstalled: this.#codexInstalled,
          ...(this.#codexInstalled ? { codexVersion: "scenario" } : {}),
          codexAuthenticated: this.#codexAuthenticated,
          appServerHealthy: this.#codexInstalled && this.#codexAuthenticated,
          ready: this.#codexInstalled && this.#codexAuthenticated,
        };
      case "setup/network/configure":
        this.#networkMode = record.mode === "proxy" ? "proxy" : "direct";
        return { version: 1, configured: true, mode: this.#networkMode };
      case "setup/codex/install": {
        const operationId = crypto.randomUUID();
        this.#emit("setup/codex/install/progress", {
          version: 1,
          operationId,
          phase: "preparing",
        });
        this.#scope.setTimeout(() => {
          this.#codexInstalled = true;
          this.#emit("setup/codex/install/progress", {
            version: 1,
            operationId,
            phase: "completed",
          });
        }, 50);
        return { version: 1, operationId, accepted: true };
      }
      case "setup/codex/version":
        return {
          version: 1,
          installed: this.#codexInstalled,
          ...(this.#codexInstalled ? { installedVersion: "scenario" } : {}),
          latestVersion: "scenario",
          relation: this.#codexInstalled ? "current" : "unknown",
        };
      case "setup/codex/login/start": {
        const operationId = crypto.randomUUID();
        this.#scope.setTimeout(() => {
          this.#codexAuthenticated = true;
          this.#emit("setup/codex/login/completed", {
            version: 1,
            operationId,
            success: true,
          });
        }, 50);
        return {
          version: 1,
          operationId,
          verificationUri: "https://example.com/device",
          userCode: "SCENARIO-CODE",
          expiresAt: futureTimestamp(10),
          intervalSeconds: 1,
        };
      }
      case "setup/codex/login/cancel":
        return { version: 1, cancelled: true };
      case "setup/codex/logout":
        this.#codexAuthenticated = false;
        return { version: 1, loggedOut: true };
      case "setup/app-server/restart":
        return { version: 1, restarted: true };
      case "workspace/list":
        if (this.#workspaceListFailureArmed) {
          this.#workspaceListFailureArmed = false;
          throw new Error("Scenario 工作区列表暂时不可用");
        }
        this.#unmatchedWorkspaceReads += 1;
        if (!this.#workspaceReadResetScheduled) {
          this.#workspaceReadResetScheduled = true;
          this.#scope.setTimeout(() => {
            this.#unmatchedWorkspaceReads = 0;
            this.#workspaceReadResetScheduled = false;
          }, 0);
        }
        return { version: 1, workspaces: [...this.#workspaces.values()] };
      case "workspace/browse":
        return {
          version: 1,
          path: typeof record.path === "string" ? record.path : "/public",
          entries: [],
        };
      case "workspace/add": {
        const id = crypto.randomUUID();
        const path = String(record.path);
        const workspace: Workspace = {
          version: 1,
          id,
          path,
          label:
            typeof record.label === "string"
              ? record.label
              : path.split("/").at(-1) || path,
          isDefault: this.#workspaces.size === 0,
          revision: 1,
        };
        this.#workspaces.set(id, workspace);
        this.#armWorkspaceListFailure();
        return { version: 1, workspace };
      }
      case "workspace/remove":
        this.#removeWorkspace(String(record.workspaceId));
        this.#armWorkspaceListFailure();
        return { version: 1, removed: true };
      case "workspace/default/read":
        return {
          version: 1,
          workspaceId: [...this.#workspaces.values()].find(
            (workspace) => workspace.isDefault,
          )?.id,
        };
      case "workspace/default/update": {
        const workspaceId = String(record.workspaceId);
        for (const [id, workspace] of this.#workspaces) {
          this.#workspaces.set(id, {
            ...workspace,
            isDefault: id === workspaceId,
          });
        }
        this.#armWorkspaceListFailure();
        return { version: 1, workspaceId };
      }
      case "thread/list": {
        const archived = Boolean(record.archived);
        const workspaceId =
          typeof record.workspaceId === "string"
            ? record.workspaceId
            : undefined;
        return {
          version: 1,
          threads: [...this.#threads.values()]
            .map((thread) => thread.summary)
            .filter(
              (thread) =>
                thread.archived === archived &&
                (workspaceId === undefined ||
                  thread.workspaceId === workspaceId),
            ),
          hasMore: false,
        };
      }
      case "thread/start": {
        const requested = (record.settings ?? {}) as Partial<ThreadSettings>;
        if (
          (requested.sandbox === undefined ||
            requested.approvalPolicy === undefined) &&
          Number(record.expectedPreferencesRevision) !==
            this.#preferences.revision
        ) {
          throw new GatewayRemoteError({
            code: "REVISION_CONFLICT",
            message: "Scenario default preferences changed before start",
          });
        }
        return this.#startThread(record);
      }
      case "thread/open":
        return this.#openThread(String(record.threadId));
      case "thread/history": {
        const thread = this.#requiredThread(String(record.threadId));
        return { version: 1, items: thread.items, hasMore: false };
      }
      case "thread/close":
        return { version: 1, closed: true };
      case "thread/rename": {
        const thread = this.#requiredThread(String(record.threadId));
        thread.summary = {
          ...thread.summary,
          title: String(record.title),
          updatedAt: new Date().toISOString(),
        };
        return { version: 1, thread: thread.summary };
      }
      case "thread/archive":
      case "thread/unarchive": {
        const thread = this.#requiredThread(String(record.threadId));
        thread.summary = {
          ...thread.summary,
          archived: method === "thread/archive",
        };
        return { version: 1, thread: thread.summary };
      }
      case "thread/delete":
        return this.#deleteThread(String(record.threadId));
      case "thread/settings/update": {
        const threadId = String(record.threadId);
        this.#requiredThread(threadId);
        const current = this.#threadSettings.get(threadId) ?? {
          version: 1,
          revision: 0,
        };
        if (current.revision !== Number(record.expectedRevision)) {
          throw new Error("Scenario thread settings revision changed");
        }
        if (this.#threadSettingsConflictOnce) {
          this.#threadSettingsConflictOnce = false;
          this.#threadSettings.set(threadId, {
            ...current,
            revision: current.revision + 1,
            sandbox: "read-only",
            approvalPolicy: "never",
          });
          throw new GatewayRemoteError({
            code: "REVISION_CONFLICT",
            message: "Scenario thread settings changed externally",
          });
        }
        const updated = {
          ...current,
          ...(record.patch as Partial<ThreadSettings>),
          version: 1 as const,
          revision: current.revision + 1,
        };
        this.#threadSettings.set(threadId, updated);
        return updated;
      }
      case "turn/start":
        return this.#startTurn(String(record.threadId), String(record.prompt));
      case "turn/interrupt": {
        const threadId = String(record.threadId);
        for (const interaction of this.#threadInteractions(threadId)) {
          this.#interactions.delete(interaction.id);
          this.#interactionTurns.delete(interaction.id);
          this.#emit("interaction/failed", {
            version: 1,
            threadId,
            interactionId: interaction.id,
            reason: "Scenario turn was interrupted",
          });
        }
        this.#setThreadState(threadId, "idle");
        return { version: 1, interrupted: true };
      }
      case "interaction/list":
        return {
          version: 1,
          interactions: this.#threadInteractions(String(record.threadId)),
        };
      case "interaction/respond": {
        const interactionId = String(record.interactionId);
        const interaction = this.#interactions.get(interactionId);
        if (
          interaction === undefined ||
          interaction.threadId !== String(record.threadId)
        ) {
          throw new Error("Scenario interaction is already resolved");
        }
        const pendingTurn = this.#interactionTurns.get(interactionId);
        this.#interactions.delete(interactionId);
        this.#interactionTurns.delete(interactionId);
        this.#emit("interaction/resolved", {
          version: 1,
          threadId: interaction.threadId,
          interactionId,
        });
        if (pendingTurn !== undefined) {
          this.#setThreadState(
            pendingTurn.threadId,
            "running",
            pendingTurn.turnId,
          );
          this.#completeScenarioTurn(pendingTurn.threadId, pendingTurn.turnId);
        }
        return { version: 1, interactionId, resolved: true };
      }
      case "queue/list":
        return {
          version: 1,
          items: [...this.#queue.values()].filter(
            (item) =>
              typeof record.threadId !== "string" ||
              item.threadId === record.threadId,
          ),
          hasMore: false,
        };
      case "queue/add": {
        const now = new Date().toISOString();
        const item: QueueItem = {
          version: 1,
          id: crypto.randomUUID(),
          threadId: String(record.threadId),
          text: String(record.text),
          status: "pending",
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        this.#queue.set(item.id, item);
        this.#emit("queue/changed", { version: 1, item });
        return { version: 1, item };
      }
      case "queue/remove": {
        const itemId = String(record.itemId);
        this.#requiredQueue(itemId);
        this.#queue.delete(itemId);
        this.#emit("queue/removed", { version: 1, itemId });
        return { version: 1, removed: true };
      }
      case "queue/steer": {
        const item = this.#requiredQueue(String(record.itemId));
        const updated = {
          ...item,
          text: String(record.text),
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        this.#queue.set(updated.id, updated);
        return { version: 1, item: updated };
      }
      case "queue/indeterminate/acknowledge": {
        const item = this.#requiredQueue(String(record.itemId));
        const updated: QueueItem = {
          ...item,
          status: record.disposition === "retry" ? "pending" : "completed",
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        this.#queue.set(updated.id, updated);
        return { version: 1, item: updated };
      }
      case "mutation/status":
        return (
          this.#mutationStatuses.get(String(record.operationKey)) ?? {
            version: 1,
            status: "missing",
          }
        );
      case "preferences/read":
        const taskPrerequisiteRead = this.#unmatchedWorkspaceReads > 0;
        if (taskPrerequisiteRead) this.#unmatchedWorkspaceReads -= 1;
        if (this.#failFirstPreferencesReadOnce && taskPrerequisiteRead) {
          if (!this.#taskPrerequisiteFailureDisarmScheduled) {
            this.#taskPrerequisiteFailureDisarmScheduled = true;
            this.#scope.setTimeout(() => {
              this.#failFirstPreferencesReadOnce = false;
              this.#taskPrerequisiteFailureDisarmScheduled = false;
            }, 0);
          }
          throw new Error("Scenario preferences are temporarily unavailable");
        }
        if (this.#preferencesReadFailureArmed) {
          this.#preferencesReadFailureArmed = false;
          throw new Error("Scenario conflict refresh failed");
        }
        if (this.#delaySecondPreferencesReadOnce && !taskPrerequisiteRead) {
          this.#delaySecondPreferencesReadOnce = false;
          await this.#waitFor(400);
        }
        if (this.#changePreferencesAfterInitialRead) {
          this.#changePreferencesAfterInitialRead = false;
          this.#scope.setTimeout(() => {
            this.#preferences = {
              ...this.#preferences,
              revision: this.#preferences.revision + 1,
              sandbox: "read-only",
            };
          }, 0);
        }
        return this.#preferences;
      case "preferences/update":
        if (Number(record.expectedRevision) !== this.#preferences.revision) {
          throw new GatewayRemoteError({
            code: "REVISION_CONFLICT",
            message: "Scenario preferences changed externally",
          });
        }
        if (this.#preferencesAlreadyAppliedConflictOnce) {
          this.#preferencesAlreadyAppliedConflictOnce = false;
          this.#preferences = {
            ...this.#preferences,
            ...(record.patch as Partial<Preferences>),
            revision: this.#preferences.revision + 1,
          };
          throw new GatewayRemoteError({
            code: "REVISION_CONFLICT",
            message: "Scenario preferences were applied by another device",
          });
        }
        if (this.#preferencesConflictRefreshFailureOnce) {
          this.#preferencesConflictRefreshFailureOnce = false;
          this.#preferencesReadFailureArmed = true;
          this.#preferences = {
            ...this.#preferences,
            revision: this.#preferences.revision + 1,
          };
          throw new GatewayRemoteError({
            code: "REVISION_CONFLICT",
            message: "Scenario preferences changed externally",
          });
        }
        this.#preferences = {
          ...this.#preferences,
          ...(record.patch as Partial<Preferences>),
          revision: this.#preferences.revision + 1,
        };
        return this.#preferences;
      case "thread/tui/handoff":
        return {
          version: 1,
          command: `codex --remote ${String(record.threadId)}`,
          expiresAt: futureTimestamp(5),
        };
      case "admin/host/status":
        return {
          version: 1,
          installationId: "scenario-installation",
          serverName: "scenario-host",
          controllerStartedAt: new Date().toISOString(),
          managedUsers: this.#adminUsers.size,
          enabledUsers: this.#countAdminUsers("enabled"),
          disabledUsers: this.#countAdminUsers("disabled"),
          pendingRemovals: this.#countAdminUsers("removal_pending"),
        };
      case "admin/user/inspect": {
        const user = this.#adminUsers.get(String(record.username));
        return {
          version: 1,
          eligible: true,
          ...(user === undefined ? {} : { user }),
        };
      }
      case "admin/user/register": {
        const username = String(record.username);
        const existing = this.#adminUsers.get(username);
        if (existing !== undefined) return { version: 1, user: existing };
        const now = new Date().toISOString();
        const user: AdminUser = {
          version: 1,
          uid: 10_000 + this.#adminUsers.size,
          username,
          home: `/home/${username}`,
          shell: "/bin/bash",
          status: "enabled",
          agentOnline: false,
          revision: 1,
          registeredAt: now,
          updatedAt: now,
        };
        this.#adminUsers.set(username, user);
        this.#appendAdminAudit("admin/user/register", username);
        return { version: 1, user };
      }
      case "admin/user/disable":
        return {
          version: 1,
          user: this.#updateAdminUser(record, "disabled"),
        };
      case "admin/user/enable":
        return {
          version: 1,
          user: this.#updateAdminUser(record, "enabled"),
        };
      case "admin/user/removal/schedule":
        return {
          version: 1,
          user: this.#updateAdminUser(
            record,
            "removal_pending",
            String(record.removeAfter),
          ),
        };
      case "admin/user/removal/cancel":
        return {
          version: 1,
          user: this.#updateAdminUser(record, "enabled"),
        };
      case "admin/user/recovery/start": {
        this.#requiredAdminUser(record);
        this.#appendAdminAudit(
          "admin/user/recovery/start",
          String(record.username),
        );
        return {
          version: 1,
          username: String(record.username),
          handoffCode: "SCENARIO-HANDOFF-CODE",
          expiresAt: futureTimestamp(10),
        };
      }
      case "admin/audit/list": {
        const username =
          typeof record.username === "string" ? record.username : undefined;
        return {
          version: 1,
          events: this.#adminAudit.filter(
            (event) =>
              username === undefined || event.targetUsername === username,
          ),
          hasMore: false,
        };
      }
      default:
        return assertNever(method);
    }
  }

  #startThread(record: Record<string, unknown>) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const prompt = String(record.prompt);
    const thread: ScenarioThread = {
      summary: {
        version: 1,
        id,
        workspaceId: String(record.workspaceId),
        title: prompt.slice(0, 64),
        state: "running",
        archived: false,
        createdAt: now,
        updatedAt: now,
      },
      items: [messageItem("user", prompt, turnId)],
    };
    this.#threads.set(id, thread);
    const requested = (record.settings ?? {}) as Partial<ThreadSettings>;
    this.#threadSettings.set(id, {
      version: 1,
      revision: 0,
      ...(requested.model === undefined ? {} : { model: requested.model }),
      ...(requested.effort === undefined ? {} : { effort: requested.effort }),
      sandbox: requested.sandbox ?? this.#preferences.sandbox,
      approvalPolicy:
        requested.approvalPolicy ?? this.#preferences.approvalPolicy,
    });
    const interactionKind = scenarioInteractionKind(prompt);
    if (interactionKind !== undefined) {
      this.#createScenarioInteraction(id, turnId, interactionKind);
    } else {
      this.#completeScenarioTurn(id, turnId);
    }
    return { version: 1, thread: thread.summary, turnId };
  }

  #startTurn(threadId: string, prompt: string) {
    const thread = this.#requiredThread(threadId);
    const turnId = crypto.randomUUID();
    thread.items.push(messageItem("user", prompt, turnId));
    this.#setThreadState(threadId, "running", turnId);
    const interactionKind = scenarioInteractionKind(prompt);
    if (interactionKind !== undefined) {
      this.#createScenarioInteraction(threadId, turnId, interactionKind);
    } else {
      this.#completeScenarioTurn(threadId, turnId);
    }
    return { version: 1, threadId, turnId };
  }

  #createScenarioInteraction(
    threadId: string,
    turnId: string,
    kind: Interaction["kind"],
  ): void {
    const request = scenarioInteractionRequest(kind);
    const interaction: Interaction = {
      version: 1,
      id: crypto.randomUUID(),
      threadId,
      turnId,
      kind,
      requestMethod: request.method,
      createdAt: new Date().toISOString(),
      payload: request.payload,
    };
    this.#interactions.set(interaction.id, interaction);
    this.#interactionTurns.set(interaction.id, { threadId, turnId });
    this.#setThreadState(threadId, "waiting-input", turnId);
    this.#emit("interaction/created", { version: 1, interaction });
  }

  #completeScenarioTurn(threadId: string, turnId: string): void {
    this.#scope.setTimeout(() => {
      const thread = this.#threads.get(threadId);
      if (thread === undefined) return;
      const item = messageItem(
        "assistant",
        "Scenario 回复已完成。真实连接会在同一位置呈现 Codex 流式事件。",
        turnId,
      );
      thread.items.push(item);
      this.#emit("codex/notification", {
        version: 1,
        threadId,
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: item.id,
            text: String(item.data.text),
            phase: null,
            memoryCitation: null,
          },
          completedAtMs: Date.now(),
        },
      });
      this.#setThreadState(threadId, "idle");
    }, 250);
  }

  #openThread(threadId: string) {
    const thread = this.#requiredThread(threadId);
    return {
      version: 1,
      thread: thread.summary,
      state: thread.summary.state,
      items: thread.items,
      interactions: this.#threadInteractions(threadId),
      hasEarlierHistory: false,
      settings: this.#threadSettings.get(threadId) ?? {
        version: 1,
        revision: 0,
      },
    };
  }

  #threadInteractions(threadId: string): Interaction[] {
    return [...this.#interactions.values()].filter(
      (interaction) => interaction.threadId === threadId,
    );
  }

  #deleteThread(threadId: string): OutputOf<"thread/delete"> {
    this.#requiredThread(threadId);
    this.#threads.delete(threadId);
    this.#threadSettings.delete(threadId);
    for (const interaction of this.#threadInteractions(threadId)) {
      this.#interactions.delete(interaction.id);
      this.#interactionTurns.delete(interaction.id);
    }
    for (const [itemId, item] of this.#queue) {
      if (item.threadId === threadId) this.#queue.delete(itemId);
    }
    return { version: 1, deleted: true };
  }

  #removeWorkspace(workspaceId: string): void {
    if (!this.#workspaces.has(workspaceId)) {
      throw new Error("Scenario workspace does not exist");
    }
    if (
      [...this.#threads.values()].some(
        (thread) => thread.summary.workspaceId === workspaceId,
      )
    ) {
      throw new Error("Scenario workspace still owns tasks");
    }
    this.#workspaces.delete(workspaceId);
  }

  #armWorkspaceListFailure(): void {
    if (!this.#failWorkspaceListAfterMutationOnce) return;
    this.#failWorkspaceListAfterMutationOnce = false;
    this.#workspaceListFailureArmed = true;
  }

  #countAdminUsers(status: AdminUser["status"]): number {
    return [...this.#adminUsers.values()].filter(
      (user) => user.status === status,
    ).length;
  }

  #requiredAdminUser(record: Record<string, unknown>): AdminUser {
    const username = String(record.username);
    const user = this.#adminUsers.get(username);
    if (user === undefined)
      throw new Error("Scenario managed user does not exist");
    if (user.revision !== Number(record.expectedRevision)) {
      throw new Error("Scenario managed user revision changed");
    }
    return user;
  }

  #updateAdminUser(
    record: Record<string, unknown>,
    status: AdminUser["status"],
    removeAfter?: string,
  ): AdminUser {
    const current = this.#requiredAdminUser(record);
    const updated: AdminUser = {
      ...current,
      status,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      ...(removeAfter === undefined ? {} : { removeAfter }),
    };
    if (removeAfter === undefined && status !== "removal_pending") {
      const { removeAfter: _removed, ...withoutRemoval } = updated;
      this.#adminUsers.set(current.username, withoutRemoval);
      this.#appendAdminAudit(`admin/user/${status}`, current.username);
      return withoutRemoval;
    }
    this.#adminUsers.set(current.username, updated);
    this.#appendAdminAudit(`admin/user/${status}`, current.username);
    return updated;
  }

  #appendAdminAudit(action: string, targetUsername: string): void {
    this.#adminAudit.unshift({
      version: 1,
      id: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      actor: "scenario-admin",
      action,
      targetUsername,
      result: "succeeded",
      createdAt: new Date().toISOString(),
    });
  }

  #setThreadState(
    threadId: string,
    state: Thread["state"],
    currentTurnId?: string,
  ): void {
    const thread = this.#requiredThread(threadId);
    thread.summary = {
      ...thread.summary,
      state,
      updatedAt: new Date().toISOString(),
    };
    this.#emit("thread/state", {
      version: 1,
      threadId,
      state,
      ...(currentTurnId === undefined ? {} : { currentTurnId }),
    });
  }

  #requiredThread(id: string): ScenarioThread {
    const thread = this.#threads.get(id);
    if (thread === undefined) throw new Error("Scenario task does not exist");
    return thread;
  }

  #requiredQueue(id: string): QueueItem {
    const item = this.#queue.get(id);
    if (item === undefined)
      throw new Error("Scenario Queue item does not exist");
    return item;
  }

  #waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const reason = this.#scope.signal.reason;
        reject(reason instanceof Error ? reason : new Error("Scenario closed"));
      };
      this.#scope.signal.addEventListener("abort", onAbort, { once: true });
      this.#scope.setTimeout(() => {
        this.#scope.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
    });
  }

  #emit<Name extends GatewayEventName>(
    type: Name,
    payload: GatewayEventPayload<Name>,
  ): void {
    const event = gatewayEventEnvelopeV2(type, payload);
    for (const listener of [...this.#events]) listener(event);
  }
}

function messageItem(
  role: "user" | "assistant",
  text: string,
  turnId: string,
): TimelineItem {
  return {
    version: 1,
    id: crypto.randomUUID(),
    turnId,
    type: "message",
    createdAt: new Date().toISOString(),
    data: { role, text },
  };
}

function authenticationResult(
  rememberedDevice: boolean,
  includeRecoveryCodes = false,
): OutputOf<"auth/login/verify"> {
  return {
    version: 1,
    authenticated: true,
    principal: "user",
    loginName: "scenario-user",
    resumeToken: "scenario-resume-token",
    rememberedDevice,
    ...(includeRecoveryCodes
      ? { recoveryCodes: ["SCENARIO-RECOVERY-01"] }
      : {}),
  };
}

function futureTimestamp(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function scenarioInteractionKind(
  prompt: string,
): Interaction["kind"] | undefined {
  if (/\[approval\]|需要审批/iu.test(prompt)) return "approval";
  if (/\[question\]|需要提问/iu.test(prompt)) return "user-question";
  if (/\[mcp\]|需要 mcp/iu.test(prompt)) return "mcp-elicitation";
  return undefined;
}

function scenarioInteractionRequest(kind: Interaction["kind"]): {
  readonly method: string;
  readonly payload: Record<string, JsonValue>;
} {
  if (kind === "user-question") {
    return {
      method: "item/tool/requestUserInput",
      payload: {
        questions: [
          {
            id: "target",
            header: "目标环境",
            question: "请选择要继续验证的环境。",
            options: [
              {
                label: "Staging",
                description: "使用合成 staging 环境继续。",
              },
              {
                label: "Local",
                description: "使用本地合成环境继续。",
              },
            ],
          },
        ],
      },
    };
  }
  if (kind === "mcp-elicitation") {
    return {
      method: "mcpServer/elicitation/request",
      payload: {
        serverName: "scenario-mcp",
        message: "Scenario MCP 请求结构化输入。",
      },
    };
  }
  return {
    method: "item/commandExecution/requestApproval",
    payload: {
      command: "printf 'scenario approval'",
      reason: "ScenarioGateway deterministic approval fixture",
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Scenario operation failed";
}

function assertNever(value: never): never {
  throw new Error(`Scenario method is not implemented: ${String(value)}`);
}
