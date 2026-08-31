import { randomUUID } from "node:crypto";

import { Scope, TypedEventBus } from "@codex-everywhere/kernel";
import {
  codexGenericEvent,
  jsonValueSchema,
  type CodexGenericEventPayload,
  type InteractionResponse,
  type JsonValue,
} from "@codex-everywhere/protocol/v2";

import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { isKnownCodexNotification } from "../codex/notification-schema.js";
import {
  InteractionBroker,
  type InteractionBrokerEvents,
  type PendingInteraction,
} from "./interaction-broker.js";

export type ThreadLeaseState = "idle" | "running" | "waiting-input" | "failed";
export type ThreadLeaseReferenceKind = "viewer" | "queue" | "effect";

export type ThreadLeaseEvent =
  | {
      readonly type: "codex/notification";
      readonly method: string;
      readonly params: JsonValue;
    }
  | {
      readonly type: "codex/generic";
      readonly payload: CodexGenericEventPayload;
    }
  | {
      readonly type: "interaction/created";
      readonly interaction: PendingInteraction;
    }
  | {
      readonly type: "interaction/resolved";
      readonly interactionId: string;
    }
  | {
      readonly type: "interaction/failed";
      readonly interactionId: string;
      readonly reason: string;
    }
  | { readonly type: "lease/failed"; readonly reason: string };

interface ThreadLeaseEvents {
  readonly event: ThreadLeaseEvent;
  readonly state: ThreadLeaseState;
}

export interface ThreadLeaseHandle {
  readonly threadId: string;
  readonly lease: ThreadLease;
  release(): Promise<void>;
}

export interface AuthoritativeThreadState {
  readonly thread: JsonValue;
  readonly workspacePath: string;
  readonly state: ThreadLeaseState;
  readonly currentTurnId?: string;
}

export interface ThreadLeaseManagerOptions {
  readonly scope: Scope;
  readonly clientFactory: CodexClientFactoryPort;
  readonly maximumLeases?: number;
}

export class ThreadLeaseCapacityError extends Error {
  constructor(readonly maximumLeases: number) {
    super(`Thread lease capacity reached (${maximumLeases})`);
    this.name = "ThreadLeaseCapacityError";
  }
}

/** One app-server client and interaction broker for one live thread. */
export class ThreadLease {
  readonly threadId: string;
  readonly #scope: Scope;
  readonly #client: CodexClient;
  readonly #interactions = new InteractionBroker();
  readonly #references = new Map<string, number>();
  readonly #events = new TypedEventBus<ThreadLeaseEvents>();
  readonly #onDisposable: (lease: ThreadLease) => void | Promise<void>;
  #state: ThreadLeaseState = "idle";
  #currentTurnId: string | undefined;
  #lastTerminalTurn:
    { readonly id: string; readonly status: string } | undefined;
  #workspacePath: string | undefined;
  #closed = false;

