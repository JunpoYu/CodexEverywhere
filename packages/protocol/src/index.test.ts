import { describe, expect, it } from "vitest";

import {
  RELAY_MESSAGE_TYPES,
  parseGatewayAuthenticationPayload,
  parseGatewayCipherFrame,
  parseGatewayHandshakeHello,
  parseGatewayHandshakeAccepted,
  parseGatewayHandshakeResult,
  parseGatewayHandshakeReply,
  parseRelayWireMessage,
} from "./index.js";

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

  it("accepts complete v1 transport handshakes", () => {
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
        gatewayApiVersion: 2,
        principal: "user",
        capabilities: ["gateway-v2", "future-feature"],
      }),
    ).toMatchObject({
      ok: true,
      gatewayApiVersion: 2,
      principal: "user",
      capabilities: ["gateway-v2", "future-feature"],
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
  });

  it("rejects unsupported handshake and cipher frame versions", () => {
    expect(() =>
      parseGatewayHandshakeHello({
        type: "handshake/hello",
        version: 2,
        nodeId: "node-1",
        deviceId: "device-1",
        message: "YWJj",
      }),
    ).toThrow("Invalid gateway handshake hello");
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
        capabilities: ["gateway-v2", 42],
      }),
    ).toThrow("Invalid gateway handshake result");
    expect(() =>
      parseGatewayHandshakeAccepted({
        version: 1,
        ok: true,
        gatewayApiVersion: 0,
        principal: "user",
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

  it("validates the unencrypted handshake hello before Noise processing", () => {
    expect(
      parseGatewayHandshakeHello({
        type: "handshake/hello",
        version: 1,
        nodeId: "node-1",
        deviceId: "device_1",
        message: "YWJj",
      }),
    ).toMatchObject({ nodeId: "node-1", deviceId: "device_1" });
    expect(() =>
      parseGatewayHandshakeHello({
        type: "handshake/hello",
        version: 1,
        nodeId: "node-1",
        deviceId: "device with spaces",
        message: "not base64!",
      }),
    ).toThrow("Invalid gateway handshake hello");
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
