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
import { createTaskListActor } from "./task-list-actor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
});

describe("TaskListActor live state projection", () => {
  it("retains the previous list on refresh failure and replaces it on explicit retry", async () => {
    const gateway = new TaskListGateway();
    const scope = new Scope("task-list-refresh-failure");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);
    actor.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    const previous = actor.getSnapshot().tasks;
    const failed = gateway.deferNextList();
    actor.dispatch({ type: "LOAD" });
    expect(actor.getSnapshot().tasks).toBe(previous);
    failed.reject(new Error("list unavailable"));
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("failed"));
    expect(actor.getSnapshot().tasks).toBe(previous);
    const retry = gateway.deferNextList();
    actor.dispatch({ type: "LOAD" });
    retry.resolve(renamedPage());
    await vi.waitFor(() =>
      expect(actor.getSnapshot().tasks[0]?.title).toBe("Renamed"),
    );
    expect(actor.getSnapshot().error).toBeUndefined();
  });

  it("coalesces rename notifications without cancelling an in-flight read or losing the trailing refresh", async () => {
    const gateway = new TaskListGateway();
    const scope = new Scope("task-list-rename-race");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);
    const first = gateway.deferNextList();
    actor.dispatch({ type: "LOAD" });
    actor.dispatch({ type: "LOAD" });
    actor.dispatch({ type: "LOAD" });
    expect(gateway.listCalls).toBe(1);
    expect(gateway.signals[0]?.aborted).toBe(false);
    const trailing = gateway.deferNextList();
    actor.dispatch({
      type: "THREAD_STATE_CHANGED",
      threadId: "thread-1",
      state: "running",
    });
    first.resolve(threadPage());
    await vi.waitFor(() => expect(gateway.listCalls).toBe(2));
    expect(actor.getSnapshot().status).toBe("loading");
    expect(actor.getSnapshot().tasks[0]?.state).toBe("running");
    expect(actor.getSnapshot().pendingStateChanges).toEqual({});
    trailing.resolve(renamedPage());
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    expect(actor.getSnapshot().tasks[0]).toMatchObject({
      title: "Renamed",
      state: "idle",
    });
    expect(gateway.listCalls).toBe(2);
  });

  it("honors a pending refresh even when the earlier request fails", async () => {
    const gateway = new TaskListGateway();
    const scope = new Scope("task-list-pending-refresh");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);
    const first = gateway.deferNextList();
    actor.dispatch({ type: "LOAD" });
    actor.dispatch({ type: "LOAD" });
    const trailing = gateway.deferNextList();
    first.reject(new Error("earlier read failed"));
    await vi.waitFor(() => expect(gateway.listCalls).toBe(2));
    trailing.resolve(renamedPage());
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    expect(actor.getSnapshot().tasks[0]?.title).toBe("Renamed");
  });

  it("cancels old filter reads and ignores duplicate pagination clicks", async () => {
    const gateway = new TaskListGateway();
    const scope = new Scope("task-list-filter-race");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);
    actor.dispatch({ type: "LOAD", workspaceId: "workspace-1" });
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    const oldPage = gateway.deferNextList();
    actor.dispatch({ type: "MORE" });
    actor.dispatch({ type: "MORE" });
    expect(gateway.listCalls).toBe(2);
    const newScope = gateway.deferNextList();
    actor.dispatch({ type: "LOAD", workspaceId: "workspace-2" });
    expect(actor.getSnapshot().tasks).toEqual([]);
    expect(gateway.signals[1]?.aborted).toBe(true);
    newScope.resolve(emptyThreadPage());
    oldPage.resolve(threadPage());
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    expect(actor.getSnapshot().tasks).toEqual([]);
    expect(actor.getSnapshot().workspaceId).toBe("workspace-2");
  });

  it("updates only the matching loaded task without another list request", async () => {
    const gateway = new TaskListGateway();
    const scope = new Scope("task-list-test");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);

    actor.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    const previousTasks = actor.getSnapshot().tasks;

    actor.dispatch({
      type: "THREAD_STATE_CHANGED",
      threadId: "thread-1",
      state: "running",
    });

    expect(gateway.listCalls).toBe(1);
    expect(actor.getSnapshot().tasks).not.toBe(previousTasks);
    expect(actor.getSnapshot().tasks).toEqual([
      expect.objectContaining({ id: "thread-1", state: "running" }),
      expect.objectContaining({ id: "thread-2", state: "idle" }),
    ]);
  });

  it("does not let an older in-flight list response overwrite a newer state event", async () => {
    const gateway = new TaskListGateway();
    const pending = gateway.deferNextList();
    const scope = new Scope("task-list-race-test");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);

    actor.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(gateway.listCalls).toBe(1));
    actor.dispatch({
      type: "THREAD_STATE_CHANGED",
      threadId: "thread-1",
      state: "running",
    });
    pending.resolve(threadPage());

    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    expect(actor.getSnapshot().tasks[0]).toMatchObject({
      id: "thread-1",
      state: "running",
    });
    expect(actor.getSnapshot().pendingStateChanges).toEqual({});
  });

  it("discards an in-flight state buffer when pagination fails", async () => {
    const gateway = new TaskListGateway();
    const scope = new Scope("task-list-pagination-failure-test");
    scopes.push(scope);
    const actor = createTaskListActor(scope, gateway);

    actor.dispatch({ type: "LOAD" });
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));
    const failedPage = gateway.deferNextList();
    actor.dispatch({ type: "MORE" });
    await vi.waitFor(() =>
      expect(actor.getSnapshot().status).toBe("paginating"),
    );
    actor.dispatch({
      type: "THREAD_STATE_CHANGED",
      threadId: "thread-1",
      state: "running",
    });
    failedPage.reject(new Error("page unavailable"));
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("failed"));

    expect(actor.getSnapshot().pendingStateChanges).toEqual({});
    actor.dispatch({
      type: "THREAD_STATE_CHANGED",
      threadId: "thread-1",
      state: "idle",
    });
    const retry = gateway.deferNextList();
    actor.dispatch({ type: "MORE" });
    retry.resolve(emptyThreadPage());
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("ready"));

    expect(actor.getSnapshot().tasks[0]).toMatchObject({
      id: "thread-1",
      state: "idle",
    });
  });
});