  constructor(input: {
    readonly threadId: string;
    readonly scope: Scope;
    readonly client: CodexClient;
    readonly onDisposable: (lease: ThreadLease) => void | Promise<void>;
  }) {
    this.threadId = input.threadId;
    this.#scope = input.scope;
    this.#client = input.client;
    this.#onDisposable = input.onDisposable;
    this.#scope.defer(
      this.#client.onNotification((event) => this.#notification(event)),
    );
    this.#scope.defer(
      this.#client.onServerRequest((request) => this.#serverRequest(request)),
    );
    this.#scope.defer(this.#client.onClose(() => this.#clientClosed()));
    this.#scope.defer(
      this.#interactions.events.on("created", (interaction) => {
        this.#state = "waiting-input";
        this.#events.emit("state", this.#state);
        this.#events.emit("event", {
          type: "interaction/created",
          interaction,
        });
      }),
    );
    this.#scope.defer(
      this.#interactions.events.on("resolved", ({ interactionId }) => {
        this.#events.emit("event", {
          type: "interaction/resolved",
          interactionId,
        });
        if (this.#interactions.size === 0 && this.#state === "waiting-input") {
          this.#state = "running";
          this.#events.emit("state", this.#state);
        }
        this.#runBackgroundCleanup(() => this.#disposeIfIdle());
      }),
    );
    this.#scope.defer(
      this.#interactions.events.on("failed", ({ interactionId, reason }) => {
        this.#events.emit("event", {
          type: "interaction/failed",
          interactionId,
          reason,
        });
        this.#runBackgroundCleanup(() => this.#disposeIfIdle());
      }),
    );
  }

  get state(): ThreadLeaseState {
    return this.#state;
  }

  get referenceCount(): number {
    return [...this.#references.values()].reduce(
      (total, count) => total + count,
      0,
    );
  }

  get currentTurnId(): string | undefined {
    return this.#currentTurnId;
  }

  terminalTurnStatus(turnId: string): string | undefined {
    return this.#lastTerminalTurn?.id === turnId
      ? this.#lastTerminalTurn.status
      : undefined;
  }

  get workspacePath(): string | undefined {
    return this.#workspacePath;
  }

  get closed(): boolean {
    return this.#closed;
  }

  addReference(kind: ThreadLeaseReferenceKind, id: string): void {
    this.#assertOpen();
    if (id.length === 0) throw new Error("Thread lease reference ID is empty");
    const key = `${kind}:${id}`;
    this.#references.set(key, (this.#references.get(key) ?? 0) + 1);
  }

  async releaseReference(
    kind: ThreadLeaseReferenceKind,
    id: string,
  ): Promise<void> {
    const key = `${kind}:${id}`;
    const count = this.#references.get(key) ?? 0;
    if (count <= 1) this.#references.delete(key);
    else this.#references.set(key, count - 1);
    await this.#disposeIfIdle();
  }

  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    this.#assertOpen();
    return this.#client.request(method, params);
  }

  async synchronize(includeTurns = true): Promise<AuthoritativeThreadState> {
    this.#assertOpen();
    const response = jsonValueSchema.parse(
      await this.#client.request("thread/read", {
        threadId: this.threadId,
        includeTurns,
      }),
    );
    const thread = requiredNestedObject(response, "thread");
    return this.adoptAuthoritativeThread(thread);
  }

  adoptAuthoritativeThread(
    thread: Readonly<Record<string, JsonValue>>,
  ): AuthoritativeThreadState {
    this.#assertOpen();
    if (thread.id !== this.threadId) {
      throw new Error("App-server returned a different thread");
    }
    if (typeof thread.cwd !== "string" || thread.cwd.length === 0) {
      throw new Error("App-server thread has no working directory");
    }
    this.#workspacePath = thread.cwd;
    const status = nestedObjectString(thread.status, "type");
    this.#state =
      status === "active"
        ? this.#interactions.size > 0
          ? "waiting-input"
          : "running"
        : status === "systemError"
          ? "failed"
          : "idle";
    this.#currentTurnId = activeTurnId(thread.turns);
    this.#events.emit("state", this.#state);
    return {
      thread,
      workspacePath: this.#workspacePath,
      state: this.#state,
      ...(this.#currentTurnId === undefined
        ? {}
        : { currentTurnId: this.#currentTurnId }),
    };
  }

  noteTurnStarted(turnId: string): void {
    this.#assertOpen();
    if (turnId.length === 0) throw new Error("Turn ID is empty");
    // A very short turn may complete before its turn/start response reaches
    // the caller. Never regress that authoritative terminal notification.
    if (this.terminalTurnStatus(turnId) !== undefined) return;
    const next = this.#interactions.size > 0 ? "waiting-input" : "running";
    const changed = this.#state !== next;
    this.#state = next;
    this.#currentTurnId = turnId;
    if (changed) this.#events.emit("state", this.#state);
  }

  listInteractions(): PendingInteraction[] {
    return this.#interactions.list();
  }

  respondToInteraction(
    interactionId: string,
    response: InteractionResponse,
  ): Promise<void> {
    this.#assertOpen();
    return this.#interactions.respond(interactionId, response);
  }

  onEvent(listener: (event: ThreadLeaseEvent) => void): () => void {
    return this.#events.on("event", listener);
  }

  onState(listener: (state: ThreadLeaseState) => void): () => void {
    return this.#events.on("state", listener);
  }

  async close(reason = "lease-closed"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#interactions.failAll(reason);
    await this.#scope.close(reason);
  }

  #notification(notification: CodexNotification): void {
    if (!notificationBelongsToThread(notification.params, this.threadId))
      return;
    const params = jsonValueSchema.safeParse(notification.params);
    if (!params.success) {
      this.#events.emit("event", {
        type: "codex/generic",
        payload: codexGenericEvent(notification.method, null),
      });
      return;
    }
    this.#updateState(notification.method, params.data);
    if (isKnownCodexNotification(notification)) {
      this.#events.emit("event", {
        type: "codex/notification",
        method: notification.method,
        params: params.data,
      });
    } else {
      this.#events.emit("event", {
        type: "codex/generic",
        payload: codexGenericEvent(notification.method, params.data),
      });
    }
  }

  #serverRequest(request: CodexServerRequest): void {
    try {
      this.#interactions.add(request, this.threadId);
    } catch (error) {
      if (requestThreadId(request.params) === this.threadId) {
        try {
          request.reject({
            code: -32_000,
            message: "Unsupported or invalid interactive request",
          });
        } catch {
          // The app-server callback may already have been rejected by broker validation.
        }
      }
    }
  }

  #clientClosed(): void {
    if (this.#closed) return;
    this.#state = "failed";
    this.#events.emit("state", this.#state);
    this.#interactions.failAll("app-server-client-closed");
    this.#events.emit("event", {
      type: "lease/failed",
      reason: "app-server-client-closed",
    });
    this.#runBackgroundCleanup(() => this.#onDisposable(this));
  }

  #updateState(method: string, params: JsonValue): void {
    const previous = this.#state;
    if (method === "turn/started") {
      this.#state = "running";
      this.#currentTurnId = nestedId(params, "turn") ?? this.#currentTurnId;
    }
    if (method === "turn/completed") {
      this.#state = this.#interactions.size > 0 ? "waiting-input" : "idle";
      const completedTurnId = nestedId(params, "turn");
      const completedTurnStatus = nestedString(params, "turn", "status");
      if (completedTurnId !== undefined && completedTurnStatus !== undefined) {
        this.#lastTerminalTurn = {
          id: completedTurnId,
          status: completedTurnStatus,
        };
      }
      if (
        completedTurnId === undefined ||
        completedTurnId === this.#currentTurnId
      ) {
        this.#currentTurnId = undefined;
      }
    }
    if (method === "thread/status/changed") {
      const status = nestedStatusType(params);
      if (status === "idle" || status === "notLoaded") this.#state = "idle";
      if (status === "active") this.#state = "running";
      if (status === "systemError") this.#state = "failed";
    }
    if (this.#state !== previous) this.#events.emit("state", this.#state);
    this.#runBackgroundCleanup(() => this.#disposeIfIdle());
  }

  async #disposeIfIdle(): Promise<void> {
    if (
      !this.#closed &&
      this.#state === "idle" &&
      this.#references.size === 0 &&
      this.#interactions.size === 0
    ) {
      await this.#onDisposable(this);
    }
  }

  /** Observe callback-triggered disposal without leaking a rejected promise. */
  #runBackgroundCleanup(cleanup: () => void | Promise<void>): void {
    void Promise.resolve()
      .then(cleanup)
      .then(undefined, () => {
        this.#state = "failed";
        try {
          this.#events.emit("state", this.#state);
        } catch {
          // Cleanup containment must not create another unhandled rejection.
        }
        try {
          this.#events.emit("event", {
            type: "lease/failed",
            reason: "lease-disposal-failed",
          });
        } catch {
          // Event listeners cannot make background containment reject.
        }
      });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Thread lease is closed");
  }
}

