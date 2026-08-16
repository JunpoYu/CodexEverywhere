import { describe, expect, it, vi } from "vitest";
import { GatewayV2Error, MutationOutcomeUnknownError } from "./errors.js";
import { GatewayV2Client, type GatewayV2Transport } from "./client.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const operationKey = "22222222-2222-4222-8222-222222222222";

describe("GatewayV2Client", () => {
  it("builds and validates a typed query", async () => {
    const exchange = vi.fn(async (request: unknown) => ({
      version: 2,
      requestId: (request as { requestId: string }).requestId,
      ok: true,
      result: {
        version: 1,
        hostId: "host-1",
        serverTime: "2026-08-16T00:00:00.000Z",
        gatewayApiVersion: 2,
      },
    }));
    const client = createClient({ exchange });

    const result = await client.request("host/ping", { version: 1 }, {});

    expect(result.hostId).toBe("host-1");
    expect(exchange).toHaveBeenCalledWith(
      {
        version: 2,
        requestId,
        method: "host/ping",
        input: { version: 1 },
      },
      {},
    );
  });

  it("sends a caller-stable operation key for mutations", async () => {
    const exchange = vi.fn(async (request: unknown) => ({
      version: 2,
      requestId: (request as { requestId: string }).requestId,
      ok: true,
      result: { version: 1, removed: true },
    }));
    const client = createClient({ exchange });

    await client.request(
      "queue/remove",
      { version: 1, itemId: "item-1" },
      { operationKey },
    );

    expect(exchange.mock.calls[0]?.[0]).toMatchObject({ operationKey });
  });

  it("rejects invalid client input before transport", async () => {
    const exchange = vi.fn();
    const client = createClient({ exchange });
    await expect(
      client.request(
        "queue/remove",
        { version: 1, itemId: "item-1" },
        { operationKey: "not-a-uuid" },
      ),
    ).rejects.toBeInstanceOf(GatewayV2Error);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("turns a mutation transport failure into an explicit unknown outcome", async () => {
    const client = createClient({
      exchange: async () => {
        throw new Error("connection closed");
      },
    });
    const error = await client
      .request(
        "queue/remove",
        { version: 1, itemId: "item-1" },
        { operationKey },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MutationOutcomeUnknownError);
    expect(error).toMatchObject({ method: "queue/remove", operationKey });
  });

  it("surfaces structured remote errors", async () => {
    const client = createClient({
      exchange: async () => ({
        version: 2,
        requestId,
        ok: false,
        error: { code: "ACCESS_DENIED", message: "Denied" },
      }),
    });
    await expect(
      client.request("host/ping", { version: 1 }, {}),
    ).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  });
});

function createClient(transport: GatewayV2Transport): GatewayV2Client {
  return new GatewayV2Client(transport, { createRequestId: () => requestId });
}
