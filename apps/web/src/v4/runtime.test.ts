import type {
  GatewayEventEnvelopeV2,
  GatewayMethodName,
  InputOf,
  OutputOf,
  RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { gatewayEventEnvelopeV2 } from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SavedHost } from "../storage.js";
import type { GatewayPort } from "./gateway/gateway-port.js";
import { UserWebRuntime } from "./runtime.js";

const runtimes: UserWebRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe("UserWebRuntime task refresh", () => {
  it("reloads tasks while preserving the active archive and workspace filters", async () => {
    const gateway = new TaskListGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.tasks.dispatch({
      type: "LOAD",
      archived: true,
      workspaceId: "workspace-1",
      workspaceLabel: "Research",
    });
    await vi.waitFor(() => expect(gateway.inputs).toHaveLength(1));
    await vi.waitFor(() =>
      expect(runtime.tasks.getSnapshot().status).toBe("ready"),
    );

    runtime.refreshTasks();
    await vi.waitFor(() => expect(gateway.inputs).toHaveLength(2));

    expect(gateway.inputs).toEqual([
      {
        version: 1,
        archived: true,
        limit: 50,
        workspaceId: "workspace-1",
      },
      {
        version: 1,
        archived: true,
        limit: 50,
        workspaceId: "workspace-1",
      },
    ]);
    expect(runtime.tasks.getSnapshot()).toMatchObject({
      archived: true,
      workspaceId: "workspace-1",
      workspaceLabel: "Research",
    });
  });

  it("ignores resume metadata and debounces timeline refreshes", async () => {
    const gateway = new ThreadRefreshGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.thread.dispatch({ type: "OPEN", threadId: "thread-1" });
    await vi.waitFor(() => expect(gateway.openCalls).toBe(1));
    await vi.waitFor(() =>
      expect(runtime.thread.getSnapshot().status).toBe("idle"),
    );

    gateway.notification("thread/tokenUsage/updated");
    gateway.notification("thread/goal/cleared");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.openCalls).toBe(1);

    gateway.notification("item/started");
    gateway.notification("item/agentMessage/delta");
    gateway.notification("item/completed");
    await vi.waitFor(() => expect(gateway.openCalls).toBe(2));
    expect(runtime.thread.getSnapshot()).toMatchObject({
      status: "idle",
      refreshing: false,
    });

    gateway.generic();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.openCalls).toBe(2);
  });

  it("coalesces duplicate settings acknowledgements into one refresh", async () => {
    const gateway = new ThreadRefreshGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.thread.dispatch({ type: "OPEN", threadId: "thread-1" });
    await vi.waitFor(() =>
      expect(runtime.thread.getSnapshot().status).toBe("idle"),
    );

    gateway.notification("thread/settings/updated");
    gateway.notification("thread/settings/updated");
    await vi.waitFor(() => expect(gateway.openCalls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(gateway.openCalls).toBe(2);
    expect(runtime.thread.getSnapshot()).toMatchObject({
      status: "idle",
      refreshing: false,
    });
  });

  it("refreshes the active task and filtered task list after a name update", async () => {
    const gateway = new ThreadRefreshGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.tasks.dispatch({
      type: "LOAD",
      archived: true,
      workspaceId: "workspace-1",
      workspaceLabel: "Research",
    });
    runtime.thread.dispatch({ type: "OPEN", threadId: "thread-1" });
    await vi.waitFor(() => expect(gateway.taskListInputs).toHaveLength(1));
    await vi.waitFor(() =>
      expect(runtime.thread.getSnapshot().status).toBe("idle"),
    );

    gateway.notification("thread/name/updated");

    await vi.waitFor(() => expect(gateway.taskListInputs).toHaveLength(2));
    await vi.waitFor(() => expect(gateway.openCalls).toBe(2));
    expect(gateway.taskListInputs.at(-1)).toEqual({
      version: 1,
      archived: true,
      limit: 50,
      workspaceId: "workspace-1",
    });
  });

  it("refreshes a filtered task list after a background name change", async () => {
    const gateway = new ThreadRefreshGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.tasks.dispatch({
      type: "LOAD",
      archived: false,
      workspaceId: "workspace-1",
      workspaceLabel: "Research",
    });
    await vi.waitFor(() => expect(gateway.taskListInputs).toHaveLength(1));

    gateway.nameChanged("thread-background");

    await vi.waitFor(() => expect(gateway.taskListInputs).toHaveLength(2));
    expect(gateway.openCalls).toBe(0);
    expect(gateway.taskListInputs.at(-1)).toEqual({
      version: 1,
      archived: false,
      limit: 50,
      workspaceId: "workspace-1",
    });
  });

  it("runs a trailing refresh for a settings update received during refresh", async () => {
    const gateway = new ThreadRefreshGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.thread.dispatch({ type: "OPEN", threadId: "thread-1" });
    await vi.waitFor(() =>
      expect(runtime.thread.getSnapshot().status).toBe("idle"),
    );

    const refresh = gateway.deferNextOpen();
    gateway.notification("thread/settings/updated");
    await vi.waitFor(() => expect(gateway.openCalls).toBe(2));
    expect(runtime.thread.getSnapshot().refreshing).toBe(true);

    gateway.notification("thread/settings/updated");
    gateway.settingsRevision = 1;
    refresh.resolve(threadSnapshot("thread-1", 0));

    await vi.waitFor(() => expect(gateway.openCalls).toBe(3));
    await vi.waitFor(() =>
      expect(runtime.thread.getSnapshot()).toMatchObject({
        status: "idle",
        refreshing: false,
        snapshot: { settings: { revision: 1 } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.openCalls).toBe(3);
  });
});

class ThreadRefreshGateway implements GatewayPort {
  readonly #listeners = new Set<(event: GatewayEventEnvelopeV2) => void>();
  #nextOpen:
    | {
        readonly promise: Promise<OutputOf<"thread/open">>;
        readonly resolve: (snapshot: OutputOf<"thread/open">) => void;
      }
    | undefined;
  openCalls = 0;
  readonly taskListInputs: InputOf<"thread/list">[] = [];
  settingsRevision = 0;

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    _options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method === "thread/list") {
      this.taskListInputs.push(input as InputOf<"thread/list">);
      return Promise.resolve({
        version: 1,
        threads: [],
        hasMore: false,
      }) as Promise<OutputOf<Method>>;
    }
    if (method !== "thread/open") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.openCalls += 1;
    const threadId = (input as InputOf<"thread/open">).threadId;
    const deferred = this.#nextOpen;
    this.#nextOpen = undefined;
    return (deferred?.promise ??
      Promise.resolve(
        threadSnapshot(threadId, this.settingsRevision),
      )) as Promise<OutputOf<Method>>;
  }

  deferNextOpen(): {
    readonly resolve: (snapshot: OutputOf<"thread/open">) => void;
  } {
    if (this.#nextOpen !== undefined) {
      throw new Error("A deferred thread/open already exists");
    }
    let resolve!: (snapshot: OutputOf<"thread/open">) => void;
    const promise = new Promise<OutputOf<"thread/open">>((complete) => {
      resolve = complete;
    });
    this.#nextOpen = { promise, resolve };
    return { resolve };
  }

  notification(method: string): void {
    this.emit(
      gatewayEventEnvelopeV2("codex/notification", {
        version: 1,
        threadId: "thread-1",
        method,
        params: { threadId: "thread-1" },
      }),
    );
  }

  nameChanged(threadId: string): void {
    this.emit(
      gatewayEventEnvelopeV2("thread/name/changed", {
        version: 1,
        threadId,
      }),
    );
  }

  generic(): void {
    this.emit(
      gatewayEventEnvelopeV2("codex/generic", {
        version: 1,
        threadId: "thread-1",
        method: "future/item/progress",
        params: { threadId: "thread-1" },
      }),
    );
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onConnectionLost(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {}

  private emit(event: GatewayEventEnvelopeV2): void {
    for (const listener of this.#listeners) listener(event);
  }
}

class TaskListGateway implements GatewayPort {
  readonly inputs: InputOf<"thread/list">[] = [];

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    _options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "thread/list") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.inputs.push(input as InputOf<"thread/list">);
    return Promise.resolve({
      version: 1,
      threads: [],
      hasMore: false,
    }) as Promise<OutputOf<Method>>;
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

function savedHost(): SavedHost {
  return {
    id: "host-1",
    name: "Test host",
    endpoint: "wss://example.invalid",
    transport: "relay",
    nodeId: "node-1",
    userId: "user-1",
    hostPublicKey: "host-public-key",
    hostFingerprint: "host-fingerprint",
    deviceId: "device-1",
    deviceName: "Test device",
    devicePublicKey: "device-public-key",
    deviceSecretKey: "device-secret-key",
  };
}

function threadSnapshot(
  threadId: string,
  settingsRevision = 0,
): OutputOf<"thread/open"> {
  const now = "2026-08-19T00:00:00.000Z";
  return {
    version: 1,
    thread: {
      version: 1,
      id: threadId,
      workspaceId: "workspace-1",
      title: "Task",
      state: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
    },
    state: "idle",
    items: [],
    interactions: [],
    hasEarlierHistory: false,
    settings: { version: 1, revision: settingsRevision },
  };
}
