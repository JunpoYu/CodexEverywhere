import { randomUUID } from "node:crypto";

import { Scope, TypedEventBus } from "@codex-everywhere/kernel";
import type {
  GatewayAccess,
  GatewayEventEnvelopeV2,
  GatewayRequestContext,
  JsonValue,
} from "@codex-everywhere/protocol/v2";
import { gatewayEventEnvelopeV2 } from "@codex-everywhere/protocol/v2";

import type {
  ThreadLeaseHandle,
  ThreadLeaseManager,
} from "../services/thread-lease-manager.js";
import type {
  GatewayDeviceBinding,
  IdentityGatewayContext,
  IdentityGatewaySession,
} from "./identity-gateway-context.js";

export interface AgentGatewaySessionOptions {
  readonly parentScope: Scope;
  readonly leases: ThreadLeaseManager;
  readonly id?: string;
  readonly access?: GatewayAccess;
  readonly principalId?: string;
  readonly temporary?: boolean;
  readonly device?: GatewayDeviceBinding;
  readonly subscribeGlobalEvents?: (
    listener: (event: GatewayEventEnvelopeV2) => void,
  ) => () => void;
  readonly assertDeviceCurrent?: () => void | Promise<void>;
}

export type AgentGatewaySessionConfiguration = Omit<
  AgentGatewaySessionOptions,
  "parentScope" | "leases"
>;

