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
});

class TaskListGateway implements GatewayPort {
  listCalls = 0;
  #nextList:
    | {
        readonly promise: Promise<OutputOf<"thread/list">>;
        readonly resolve: (page: OutputOf<"thread/list">) => void;
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
    const pending = this.#nextList;
    this.#nextList = undefined;
    return (pending?.promise ?? Promise.resolve(threadPage())) as Promise<
      OutputOf<Method>
    >;
  }

  deferNextList(): {
    readonly resolve: (page: OutputOf<"thread/list">) => void;
  } {
    let resolve!: (page: OutputOf<"thread/list">) => void;
    const promise = new Promise<OutputOf<"thread/list">>((complete) => {
      resolve = complete;
    });
    this.#nextList = { promise, resolve };
    return { resolve };
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
    hasMore: false,
  };
}
