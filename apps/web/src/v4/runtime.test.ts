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

  it("does not recursively reopen a task for settings acknowledgements", async () => {
    const gateway = new ThreadRefreshGateway();
    const runtime = new UserWebRuntime({ gateway, host: savedHost() });
    runtimes.push(runtime);

    runtime.thread.dispatch({ type: "OPEN", threadId: "thread-1" });
    await vi.waitFor(() =>
      expect(runtime.thread.getSnapshot().status).toBe("idle"),
    );

    gateway.notification("thread/settings/updated");
    await vi.waitFor(() => expect(gateway.openCalls).toBe(2));
    gateway.notification("thread/settings/updated");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(gateway.openCalls).toBe(2);
    expect(runtime.thread.getSnapshot()).toMatchObject({
      status: "idle",
      refreshing: false,
    });
  });
});

class ThreadRefreshGateway implements GatewayPort {
  readonly #listeners = new Set<(event: GatewayEventEnvelopeV2) => void>();
  openCalls = 0;

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    _options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "thread/open") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.openCalls += 1;
    const threadId = (input as InputOf<"thread/open">).threadId;
    return Promise.resolve(threadSnapshot(threadId)) as Promise<
      OutputOf<Method>
    >;
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

function threadSnapshot(threadId: string): OutputOf<"thread/open"> {
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
    settings: { version: 1, revision: 0 },
  };
}