class TaskListGateway implements GatewayPort {
  listCalls = 0;
  readonly signals: Array<AbortSignal | undefined> = [];
  #nextList:
    | {
        readonly promise: Promise<OutputOf<"thread/list">>;
        readonly resolve: (page: OutputOf<"thread/list">) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    _options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "thread/list") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.listCalls += 1;
    this.signals.push(_options.signal);
    const pending = this.#nextList;
    this.#nextList = undefined;
    return (pending?.promise ?? Promise.resolve(threadPage())) as Promise<
      OutputOf<Method>
    >;
  }

  deferNextList(): {
    readonly resolve: (page: OutputOf<"thread/list">) => void;
    readonly reject: (error: Error) => void;
  } {
    let resolve!: (page: OutputOf<"thread/list">) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<OutputOf<"thread/list">>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    this.#nextList = { promise, resolve, reject };
    return { resolve, reject };
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

function threadPage(): OutputOf<"thread/list"> {
  const now = "2026-09-07T00:00:00.000Z";
  return {
    version: 1,
    threads: [
      {
        version: 1,
        id: "thread-1",
        workspaceId: "workspace-1",
        title: "First",
        state: "idle",
        archived: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        version: 1,
        id: "thread-2",
        workspaceId: "workspace-1",
        title: "Second",
        state: "idle",
        archived: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    nextCursor: "cursor-2",
    hasMore: true,
  };
}

function emptyThreadPage(): OutputOf<"thread/list"> {
  return { version: 1, threads: [], hasMore: false };
}

function renamedPage(): OutputOf<"thread/list"> {
  const page = threadPage();
  return {
    ...page,
    threads: page.threads.map((task) =>
      task.id === "thread-1" ? { ...task, title: "Renamed" } : task,
    ),
  };
}
