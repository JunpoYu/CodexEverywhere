import { Scope } from "@codex-everywhere/kernel";
import type {
  GatewayEventEnvelopeV2,
  GatewayMethodName,
  InputOf,
  OutputOf,
  RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayPort } from "../gateway/gateway-port.js";
import { createQueueActor } from "./queue-actor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
});

describe("v0.4 queue actor", () => {
  it("keeps the mutation effect alive when queue/changed precedes the response", async () => {
    const gateway = new DelayedQueueGateway();
    const scope = new Scope("queue-event-race-test");
    scopes.push(scope);
    const actor = createQueueActor(scope, gateway);

    actor.dispatch({ type: "LOADED", items: [] });
    actor.dispatch({ type: "ADD", threadId: "thread-1", text: "next task" });
    actor.dispatch({ type: "CHANGED", item: queueItem() });

    expect(gateway.signal?.aborted).toBe(false);
    gateway.resolve();
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    expect(actor.getSnapshot().items).toEqual([queueItem()]);
  });

  it("does not cancel an in-flight mutation when refresh is requested", async () => {
    const gateway = new DelayedQueueGateway();
    const scope = new Scope("queue-refresh-race-test");
    scopes.push(scope);
    const actor = createQueueActor(scope, gateway);

    actor.dispatch({ type: "LOADED", items: [] });
    actor.dispatch({ type: "ADD", threadId: "thread-1", text: "next task" });
    actor.dispatch({ type: "LOAD" });

    expect(gateway.signal?.aborted).toBe(false);
    expect(gateway.methods).toEqual(["queue/add"]);
    gateway.resolve();
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
  });

  it("keeps reconciliation alive and enables refresh only after manual review", async () => {
    const gateway = new DelayedStatusGateway();
    const scope = new Scope("queue-reconciliation-refresh-test");
    scopes.push(scope);
    const actor = createQueueActor(scope, gateway);

    actor.dispatch({ type: "LOADED", items: [] });
    actor.dispatch({ type: "RECONCILE", operationKey: "operation-1" });
    await vi.waitFor(() =>
      expect(actor.getSnapshot().status).toBe("reconciling"),
    );
    actor.dispatch({ type: "LOAD" });

    expect(gateway.statusSignal?.aborted).toBe(false);
    expect(gateway.methods).toEqual(["mutation/status"]);

    gateway.resolveStatus();
    await vi.waitFor(() =>
      expect(actor.getSnapshot().status).toBe("indeterminate"),
    );
    actor.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    expect(gateway.methods).toEqual(["mutation/status", "queue/list"]);
  });
});

class DelayedQueueGateway implements GatewayPort {
  signal: AbortSignal | undefined;
  readonly methods: string[] = [];
  #resolve: (() => void) | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    this.methods.push(method);
    if (method !== "queue/add") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.signal = options.signal;
    return new Promise<void>((resolve) => {
      this.#resolve = resolve;
    }).then(() => ({ version: 1, item: queueItem() }) as OutputOf<Method>);
  }

  resolve(): void {
    this.#resolve?.();
  }

  onEvent(_listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return () => undefined;
  }

  onConnectionLost(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {}
}

class DelayedStatusGateway implements GatewayPort {
  statusSignal: AbortSignal | undefined;
  readonly methods: string[] = [];
  #resolveStatus: (() => void) | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    this.methods.push(method);
    if (method === "queue/list") {
      return Promise.resolve({
        version: 1,
        items: [],
      }) as Promise<OutputOf<Method>>;
    }
    if (method !== "mutation/status") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.statusSignal = options.signal;
    return new Promise<void>((resolve) => {
      this.#resolveStatus = resolve;
    }).then(
      () =>
        ({
          version: 1,
          status: "indeterminate",
          method: "queue/add",
          updatedAt: "2026-08-22T00:00:00.000Z",
        }) as OutputOf<Method>,
    );
  }

  resolveStatus(): void {
    this.#resolveStatus?.();
  }

  onEvent(_listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return () => undefined;
  }

  onConnectionLost(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {}
}

function queueItem(): OutputOf<"queue/add">["item"] {
  return {
    version: 1,
    id: "queue-1",
    threadId: "thread-1",
    text: "next task",
    status: "pending",
    createdAt: "2026-08-16T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
    revision: 1,
  };
}
