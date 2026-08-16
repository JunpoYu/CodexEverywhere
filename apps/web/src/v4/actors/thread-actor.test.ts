import { Scope } from "@codex-everywhere/kernel";
import {
  gatewayEventEnvelopeV2,
  type GatewayEventEnvelopeV2,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayPort } from "../gateway/gateway-port.js";
import { createThreadActor } from "./thread-actor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
});

describe("v0.4 thread actor", () => {
  it("keeps only the latest thread/open result", async () => {
    const gateway = new DeferredThreadGateway();
    const scope = new Scope("thread-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, gateway);

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });
    actor.dispatch({ type: "OPEN", threadId: "thread-b" });
    gateway.resolve("thread-a", snapshot("thread-a"));
    await Promise.resolve();
    expect(actor.getSnapshot().threadId).toBe("thread-b");

    gateway.resolve("thread-b", snapshot("thread-b"));
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("idle"));
    expect(actor.getSnapshot().snapshot?.thread.id).toBe("thread-b");
  });

  it("shows an interaction for the open thread and ignores another thread", () => {
    const scope = new Scope("interaction-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, new DeferredThreadGateway());
    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });

    actor.dispatch({
      type: "GATEWAY_EVENT",
      event: interactionEvent("thread-b", "interaction-b"),
    });
    expect(actor.getSnapshot().snapshot?.interactions).toHaveLength(0);

    actor.dispatch({
      type: "GATEWAY_EVENT",
      event: interactionEvent("thread-a", "interaction-a"),
    });
    expect(actor.getSnapshot()).toMatchObject({ status: "waiting-input" });
    expect(actor.getSnapshot().snapshot?.interactions[0]?.id).toBe(
      "interaction-a",
    );
  });

  it("keeps the authoritative snapshot visible while refreshing the same task", () => {
    const scope = new Scope("thread-refresh-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, new DeferredThreadGateway());
    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });

    expect(actor.getSnapshot()).toMatchObject({
      status: "syncing",
      threadId: "thread-a",
      snapshot: { thread: { id: "thread-a" } },
    });
  });

  it("does not cancel thread/open when an unrelated Gateway event arrives", async () => {
    const gateway = new DeferredThreadGateway();
    const scope = new Scope("thread-event-race-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, gateway);

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });
    actor.dispatch({
      type: "GATEWAY_EVENT",
      event: interactionEvent("thread-b", "interaction-b"),
    });

    expect(gateway.signal?.aborted).toBe(false);
    gateway.resolve("thread-a", snapshot("thread-a"));
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("idle"));
    expect(actor.getSnapshot().threadId).toBe("thread-a");
  });

  it("keeps an unknown Codex event across an authoritative refresh", () => {
    const scope = new Scope("thread-generic-event-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, new DeferredThreadGateway());
    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });
    actor.dispatch({
      type: "GATEWAY_EVENT",
      event: gatewayEventEnvelopeV2("codex/generic", {
        version: 1,
        threadId: "thread-a",
        method: "future/item/progress",
        params: { value: 2 },
      }),
    });

    const generic = actor.getSnapshot().snapshot?.items[0];
    expect(generic).toMatchObject({
      type: "generic",
      data: {
        source: "codex/generic",
        method: "future/item/progress",
        params: { value: 2 },
      },
    });

    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });
    expect(actor.getSnapshot().snapshot?.items).toContainEqual(generic);
  });
});

class DeferredThreadGateway implements GatewayPort {
  readonly #pending = new Map<
    string,
    (value: OutputOf<"thread/open">) => void
  >();
  signal: AbortSignal | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "thread/open") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.signal = options.signal;
    const threadId = (input as InputOf<"thread/open">).threadId;
    return new Promise<OutputOf<"thread/open">>((resolve) => {
      this.#pending.set(threadId, resolve);
    }) as Promise<OutputOf<Method>>;
  }

  resolve(threadId: string, value: OutputOf<"thread/open">): void {
    const resolve = this.#pending.get(threadId);
    if (resolve === undefined) throw new Error("Thread request is not pending");
    this.#pending.delete(threadId);
    resolve(value);
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

function snapshot(threadId: string): OutputOf<"thread/open"> {
  const now = "2026-08-16T00:00:00.000Z";
  return {
    version: 1,
    thread: {
      version: 1,
      id: threadId,
      workspaceId: "workspace-1",
      title: threadId,
      state: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
    },
    state: "idle",
    items: [],
    interactions: [],
    hasEarlierHistory: false,
    settings: { version: 1, revision: 0 },
  };
}

function interactionEvent(
  threadId: string,
  interactionId: string,
): GatewayEventEnvelopeV2 {
  return gatewayEventEnvelopeV2("interaction/created", {
    version: 1,
    interaction: {
      version: 1,
      id: interactionId,
      threadId,
      kind: "approval",
      requestMethod: "item/commandExecution/requestApproval",
      createdAt: "2026-08-16T00:00:00.000Z",
      payload: { reason: "test" },
    },
  });
}
