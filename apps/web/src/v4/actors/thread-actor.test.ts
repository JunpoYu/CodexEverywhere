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
  it("requests only one bounded latest page when opening a task", async () => {
    const gateway = new DeferredThreadGateway();
    const scope = new Scope("thread-page-size-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, gateway);

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });

    await vi.waitFor(() => expect(gateway.openInputs).toHaveLength(1));
    expect(gateway.openInputs[0]).toMatchObject({
      threadId: "thread-a",
      historyLimit: 50,
    });
  });

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

  it("closes the visible task after an older open finishes last", async () => {
    const gateway = new DeferredThreadGateway();
    const scope = new Scope("thread-stale-cleanup-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, gateway);

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });
    actor.dispatch({ type: "OPEN", threadId: "thread-b" });
    await vi.waitFor(() => expect(gateway.hasPending("thread-b")).toBe(true));
    gateway.resolve("thread-b", snapshot("thread-b"));
    await vi.waitFor(() =>
      expect(actor.getSnapshot().snapshot?.thread.id).toBe("thread-b"),
    );
    gateway.resolve("thread-a", snapshot("thread-a"));
    await Promise.resolve();

    actor.dispatch({ type: "CLOSE" });
    await vi.waitFor(() =>
      expect(gateway.closedThreadIds).toEqual(["thread-a", "thread-b"]),
    );
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

  it("keeps the operational state while refreshing the same task", async () => {
    const scope = new Scope("thread-refresh-test");
    scopes.push(scope);
    const gateway = new DeferredThreadGateway();
    const actor = createThreadActor(scope, gateway);
    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });

    expect(actor.getSnapshot()).toMatchObject({
      status: "idle",
      refreshing: true,
      threadId: "thread-a",
      snapshot: { thread: { id: "thread-a" } },
    });

    gateway.resolve("thread-a", snapshot("thread-a"));
    await vi.waitFor(() =>
      expect(actor.getSnapshot()).toMatchObject({
        status: "idle",
        refreshing: false,
      }),
    );
  });

  it("coalesces a refresh requested during an active refresh into one trailing read", async () => {
    const scope = new Scope("thread-trailing-refresh-test");
    scopes.push(scope);
    const gateway = new DeferredThreadGateway();
    const actor = createThreadActor(scope, gateway);
    actor.dispatch({
      type: "OPENED",
      snapshot: snapshot("thread-a", ["item-1"]),
    });

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });
    await vi.waitFor(() => expect(gateway.hasPending("thread-a")).toBe(true));
    actor.dispatch({ type: "OPEN", threadId: "thread-a" });
    expect(actor.getSnapshot()).toMatchObject({
      refreshing: true,
      refreshPending: true,
    });

    gateway.resolve("thread-a", snapshot("thread-a", ["item-1", "item-2"]));
    await vi.waitFor(() => expect(gateway.hasPending("thread-a")).toBe(true));
    expect(gateway.openInputs).toHaveLength(2);
    expect(actor.getSnapshot()).toMatchObject({
      refreshing: true,
      refreshPending: false,
    });

    gateway.resolve(
      "thread-a",
      snapshot("thread-a", ["item-1", "item-2", "item-3"]),
    );
    await vi.waitFor(() =>
      expect(actor.getSnapshot()).toMatchObject({
        refreshing: false,
        refreshPending: false,
      }),
    );
    expect(actor.getSnapshot().snapshot?.items.map((item) => item.id)).toEqual([
      "item-1",
      "item-2",
      "item-3",
    ]);
  });

  it("loads earlier history without changing operational state and defers refresh", async () => {
    const scope = new Scope("thread-history-refresh-test");
    scopes.push(scope);
    const gateway = new DeferredThreadGateway();
    const actor = createThreadActor(scope, gateway);
    actor.dispatch({
      type: "OPENED",
      snapshot: snapshot("thread-a", ["item-3", "item-4"], {
        historyCursor: "cursor-3",
        hasEarlierHistory: true,
      }),
    });

    actor.dispatch({ type: "LOAD_EARLIER" });
    await vi.waitFor(() => expect(gateway.historyInputs).toHaveLength(1));
    expect(actor.getSnapshot()).toMatchObject({
      status: "idle",
      historyStatus: "loading",
    });
    expect(gateway.historyInputs[0]).toMatchObject({
      cursor: "cursor-3",
      limit: 50,
    });

    actor.dispatch({ type: "OPEN", threadId: "thread-a" });
    expect(actor.getSnapshot()).toMatchObject({
      refreshing: true,
      refreshPending: true,
      historyStatus: "loading",
    });
    expect(gateway.hasPending("thread-a")).toBe(false);
    expect(gateway.historySignal?.aborted).toBe(false);

    gateway.resolveHistory({
      version: 1,
      items: [timelineItem("item-1"), timelineItem("item-2")],
      hasMore: false,
    });
    await vi.waitFor(() => expect(gateway.hasPending("thread-a")).toBe(true));
    gateway.resolve(
      "thread-a",
      snapshot("thread-a", ["item-3", "item-4", "item-5"]),
    );

    await vi.waitFor(() =>
      expect(actor.getSnapshot()).toMatchObject({
        status: "idle",
        refreshing: false,
        historyStatus: "idle",
      }),
    );
    expect(actor.getSnapshot().snapshot?.items.map((item) => item.id)).toEqual([
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-5",
    ]);
  });

  it("reports history failure without failing the open task", async () => {
    const scope = new Scope("thread-history-failure-test");
    scopes.push(scope);
    const gateway = new DeferredThreadGateway();
    const actor = createThreadActor(scope, gateway);
    actor.dispatch({
      type: "OPENED",
      snapshot: snapshot("thread-a", ["item-2"], {
        historyCursor: "cursor-2",
        hasEarlierHistory: true,
      }),
    });

    actor.dispatch({ type: "LOAD_EARLIER" });
    await vi.waitFor(() => expect(gateway.historyInputs).toHaveLength(1));
    gateway.rejectHistory(new Error("history unavailable"));

    await vi.waitFor(() =>
      expect(actor.getSnapshot()).toMatchObject({
        status: "idle",
        historyStatus: "failed",
        historyError: "history unavailable",
      }),
    );
  });

  it("applies a confirmed settings revision without reopening the task", () => {
    const scope = new Scope("thread-settings-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, new DeferredThreadGateway());
    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });

    actor.dispatch({
      type: "SETTINGS_UPDATED",
      threadId: "thread-a",
      settings: {
        version: 1,
        revision: 1,
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      },
    });

    expect(actor.getSnapshot()).toMatchObject({
      status: "idle",
      refreshing: false,
      snapshot: {
        settings: {
          revision: 1,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
        },
      },
    });

    actor.dispatch({
      type: "SETTINGS_UPDATED",
      threadId: "thread-a",
      settings: {
        version: 1,
        revision: 0,
        sandbox: "read-only",
        approvalPolicy: "untrusted",
      },
    });
    expect(actor.getSnapshot().snapshot?.settings).toMatchObject({
      revision: 1,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
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

  it("replaces pre-compaction history on the next authoritative snapshot", () => {
    const scope = new Scope("thread-compaction-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, new DeferredThreadGateway());
    actor.dispatch({
      type: "OPENED",
      snapshot: snapshot("thread-a", ["old-prefix", "survivor"], {
        historyCursor: "cursor-old",
        hasEarlierHistory: true,
      }),
    });

    actor.dispatch({
      type: "GATEWAY_EVENT",
      event: gatewayEventEnvelopeV2("codex/notification", {
        version: 1,
        threadId: "thread-a",
        method: "thread/compacted",
        params: { threadId: "thread-a" },
      }),
    });
    actor.dispatch({
      type: "OPENED",
      snapshot: snapshot("thread-a", ["survivor", "summary"]),
    });

    expect(actor.getSnapshot().snapshot?.items.map((item) => item.id)).toEqual([
      "survivor",
      "summary",
    ]);
    expect(actor.getSnapshot().snapshot?.historyCursor).toBeUndefined();
    expect(actor.getSnapshot().replaceHistoryOnRefresh).toBeUndefined();
  });

  it("marks the open task failed when its app-server lease disappears", () => {
    const scope = new Scope("thread-lease-failed-test");
    scopes.push(scope);
    const actor = createThreadActor(scope, new DeferredThreadGateway());
    actor.dispatch({ type: "OPENED", snapshot: snapshot("thread-a") });

    actor.dispatch({
      type: "GATEWAY_EVENT",
      event: gatewayEventEnvelopeV2("thread/lease/failed", {
        version: 1,
        threadId: "thread-a",
        reason: "app-server-client-closed",
      }),
    });

    expect(actor.getSnapshot()).toMatchObject({
      status: "failed",
      refreshing: false,
      error: "app-server-client-closed",
    });
  });
});

class DeferredThreadGateway implements GatewayPort {
  readonly #pending = new Map<
    string,
    (value: OutputOf<"thread/open">) => void
  >();
  signal: AbortSignal | undefined;
  historySignal: AbortSignal | undefined;
  readonly closedThreadIds: string[] = [];
  readonly openInputs: InputOf<"thread/open">[] = [];
  readonly historyInputs: InputOf<"thread/history">[] = [];
  #historyPending:
    | {
        readonly resolve: (value: OutputOf<"thread/history">) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method === "thread/close") {
      this.closedThreadIds.push((input as InputOf<"thread/close">).threadId);
      return Promise.resolve({
        version: 1,
        closed: true,
      }) as Promise<OutputOf<Method>>;
    }
    if (method === "thread/history") {
      this.historySignal = options.signal;
      this.historyInputs.push(input as InputOf<"thread/history">);
      return new Promise<OutputOf<"thread/history">>((resolve, reject) => {
        this.#historyPending = { resolve, reject };
      }) as Promise<OutputOf<Method>>;
    }
    if (method !== "thread/open") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.signal = options.signal;
    const openInput = input as InputOf<"thread/open">;
    this.openInputs.push(openInput);
    const threadId = openInput.threadId;
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

  hasPending(threadId: string): boolean {
    return this.#pending.has(threadId);
  }

  resolveHistory(value: OutputOf<"thread/history">): void {
    const pending = this.#historyPending;
    if (pending === undefined)
      throw new Error("History request is not pending");
    this.#historyPending = undefined;
    pending.resolve(value);
  }

  rejectHistory(error: Error): void {
    const pending = this.#historyPending;
    if (pending === undefined)
      throw new Error("History request is not pending");
    this.#historyPending = undefined;
    pending.reject(error);
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

function snapshot(
  threadId: string,
  itemIds: readonly string[] = [],
  page: {
    readonly historyCursor?: string;
    readonly hasEarlierHistory?: boolean;
  } = {},
): OutputOf<"thread/open"> {
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
    items: itemIds.map(timelineItem),
    interactions: [],
    ...(page.historyCursor === undefined
      ? {}
      : { historyCursor: page.historyCursor }),
    hasEarlierHistory: page.hasEarlierHistory ?? false,
    settings: { version: 1, revision: 0 },
  };
}

function timelineItem(id: string): OutputOf<"thread/open">["items"][number] {
  return {
    version: 1,
    id,
    type: "message",
    data: { type: "agentMessage", text: id },
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