export class ThreadLeaseManager {
  readonly #scope: Scope;
  readonly #factory: CodexClientFactoryPort;
  readonly #maximumLeases: number;
  readonly #leases = new Map<string, ThreadLease>();
  readonly #creating = new Map<string, Promise<ThreadLease>>();
  readonly #disposing = new Map<string, Promise<void>>();
  readonly #starting = new Set<Scope>();
  #closed = false;

  constructor(options: ThreadLeaseManagerOptions) {
    this.#scope = options.scope.fork("thread-leases");
    this.#factory = options.clientFactory;
    this.#maximumLeases = options.maximumLeases ?? 128;
    if (
      !Number.isSafeInteger(this.#maximumLeases) ||
      this.#maximumLeases <= 0
    ) {
      throw new Error("Thread lease capacity must be positive");
    }
    this.#scope.defer(async () => {
      this.#closed = true;
      const leases = [...this.#leases.values()];
      const disposals = [...this.#disposing.values()];
      this.#leases.clear();
      this.#disposing.clear();
      await Promise.allSettled([
        ...leases.map((lease) => lease.close("manager-closed")),
        ...disposals,
      ]);
    });
  }

  get size(): number {
    return this.#leases.size;
  }

  get busyThreadIds(): readonly string[] {
    return [...this.#leases.values()]
      .filter(
        (lease) => lease.state === "running" || lease.state === "waiting-input",
      )
      .map((lease) => lease.threadId)
      .sort();
  }

  async acquire(
    threadId: string,
    reference: { readonly kind: ThreadLeaseReferenceKind; readonly id: string },
    ownerScope?: Scope,
  ): Promise<ThreadLeaseHandle> {
    if (this.#closed) throw new Error("Thread lease manager is closed");
    if (threadId.length === 0) throw new Error("Thread ID is empty");
    const lease = await this.#getOrCreate(threadId);
    return this.#attachReference(lease, reference, ownerScope);
  }

  /**
   * Starts a thread on a provisional client and binds that same client to the
   * resulting lease before the first turn can emit interactions.
   */
  async start<Result>(
    initialize: (
      client: CodexClient,
    ) => Promise<{ readonly threadId: string; readonly result: Result }>,
    reference: { readonly kind: ThreadLeaseReferenceKind; readonly id: string },
    ownerScope?: Scope,
  ): Promise<{ readonly handle: ThreadLeaseHandle; readonly result: Result }> {
    if (this.#closed) throw new Error("Thread lease manager is closed");
    this.#assertCapacity();
    const scope = this.#scope.fork(`thread-start-${randomUUID()}`);
    this.#starting.add(scope);
    let lease: ThreadLease | undefined;
    try {
      const client = await this.#factory.create(scope);
      const initialized = await initialize(client);
      if (initialized.threadId.length === 0) {
        throw new Error("Started thread ID is empty");
      }
      if (this.#closed) throw new Error("Thread lease manager is closed");
      const disposal = this.#disposing.get(initialized.threadId);
      if (disposal !== undefined) await disposal;
      if (this.#closed) throw new Error("Thread lease manager is closed");
      if (
        this.#leases.has(initialized.threadId) ||
        this.#creating.has(initialized.threadId)
      ) {
        throw new Error("Started thread already has a lease");
      }
      lease = new ThreadLease({
        threadId: initialized.threadId,
        scope,
        client,
        onDisposable: (candidate) => this.#dispose(candidate),
      });
      this.#leases.set(initialized.threadId, lease);
      this.#starting.delete(scope);
      const handle = await this.#attachReference(lease, reference, ownerScope);
      return { handle, result: initialized.result };
    } catch (error) {
      if (lease !== undefined && this.#leases.get(lease.threadId) === lease) {
        this.#leases.delete(lease.threadId);
      }
      await scope.close("thread-start-failed").catch(() => undefined);
      throw error;
    } finally {
      this.#starting.delete(scope);
    }
  }

  async #attachReference(
    lease: ThreadLease,
    reference: { readonly kind: ThreadLeaseReferenceKind; readonly id: string },
    ownerScope?: Scope,
  ): Promise<ThreadLeaseHandle> {
    lease.addReference(reference.kind, reference.id);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await lease.releaseReference(reference.kind, reference.id);
    };
    if (ownerScope !== undefined) {
      try {
        ownerScope.defer(release);
      } catch (error) {
        await release();
        throw error;
      }
    }
    return { threadId: lease.threadId, lease, release };
  }

  get(threadId: string): ThreadLease | undefined {
    return this.#leases.get(threadId);
  }

  async closeThread(threadId: string, reason = "thread-closed"): Promise<void> {
    const lease = this.#leases.get(threadId);
    if (lease === undefined) return;
    this.#leases.delete(threadId);
    await lease.close(reason);
  }

  async close(): Promise<void> {
    await this.#scope.close("manager-closed");
  }

  async #getOrCreate(threadId: string): Promise<ThreadLease> {
    const disposal = this.#disposing.get(threadId);
    if (disposal !== undefined) {
      await disposal;
      if (this.#closed) throw new Error("Thread lease manager is closed");
    }
    const current = this.#leases.get(threadId);
    if (current !== undefined) return current;
    const pending = this.#creating.get(threadId);
    if (pending !== undefined) return pending;
    this.#assertCapacity();
    const creation = this.#create(threadId).finally(() => {
      if (this.#creating.get(threadId) === creation)
        this.#creating.delete(threadId);
    });
    this.#creating.set(threadId, creation);
    return creation;
  }

  #assertCapacity(): void {
    if (
      this.#leases.size +
        this.#creating.size +
        this.#disposing.size +
        this.#starting.size >=
      this.#maximumLeases
    ) {
      throw new ThreadLeaseCapacityError(this.#maximumLeases);
    }
  }

  async #create(threadId: string): Promise<ThreadLease> {
    const scope = this.#scope.fork(`thread-${threadId}`);
    try {
      const client = await this.#factory.create(scope);
      const lease = new ThreadLease({
        threadId,
        scope,
        client,
        onDisposable: (candidate) => this.#dispose(candidate),
      });
      this.#leases.set(threadId, lease);
      return lease;
    } catch (error) {
      await scope.close("lease-creation-failed");
      throw error;
    }
  }

  async #dispose(lease: ThreadLease): Promise<void> {
    if (this.#leases.get(lease.threadId) !== lease) {
      await this.#disposing.get(lease.threadId);
      return;
    }
    this.#leases.delete(lease.threadId);
    const disposal = lease.close().finally(() => {
      if (this.#disposing.get(lease.threadId) === disposal) {
        this.#disposing.delete(lease.threadId);
      }
    });
    this.#disposing.set(lease.threadId, disposal);
    await disposal;
  }
}

function notificationBelongsToThread(
  params: unknown,
  threadId: string,
): boolean {
  return requestThreadId(params) === threadId;
}

function requestThreadId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  if (typeof record.threadId === "string") return record.threadId;
  if (
    typeof record.thread === "object" &&
    record.thread !== null &&
    !Array.isArray(record.thread) &&
    typeof (record.thread as Record<string, unknown>).id === "string"
  ) {
    return (record.thread as Record<string, unknown>).id as string;
  }
  return undefined;
}

