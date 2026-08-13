import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  RELAY_MESSAGE_TYPES,
  parseEventEnvelope,
  parseGatewayAuthenticationPayload,
  parseGatewayCipherFrame,
  parseGatewayHandshakeAccepted,
  parseGatewayHandshakeResult,
  parseGatewayHandshakeReply,
  parseGatewayServerEnvelope,
  parseRelayWireMessage,
  parseResponseEnvelope,
  requestEnvelope,
} from "./index.js";

describe("requestEnvelope", () => {
  it("creates a versioned idempotent request", () => {
    expect(
      requestEnvelope(
        "thread.list",
        { limit: 20 },
        { requestId: "r1", idempotencyKey: "i1" },
      ),
    ).toEqual({
      version: PROTOCOL_VERSION,
      requestId: "r1",
      idempotencyKey: "i1",
      method: "thread.list",
      payload: { limit: 20 },
    });
  });
});

describe("gateway wire validation", () => {
  it("accepts only an explicit, bounded session resume payload", () => {
    const resumeToken = "A".repeat(43);
    expect(
      parseGatewayAuthenticationPayload({ mode: "resume", resumeToken }),
    ).toEqual({ mode: "resume", resumeToken });
    expect(() =>
      parseGatewayAuthenticationPayload({
        mode: "resume",
        resumeToken: "short",
      }),
    ).toThrow("Invalid gateway authentication payload");
    expect(() =>
      parseGatewayAuthenticationPayload({
        mode: "resume",
        resumeToken: "!".repeat(43),
      }),
    ).toThrow("Invalid gateway authentication payload");
  });

  it("accepts complete v1 handshake, response, and event envelopes", () => {
    expect(
      parseGatewayHandshakeReply({
        type: "handshake/reply",
        version: 1,
        message: "YWJj",
      }),
    ).toMatchObject({ type: "handshake/reply", version: 1 });
    expect(
      parseGatewayHandshakeAccepted({
        version: 1,
        ok: true,
        principal: "user",
        capabilities: ["side-fork-v1", "future-feature"],
      }),
    ).toMatchObject({
      ok: true,
      principal: "user",
      capabilities: ["side-fork-v1", "future-feature"],
    });
    expect(
      parseGatewayHandshakeResult({
        version: 1,
        ok: false,
        error: { code: "REAUTH_REQUIRED" },
      }),
    ).toEqual({
      version: 1,
      ok: false,
      error: { code: "REAUTH_REQUIRED" },
    });
    expect(
      parseResponseEnvelope({
        version: 1,
        requestId: "request-1",
        ok: true,
        result: null,
      }),
    ).toMatchObject({ requestId: "request-1", ok: true });
    expect(
      parseEventEnvelope({
        version: 1,
        eventId: "event-1",
        cursor: "1",
        type: "turn/started",
        payload: {},
      }),
    ).toMatchObject({ eventId: "event-1", cursor: "1" });
  });

  it("rejects unsupported handshake and cipher frame versions", () => {
    expect(() =>
      parseGatewayHandshakeReply({
        type: "handshake/reply",
        version: 2,
        message: "YWJj",
      }),
    ).toThrow("Invalid gateway handshake reply");
    expect(() =>
      parseGatewayHandshakeResult({
        version: 2,
        ok: false,
        error: { code: "REAUTH_REQUIRED" },
      }),
    ).toThrow("Invalid gateway handshake result");
    expect(() =>
      parseGatewayCipherFrame({
        type: "cipher",
        version: 2,
        sessionId: "session_1",
        sequence: 0,
        ciphertext: "YWJj",
      }),
    ).toThrow("Invalid gateway cipher frame");
  });

  it("rejects malformed handshake capability lists", () => {
    expect(() =>
      parseGatewayHandshakeAccepted({
        version: 1,
        ok: true,
        principal: "user",
        capabilities: ["side-fork-v1", 42],
      }),
    ).toThrow("Invalid gateway handshake result");
  });

  it("rejects malformed cipher frame fields before decryption", () => {
    expect(() =>
      parseGatewayCipherFrame({
        type: "cipher",
        version: 1,
        sessionId: "not valid base64url",
        sequence: -1,
        ciphertext: "",
      }),
    ).toThrow("Invalid gateway cipher frame");
  });

  it("rejects malformed response and event envelopes", () => {
    expect(() =>
      parseResponseEnvelope({
        version: 1,
        requestId: "request-1",
        ok: false,
      }),
    ).toThrow("Invalid gateway error response");
    expect(() =>
      parseResponseEnvelope({
        version: 1,
        requestId: "request-1",
        ok: true,
        error: { code: "FAILED", message: "must not be present" },
      }),
    ).toThrow("contains an error");
    expect(() =>
      parseEventEnvelope({
        version: 1,
        eventId: "event-1",
        cursor: "",
        type: "turn/started",
      }),
    ).toThrow("Invalid gateway event envelope");
    expect(() =>
      parseGatewayServerEnvelope({
        version: 1,
        requestId: "request-1",
        ok: true,
        eventId: "event-1",
        cursor: "1",
        type: "turn/started",
        payload: {},
      }),
    ).toThrow("Ambiguous gateway server envelope");
  });
});

describe("Relay wire validation", () => {
  it("centralizes known v1 message types", () => {
    expect(
      parseRelayWireMessage(
        JSON.stringify({ type: "relay/ready", version: 1 }),
        RELAY_MESSAGE_TYPES.ready,
      ),
    ).toMatchObject({ type: "relay/ready", version: 1 });
  });

  it("rejects wrong versions, unknown types, and unexpected replies", () => {
    expect(() =>
      parseRelayWireMessage({ type: "relay/ready", version: 2 }),
    ).toThrow("Unsupported Relay protocol version");
    expect(() =>
      parseRelayWireMessage({ type: "relay/surprise", version: 1 }),
    ).toThrow("Unknown Relay message type");
    expect(() =>
      parseRelayWireMessage(
        { type: "relay/profile", version: 1 },
        RELAY_MESSAGE_TYPES.ready,
      ),
    ).toThrow("Expected relay/ready Relay message");
  });
});
