import type {
  GatewayEventEnvelopeV2,
  GatewayMethodName,
  InputOf,
  OutputOf,
  RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
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
});

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
