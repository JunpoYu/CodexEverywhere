import { EventEmitter } from "node:events";

import type {
  ThreadReadResponse,
  ThreadResumeResponse,
  TurnCompletedNotification,
} from "@codex-everywhere/codex-app-server-schema/v2";

import { QueueRegistry } from "../host/queue.js";
import { WorkspaceRegistry } from "../host/workspaces.js";
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest,
} from "./codex-app-server-client.js";

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
  readonly #connectClient: () => Promise<CodexAppServerClient>;
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
    connectClient(): Promise<CodexAppServerClient>;
  }) {
    this.#queue = options.queue;
    this.#workspaces = options.workspaces;
    this.#connectClient = options.connectClient;
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

  respondToServerRequest(input: {
    requestId: string;
    result?: unknown;
    error?: { code: number; message: string };
  }): boolean {
    const pending = this.#serverRequests.get(input.requestId);
    if (!pending) return false;
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
  }

  async #subscribeAndDrain(threadId: string): Promise<void> {
    try {
      const client = await this.#ensureClient();
      const read = await client.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: false,
      });
      await this.#workspaces.resolve(read.thread.cwd);
      const resumed = await client.request<ThreadResumeResponse>(
        "thread/resume",
        { threadId },
      );
      await this.#workspaces.resolve(resumed.thread.cwd);
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
    const item = await this.#queue.claimNext(threadId);
    if (!item) {
      await this.#releaseThread(threadId, client);
      return;
    }
    try {
      await client.request("turn/start", {
        ...item.turnPayload,
        threadId,
      });
      await this.#queue.finish(item.id);
      this.#emit("queue/started", { itemId: item.id, threadId });
    } catch (error) {
      await this.#queue.pause(item.id);
      this.#emit("queue/paused", {
        itemId: item.id,
        threadId,
        reason: error instanceof Error ? error.message : "Queue start failed",
      });
      const paused = await this.#queue.pausePending(threadId);
      for (const remaining of paused) {
        this.#emit("queue/paused", {
          itemId: remaining.id,
          threadId,
          reason: "Queue paused after a start failure",
        });
      }
      await this.#releaseThread(threadId, client);
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
