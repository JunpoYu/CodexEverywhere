import { describe, expect, it } from "vitest";
import { codexGenericEvent } from "./events.js";
import { GatewayV2Error } from "./errors.js";
import {
  parseGatewayEventEnvelopeV2,
  parseGatewayRequestEnvelopeV2,
  parseGatewayResponseEnvelopeV2,
} from "./wire.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const operationKey = "22222222-2222-4222-8222-222222222222";

describe("Gateway API v2 wire", () => {
  it("parses a schema-bound query without an operation key", () => {
    expect(
      parseGatewayRequestEnvelopeV2({
        version: 2,
        requestId,
        method: "host/ping",
        input: { version: 1 },
      }),
    ).toEqual({
      version: 2,
      requestId,
      method: "host/ping",
      input: { version: 1 },
    });
  });

  it("requires a UUID operation key for every mutation", () => {
    expectGatewayError(
      () =>
        parseGatewayRequestEnvelopeV2({
          version: 2,
          requestId,
          method: "queue/remove",
          input: { version: 1, itemId: "item-1" },
        }),
      "OPERATION_KEY_REQUIRED",
    );
    expectGatewayError(
      () =>
        parseGatewayRequestEnvelopeV2({
          version: 2,
          requestId,
          operationKey: "not-a-uuid",
          method: "queue/remove",
          input: { version: 1, itemId: "item-1" },
        }),
      "INVALID_REQUEST",
    );

    expect(
      parseGatewayRequestEnvelopeV2({
        version: 2,
        requestId,
        operationKey,
        method: "queue/remove",
        input: { version: 1, itemId: "item-1" },
      }),
    ).toMatchObject({ method: "queue/remove", operationKey });
  });

  it("rejects operation keys on queries", () => {
    expectGatewayError(
      () =>
        parseGatewayRequestEnvelopeV2({
          version: 2,
          requestId,
          operationKey,
          method: "host/ping",
          input: { version: 1 },
        }),
      "OPERATION_KEY_NOT_ALLOWED",
    );
  });

  it("returns explicit upgrade directions for mismatched API versions", () => {
    expectGatewayError(
      () =>
        parseGatewayRequestEnvelopeV2({
          version: 1,
          requestId,
          method: "host/ping",
          input: { version: 1 },
        }),
      "CLIENT_UPGRADE_REQUIRED",
    );
    expectGatewayError(
      () =>
        parseGatewayRequestEnvelopeV2({
          version: 3,
          requestId,
          method: "host/ping",
          input: { version: 1 },
        }),
      "AGENT_UPGRADE_REQUIRED",
    );
  });

  it("rejects unknown methods and strict input violations without echoing data", () => {
    expectGatewayError(
      () =>
        parseGatewayRequestEnvelopeV2({
          version: 2,
          requestId,
          method: "side/start",
          input: { version: 1 },
        }),
      "METHOD_NOT_FOUND",
    );

    const secret = "sensitive prompt that must not appear";
    const error = catchGatewayError(() =>
      parseGatewayRequestEnvelopeV2({
        version: 2,
        requestId,
        method: "turn/start",
        operationKey,
        input: {
          version: 1,
          threadId: "task-1",
          prompt: secret,
          unexpected: secret,
        },
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(error.toPayload())).not.toContain(secret);
  });

  it("validates method-specific successful results", () => {
    expect(
      parseGatewayResponseEnvelopeV2(
        {
          version: 2,
          requestId,
          ok: true,
          result: {
            version: 1,
            hostId: "host-1",
            serverTime: "2026-08-16T00:00:00.000Z",
            gatewayApiVersion: 2,
          },
        },
        "host/ping",
        requestId,
      ),
    ).toMatchObject({ ok: true });

    expectGatewayError(
      () =>
        parseGatewayResponseEnvelopeV2(
          {
            version: 2,
            requestId,
            ok: true,
            result: { version: 1, hostId: "host-1" },
          },
          "host/ping",
          requestId,
        ),
      "INVALID_RESPONSE_RESULT",
    );
  });

  it("preserves unknown Codex notifications as versioned generic events", () => {
    const payload = codexGenericEvent("future/notification", {
      nested: [1, true, null],
    });
    expect(payload).toEqual({
      version: 1,
      method: "future/notification",
      params: { nested: [1, true, null] },
    });

    expect(
      parseGatewayEventEnvelopeV2({
        version: 2,
        eventId: "33333333-3333-4333-8333-333333333333",
        type: "codex/generic",
        payload,
      }),
    ).toMatchObject({ type: "codex/generic", payload });
  });
});

function expectGatewayError(action: () => unknown, code: string): void {
  expect(catchGatewayError(action)).toMatchObject({
    code,
    closeConnection: true,
  });
}

function catchGatewayError(action: () => unknown): GatewayV2Error {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayV2Error);
    return error as GatewayV2Error;
  }
  throw new Error("Expected action to throw");
}