function nestedStatusType(params: JsonValue): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const status = (params as Readonly<Record<string, JsonValue>>).status;
  if (typeof status !== "object" || status === null || Array.isArray(status)) {
    return undefined;
  }
  const statusRecord = status as Readonly<Record<string, JsonValue>>;
  return typeof statusRecord.type === "string" ? statusRecord.type : undefined;
}

function nestedId(params: JsonValue, field: string): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const nested = (params as Readonly<Record<string, JsonValue>>)[field];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return undefined;
  }
  const id = (nested as Readonly<Record<string, JsonValue>>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function nestedString(
  params: JsonValue,
  field: string,
  nestedField: string,
): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const nested = (params as Readonly<Record<string, JsonValue>>)[field];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return undefined;
  }
  const value = (nested as Readonly<Record<string, JsonValue>>)[nestedField];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredNestedObject(
  value: JsonValue,
  field: string,
): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("App-server response must be an object");
  }
  const nested = (value as Readonly<Record<string, JsonValue>>)[field];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    throw new Error(`App-server response has no ${field}`);
  }
  return nested as Readonly<Record<string, JsonValue>>;
}

function nestedObjectString(
  value: JsonValue | undefined,
  field: string,
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("App-server thread status is invalid");
  }
  const nested = (value as Readonly<Record<string, JsonValue>>)[field];
  if (typeof nested !== "string") {
    throw new Error("App-server thread status type is invalid");
  }
  return nested;
}

function activeTurnId(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const turn = value[index];
    if (typeof turn !== "object" || turn === null || Array.isArray(turn)) {
      continue;
    }
    if (turn.status === "inProgress" && typeof turn.id === "string") {
      return turn.id;
    }
  }
  return undefined;
}
