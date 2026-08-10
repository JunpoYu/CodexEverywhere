import { EventEmitter } from "node:events";

import type {
  ThreadReadResponse,
  ThreadResumeResponse,
  TurnCompletedNotification,
  TurnStartResponse,
} from "@codex-everywhere/codex-app-server-schema/v2";

import { QueueRegistry } from "../host/queue.js";
import { WorkspaceRegistry } from "../host/workspaces.js";
import {
  resumePermissionRepair,
  ThreadPermissionRegistry,
} from "../host/thread-permissions.js";
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest,
} from "./codex-app-server-client.js";
import {
  consumeQueueItemOnce,
  QueueConsumptionRepairer,
  QueueConsumptionOutcomeIndeterminateError,
} from "./queue-consumption.js";

export type QueueDispatcherEvent = {
  type: string;
  payload: Record<string, unknown>;
};

type QueueDispatcherEvents = {
  event: [QueueDispatcherEvent];
};

export class QueueDispatcher {
  readonly #queue: QueueRegistry;
  readonly #workspaces: WorkspaceRegistry;
  readonly #threadPermissions: ThreadPermissionRegistry;
  readonly #connectClient: () => Promise<CodexAppServerClient>;
  readonly #consumptionRepairer: QueueConsumptionRepairer;
  readonly #ownsConsumptionRepairer: boolean;
  readonly #unsubscribeConsumptionRepair: () => void;
  readonly #unsubscribeConsumptionPauseRepair: () => void;
  readonly #events = new EventEmitter<QueueDispatcherEvents>();
  readonly #desiredThreads = new Set<string>();
  readonly #threadOperations = new Map<string, Promise<void>>();
  readonly #serverRequests = new Map<string, CodexServerRequest>();
  readonly #serverRequestPayloads = new Map<string, Record<string, unknown>>();
  #client: CodexAppServerClient | undefined;
  #clientPromise: Promise<CodexAppServerClient> | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: {
    queue: QueueRegistry;
    workspaces: WorkspaceRegistry;
    threadPermissions: ThreadPermissionRegistry;
    connectClient(): Promise<CodexAppServerClient>;
    consumptionRepairer?: QueueConsumptionRepairer;
  }) {
    this.#queue = options.queue;
    this.#workspaces = options.workspaces;
    this.#threadPermissions = options.threadPermissions;
    this.#connectClient = options.connectClient;
    this.#consumptionRepairer =
      options.consumptionRepairer ??
      new QueueConsumptionRepairer(options.queue);
    this.#ownsConsumptionRepairer = options.consumptionRepairer === undefined;
    this.#unsubscribeConsumptionRepair =
      this.#consumptionRepairer.onIndeterminate((identity) => {
        this.#emit("queue/indeterminate", {
          itemId: identity.queueItemId,
          threadId: identity.threadId,
          reason:
            "Queue delivery outcome could not be verified; review it before continuing",
        });
      });
    this.#unsubscribeConsumptionPauseRepair =
      this.#consumptionRepairer.onPaused((identity) => {
        this.#emit("queue/paused", {
          itemId: identity.queueItemId,
          threadId: identity.threadId,
          reason: "Queue delivery claim failed before submission",
        });
      });
  }

  async start(): Promise<void> {
    await this.#queue.pauseInterruptedClaims();
    const items = await this.#queue.list();
    const threadIds = new Set(
      items
        .filter((item) => item.status === "pending")
        .map((item) => item.threadId),
    );
    await Promise.allSettled(
      [...threadIds].map((threadId) => this.watchThread(threadId)),
    );
  }

  onEvent(listener: (event: QueueDispatcherEvent) => void): () => void {
    this.#events.on("event", listener);
    for (const payload of this.#serverRequestPayloads.values()) {
      listener({ type: "codex/serverRequest", payload });
    }
    return () => this.#events.off("event", listener);
  }

  watchThread(threadId: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Queue is closed"));
    return this.#serialize(threadId, () => {
      // Re-assert the subscription inside the serialized operation. A prior
      // drain may be releasing the same thread while a new item is enqueued.
      this.#desiredThreads.add(threadId);
      return this.#subscribeAndDrain(threadId);
    });
  }

  notifySteered(itemId: string, threadId: string): void {
    this.#emit("queue/steered", { itemId, threadId });
  }

  async respondToServerRequest(input: {
    requestId: string;
    result?: unknown;
    error?: { code: number; message: string };
  }): Promise<boolean> {
    const pending = this.#serverRequests.get(input.requestId);
    if (!pending) return false;
    const threadId = extractThreadId(pending.params);
    if (threadId) {
      const client = await this.#ensureClient();
      const read = await client.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (
        !(await this.#validateThreadWorkspace(
          threadId,
          read.thread.cwd,
          client,
        ))
      ) {
        this.#serverRequests.delete(input.requestId);
        this.#serverRequestPayloads.delete(input.requestId);
        pending.reject({
          code: -32_000,
          message: "Workspace authorization was revoked",
        });
        throw new Error(
          "Workspace authorization was revoked for this server request",
        );
      }
    }
    this.#serverRequests.delete(input.requestId);
    this.#serverRequestPayloads.delete(input.requestId);
    if (input.error) pending.reject(input.error);
    else pending.respond(input.result);
    this.#emit("codex/serverRequest/resolved", {
      requestId: input.requestId,
    });
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const client = this.#client;
    this.#client = undefined;
    this.#clientPromise = undefined;
    this.#serverRequests.clear();
    this.#serverRequestPayloads.clear();
    await client?.close();
    await Promise.allSettled(this.#threadOperations.values());
    this.#unsubscribeConsumptionRepair();
    this.#unsubscribeConsumptionPauseRepair();
    if (this.#ownsConsumptionRepairer) {
      await this.#consumptionRepairer.close();
    }
  }

  async #subscribeAndDrain(threadId: string): Promise<void> {
    try {
      const client = await this.#ensureClient();
      const read = await client.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (
        !(await this.#validateThreadWorkspace(
          threadId,
          read.thread.cwd,
          client,
        ))
      ) {
        return;
      }
      const resumed = await this.#threadPermissions.serializeMutation(
        threadId,
        async (): Promise<ThreadResumeResponse | undefined> => {
          const permissionObservation =
            await this.#threadPermissions.beginObservation(threadId);
          let resumePayload = await this.#threadPermissions.applyToResume({
            threadId,
          });
          if (
            !(await this.#threadPermissions.observationIsCurrent(
              threadId,
              permissionObservation,
            ))
          ) {
            resumePayload = { threadId };
          }
          let result = await client.request<ThreadResumeResponse>(
            "thread/resume",
            resumePayload,
          );
          if (
            !(await this.#validateThreadWorkspace(
              threadId,
              result.thread.cwd,
              client,
            ))
          ) {
            return undefined;
          }
          const repair = resumePermissionRepair(resumePayload, result);
          const repairObservation = repair
            ? await this.#threadPermissions.claimRepairObservation(
                threadId,
                permissionObservation,
              )
            : undefined;
          if (repair && repairObservation) {
            await client.request("thread/settings/update", {
              threadId,
              ...repair.update,
            });
            result = repair.response;
            await this.#threadPermissions.saveResponse(
              result,
              repairObservation,
            );
          } else {
            await this.#threadPermissions.saveResponse(
              result,
              permissionObservation,
            );
          }
          return result;
        },
      );
      if (!resumed) return;
      if (resumed.thread.status.type === "idle") {
        await this.#drain(threadId, client);
      }
    } catch (error) {
      this.#scheduleRetry();
      throw error;
    }
  }

  async #handleNotification(notification: CodexNotification): Promise<void> {
    const notificationThreadId = extractThreadId(notification.params);
    if (
      notificationThreadId &&
      this.#desiredThreads.has(notificationThreadId)
    ) {
      this.#emit(
        `codex/${notification.method}`,
        asPayload(notification.params),
      );
    }
    if (notification.method !== "turn/completed") return;
    const params = asTurnCompleted(notification.params);
    if (!params || !this.#desiredThreads.has(params.threadId)) return;
    await this.#serialize(params.threadId, async () => {
      if (params.turn.status === "completed") {
        const client = await this.#ensureClient();
        await this.#drain(params.threadId, client);
        return;
      }
      const paused = await this.#queue.pausePending(params.threadId);
      for (const item of paused) {
        this.#emit("queue/paused", {
          itemId: item.id,
          threadId: params.threadId,
          reason: `Previous turn ${params.turn.status}`,
        });
      }
      await this.#releaseThread(params.threadId);
    });
  }

  #handleServerRequest(request: CodexServerRequest): void {
    const threadId = extractThreadId(request.params);
    if (!threadId || !this.#desiredThreads.has(threadId)) return;
    const requestId = `queue:${String(request.id)}`;
    this.#serverRequests.set(requestId, request);
    const payload = {
      requestId,
      method: request.method,
      params: request.params,
    };
    this.#serverRequestPayloads.set(requestId, payload);
    this.#emit("codex/serverRequest", payload);
  }

  async #drain(threadId: string, client: CodexAppServerClient): Promise<void> {
    const current = await client.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: false,
    });
    const currentWorkspace = await this.#validateThreadWorkspace(
      threadId,
      current.thread.cwd,
      client,
    );
    if (!currentWorkspace) return;
    const item = await this.#queue.claimNext(threadId);
    if (!item) {
      await this.#releaseThread(threadId, client);
      return;
    }
    try {
      const queuedWorkspace = await this.#workspaces.resolveWithRevision(
        item.workspacePath,
      );
      if (
        queuedWorkspace.path !== currentWorkspace.path ||
        queuedWorkspace.revision !== currentWorkspace.revision ||
        queuedWorkspace.revision !==
          (await this.#workspaces.authorizationRevision({ fresh: true }))
      ) {
        throw new Error(
          "Queued workspace changed after the message was enqueued",
        );
      }
      await consumeQueueItemOnce({
        queue: this.#queue,
        repairer: this.#consumptionRepairer,
        item,
        operation: "turn/start",
        onClaimed: () =>
          this.#emit("queue/delivering", { itemId: item.id, threadId }),
        execute: async (clientUserMessageId) => {
          const turnPayload = {
            ...item.turnPayload,
            threadId,
            clientUserMessageId,
          };
          const startTurn = async (): Promise<{ turnId: string }> => {
            const response = await client.request<TurnStartResponse>(
              "turn/start",
              turnPayload,
            );
            return { turnId: response.turn.id };
          };
          if (!hasThreadPermissionUpdate(turnPayload)) return startTurn();
          return this.#threadPermissions.serializeMutation(
            threadId,
            async () => {
              const observation =
                await this.#threadPermissions.beginObservation(threadId);
              const response = await startTurn();
              await this.#threadPermissions.saveSettingsUpdate(
                threadId,
                turnPayload,
                observation,
              );
              return response;
            },
          );
        },
      });
    } catch (error) {
      if (
        error instanceof QueueConsumptionOutcomeIndeterminateError &&
        error.durableOutcome === "indeterminate"
      ) {
        this.#emit("queue/indeterminate", {
          itemId: item.id,
          threadId,
          reason: error.message,
        });
      } else if (
        !(error instanceof QueueConsumptionOutcomeIndeterminateError)
      ) {
        await this.#queue.pause(item.id);
        this.#emit("queue/paused", {
          itemId: item.id,
          threadId,
          reason: error instanceof Error ? error.message : "Queue start failed",
        });
      }
      const paused = await this.#queue.pausePending(threadId);
      for (const remaining of paused) {
        this.#emit("queue/paused", {
          itemId: remaining.id,
          threadId,
          reason: "Queue paused after a start failure",
        });
      }
      await this.#releaseThread(threadId, client);
      return;
    }
    // Keep observers outside the failure path that owns queue state. A
    // synchronous listener exception after completion must never make this
    // permanently consumed item (or following items) look retryable.
    this.#emit("queue/started", { itemId: item.id, threadId });
  }

  async #validateThreadWorkspace(
    threadId: string,
    cwd: string,
    client: CodexAppServerClient,
  ): Promise<{ path: string; revision: number } | undefined> {
    try {
      return await this.#workspaces.resolveWithRevision(cwd);
    } catch {
      const paused = await this.#queue.pausePending(threadId);
      for (const item of paused) {
        this.#emit("queue/paused", {
          itemId: item.id,
          threadId,
          reason: "Workspace is no longer registered or accessible",
        });
      }
      await this.#releaseThread(threadId, client);
      return undefined;
    }
  }

  async #releaseThread(threadId: string, client = this.#client): Promise<void> {
    this.#desiredThreads.delete(threadId);
    if (!client || client.closed) return;
    try {
      await client.request("thread/unsubscribe", { threadId });
    } catch {
      // Subscription cleanup is best-effort. Closing or reconnecting this
      // dedicated dispatcher client also releases all of its subscriptions.
    }
  }

  async #ensureClient(): Promise<CodexAppServerClient> {
    if (this.#client && !this.#client.closed) return this.#client;
    if (this.#clientPromise) return this.#clientPromise;
    this.#clientPromise = this.#connectClient()
      .then((client) => {
        if (this.#closed) {
          void client.close();
          throw new Error("Queue is closed");
        }
        this.#client = client;
        client.on("notification", (notification) => {
          void this.#handleNotification(notification).catch(() =>
            this.#scheduleRetry(),
          );
        });
        client.on("serverRequest", (request) =>
          this.#handleServerRequest(request),
        );
        client.once("close", () => {
          if (this.#client === client) this.#client = undefined;
          this.#serverRequests.clear();
          this.#serverRequestPayloads.clear();
          if (!this.#closed) this.#scheduleRetry();
        });
        return client;
      })
      .finally(() => {
        this.#clientPromise = undefined;
      });
    return this.#clientPromise;
  }

  #serialize(threadId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#threadOperations.get(threadId);
    const current = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#threadOperations.set(threadId, current);
    const cleanup = () => {
      if (this.#threadOperations.get(threadId) === current) {
        this.#threadOperations.delete(threadId);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#retryPendingThreads();
    }, 5_000);
    this.#retryTimer.unref();
  }

  async #retryPendingThreads(): Promise<void> {
    try {
      const items = await this.#queue.list();
      const threadIds = new Set([
        ...this.#desiredThreads,
        ...items
          .filter((item) => item.status === "pending")
          .map((item) => item.threadId),
      ]);
      await Promise.allSettled(
        [...threadIds].map((threadId) => this.watchThread(threadId)),
      );
    } catch {
      this.#scheduleRetry();
    }
  }

  #emit(type: string, payload: Record<string, unknown>): void {
    this.#events.emit("event", { type, payload });
  }
}

function asTurnCompleted(
  value: unknown,
): TurnCompletedNotification | undefined {
  if (!isRecord(value) || typeof value.threadId !== "string") return undefined;
  if (!isRecord(value.turn) || typeof value.turn.status !== "string") {
    return undefined;
  }
  return value as TurnCompletedNotification;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractThreadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.threadId === "string") return value.threadId;
  if (isRecord(value.thread) && typeof value.thread.id === "string") {
    return value.thread.id;
  }
  return undefined;
}

function asPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

function hasThreadPermissionUpdate(payload: Record<string, unknown>): boolean {
  return (
    payload.approvalPolicy != null ||
    payload.approvalsReviewer != null ||
    payload.sandboxPolicy != null
  );
}