export class AgentGatewaySession implements IdentityGatewaySession {
  readonly id: string;
  readonly scope: Scope;
  readonly #leases: ThreadLeaseManager;
  readonly #threads = new Map<
    string,
    { readonly handle: ThreadLeaseHandle; readonly scope: Scope }
  >();
  readonly #opening = new Map<string, Promise<ThreadLeaseHandle>>();
  readonly #closing = new Map<string, Promise<void>>();
  readonly #events = new TypedEventBus<{
    readonly event: GatewayEventEnvelopeV2;
  }>();
  readonly device: GatewayDeviceBinding | undefined;
  readonly #assertDeviceCurrent: (() => void | Promise<void>) | undefined;
  #access: GatewayAccess;
  #principalId: string;
  #temporary: boolean;

  constructor(input: AgentGatewaySessionOptions) {
    this.id = input.id ?? randomUUID();
    this.scope = input.parentScope.fork(`gateway-session-${this.id}`);
    this.#leases = input.leases;
    this.#access = input.access ?? "pre-auth";
    this.#principalId = input.principalId ?? `pre-auth:${this.id}`;
    this.#temporary = input.temporary ?? true;
    this.device = input.device;
    this.#assertDeviceCurrent = input.assertDeviceCurrent;
    if (input.subscribeGlobalEvents !== undefined) {
      this.scope.defer(
        input.subscribeGlobalEvents((event) => {
          if (this.#access === "user") this.#publish(event);
        }),
      );
    }
    this.scope.defer(() => {
      this.#closing.clear();
      this.#opening.clear();
      this.#threads.clear();
    });
  }

  get access(): GatewayAccess {
    return this.#access;
  }

  get principalId(): string {
    return this.#principalId;
  }

  get temporary(): boolean {
    return this.#temporary;
  }

  async assertCurrent(): Promise<void> {
    this.scope.throwIfClosed();
    if (this.#access === "user" && !this.#temporary) {
      await this.#assertDeviceCurrent?.();
    }
  }

  authenticate(input: {
    readonly access: "user" | "admin";
    readonly principalId: string;
    readonly temporary: boolean;
  }): void {
    this.scope.throwIfClosed();
    if (input.access !== "user") {
      throw new Error("Agent session cannot authenticate an administrator");
    }
    this.#access = "user";
    this.#principalId = input.principalId;
    this.#temporary = input.temporary;
  }

  async openThread(threadId: string): Promise<ThreadLeaseHandle> {
    const closing = this.#closing.get(threadId);
    if (closing !== undefined) {
      await closing;
      return this.openThread(threadId);
    }
    const pending = this.#opening.get(threadId);
    if (pending !== undefined) return pending;
    const existing = this.#threads.get(threadId);
    if (existing !== undefined && !existing.handle.lease.closed) {
      return existing.handle;
    }
    const opening = this.#openThread(threadId, existing).finally(() => {
      if (this.#opening.get(threadId) === opening) {
        this.#opening.delete(threadId);
      }
    });
    this.#opening.set(threadId, opening);
    return opening;
  }

  async #openThread(
    threadId: string,
    stale:
      { readonly handle: ThreadLeaseHandle; readonly scope: Scope } | undefined,
  ): Promise<ThreadLeaseHandle> {
    if (stale !== undefined) {
      if (this.#threads.get(threadId) === stale) {
        this.#threads.delete(threadId);
      }
      await stale.scope.close("thread-lease-disposed");
    }
    const threadScope = this.scope.fork(`thread-view-${threadId}`);
    try {
      const handle = await this.#leases.acquire(
        threadId,
        { kind: "viewer", id: this.id },
        threadScope,
      );
      threadScope.defer(
        handle.lease.onEvent((event) => this.#threadEvent(threadId, event)),
      );
      threadScope.defer(
        handle.lease.onState((state) => {
          this.#publish(
            gatewayEventEnvelopeV2("thread/state", {
              version: 1,
              threadId,
              state,
              ...(handle.lease.currentTurnId === undefined
                ? {}
                : { currentTurnId: handle.lease.currentTurnId }),
            }),
          );
        }),
      );
      this.#threads.set(threadId, { handle, scope: threadScope });
      return handle;
    } catch (error) {
      await threadScope.close("thread-open-failed");
      throw error;
    }
  }

  requireThread(threadId: string): ThreadLeaseHandle {
    const opened = this.#threads.get(threadId);
    if (opened === undefined) {
      throw new Error("Task must be opened by this Gateway session first");
    }
    return opened.handle;
  }

  async closeThread(threadId: string): Promise<void> {
    const current = this.#closing.get(threadId);
    if (current !== undefined) return current;
    const closing = this.#closeThread(threadId).finally(() => {
      if (this.#closing.get(threadId) === closing) {
        this.#closing.delete(threadId);
      }
    });
    this.#closing.set(threadId, closing);
    return closing;
  }

  async #closeThread(threadId: string): Promise<void> {
    const pending = this.#opening.get(threadId);
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        return;
      }
    }
    const opened = this.#threads.get(threadId);
    if (opened === undefined) return;
    this.#threads.delete(threadId);
    await opened.scope.close("thread-view-closed");
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return this.#events.on("event", listener);
  }

  async close(): Promise<void> {
    await this.scope.close("gateway-session-closed");
  }

  #threadEvent(
    threadId: string,
    event: Parameters<Parameters<ThreadLeaseHandle["lease"]["onEvent"]>[0]>[0],
  ): void {
    switch (event.type) {
      case "codex/notification":
        this.#publish(
          gatewayEventEnvelopeV2("codex/notification", {
            version: 1,
            threadId,
            method: event.method,
            params: event.params,
          }),
        );
        return;
      case "codex/generic":
        this.#publish(
          gatewayEventEnvelopeV2("codex/generic", {
            version: 1,
            threadId,
            method: event.payload.method,
            params: event.payload.params,
          }),
        );
        return;
      case "interaction/created":
        this.#publish(
          gatewayEventEnvelopeV2("interaction/created", {
            version: 1,
            interaction: event.interaction,
          }),
        );
        return;
      case "interaction/resolved":
        this.#publish(
          gatewayEventEnvelopeV2("interaction/resolved", {
            version: 1,
            threadId,
            interactionId: event.interactionId,
          }),
        );
        return;
      case "interaction/failed":
        this.#publish(
          gatewayEventEnvelopeV2("interaction/failed", {
            version: 1,
            threadId,
            interactionId: event.interactionId,
            reason: event.reason,
          }),
        );
        return;
      case "lease/failed":
        this.#publish(
          gatewayEventEnvelopeV2("thread/lease/failed", {
            version: 1,
            threadId,
            reason: event.reason,
          }),
        );
    }
  }

  #publish(event: GatewayEventEnvelopeV2<JsonValue>): void {
    try {
      this.#events.emit("event", event);
    } catch {
      // A transport subscriber is scoped to this session and cannot affect Codex.
    }
  }
}

export interface AgentGatewayContext extends IdentityGatewayContext {
  readonly session: AgentGatewaySession;
  readonly temporary: boolean;
}

export function agentGatewayContext(input: {
  readonly capabilities?: ReadonlySet<string>;
  readonly session: AgentGatewaySession;
}): AgentGatewayContext {
  return {
    get access() {
      return input.session.access;
    },
    get principalId() {
      return input.session.principalId;
    },
    capabilities: input.capabilities ?? new Set(),
    signal: input.session.scope.signal,
    assertCurrent: () => input.session.assertCurrent(),
    session: input.session,
    get temporary() {
      return input.session.temporary;
    },
  };
}
