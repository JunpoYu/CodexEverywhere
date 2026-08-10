import { describe, expect, it, vi } from "vitest";

import { GatewayRequestOutcomeUnknownError } from "./gateway-client.js";
import {
  GatewayMutationRecoveryPendingError,
  requestRecoverableGatewayMutation,
} from "./recoverable-mutation.js";

describe("recoverable gateway mutations", () => {
  it("retries thread/start with the exact payload and idempotency key", async () => {
    const first = mutationClient("device-1", async () => {
      throw new GatewayRequestOutcomeUnknownError(
        "thread/start",
        "thread-operation-1",
        new Error("connection lost"),
        { transportLost: true },
      );
    });
    const second = mutationClient("device-1", async () => ({
      thread: { id: "thread-1" },
    }));
    const reconnect = vi.fn(async () => second.client);

    await expect(
      requestRecoverableGatewayMutation({
        client: first.client,
        method: "thread/start",
        payload: { cwd: "/work", approvalPolicy: "never" },
        idempotencyKey: "thread-operation-1",
        reconnect,
      }),
    ).resolves.toMatchObject({ value: { thread: { id: "thread-1" } } });
    expect(first.request).toHaveBeenCalledWith(
      "thread/start",
      { cwd: "/work", approvalPolicy: "never" },
      { idempotencyKey: "thread-operation-1" },
    );
    expect(second.request).toHaveBeenCalledWith(
      "thread/start",
      { cwd: "/work", approvalPolicy: "never" },
      { idempotencyKey: "thread-operation-1" },
    );
  });

  it("refuses an automatic retry when reauthentication changes device scope", async () => {
    const first = mutationClient("device-1", async () => {
      throw new GatewayRequestOutcomeUnknownError(
        "thread/start",
        "thread-operation-2",
        new Error("connection lost"),
        { transportLost: true },
      );
    });
    const second = mutationClient("device-2", async () => ({
      thread: { id: "duplicate" },
    }));

    await expect(
      requestRecoverableGatewayMutation({
        client: first.client,
        method: "thread/start",
        payload: { cwd: "/work" },
        idempotencyKey: "thread-operation-2",
        reconnect: async () => second.client,
      }),
    ).rejects.toThrow("idempotency scope");
    expect(second.request).not.toHaveBeenCalled();
  });

  it("surfaces a definitive cached Host rejection after reconnect", async () => {
    const first = mutationClient("device-1", async () => {
      throw new GatewayRequestOutcomeUnknownError(
        "thread/start",
        "thread-operation-3",
        new Error("connection lost"),
        { transportLost: true },
      );
    });
    const second = mutationClient("device-1", async () => {
      throw new Error("workspace is no longer authorized");
    });

    const error = await requestRecoverableGatewayMutation({
      client: first.client,
      method: "thread/start",
      payload: { cwd: "/work" },
      idempotencyKey: "thread-operation-3",
      reconnect: async () => second.client,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GatewayMutationRecoveryPendingError);
    expect((error as Error).message).toBe("workspace is no longer authorized");
  });

  it("retries a timed-out mutation on the still-healthy tunnel without reconnecting", async () => {
    let attempts = 0;
    const current = mutationClient("device-1", async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new GatewayRequestOutcomeUnknownError(
          "thread/start",
          "thread-operation-4",
          new Error("request timed out"),
        );
      }
      return { thread: { id: "thread-4" } };
    });
    const reconnect = vi.fn();

    await expect(
      requestRecoverableGatewayMutation({
        client: current.client,
        method: "thread/start",
        payload: { cwd: "/work" },
        idempotencyKey: "thread-operation-4",
        reconnect,
      }),
    ).resolves.toMatchObject({ value: { thread: { id: "thread-4" } } });
    expect(reconnect).not.toHaveBeenCalled();
    expect(current.request).toHaveBeenCalledTimes(2);
  });
});

function mutationClient(
  deviceId: string,
  implementation: () => Promise<unknown>,
): {
  client: Parameters<
    typeof requestRecoverableGatewayMutation<unknown>
  >[0]["client"];
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(implementation);
  return {
    client: {
      host: { deviceId },
      request,
    } as unknown as Parameters<
      typeof requestRecoverableGatewayMutation<unknown>
    >[0]["client"],
    request,
  };
}
