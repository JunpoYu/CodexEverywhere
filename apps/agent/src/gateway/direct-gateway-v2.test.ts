import {
  NoiseInitiator,
  encodePrologue,
  generateStaticKeyPair,
  type SecureSession,
} from "@codex-everywhere/crypto";
import { Scope } from "@codex-everywhere/kernel";
import {
  PROTOCOL_VERSION,
  type GatewayCipherFrame,
} from "@codex-everywhere/protocol";
import {
  GATEWAY_API_VERSION,
  GatewayV2Error,
  gatewayErrorResponse,
  gatewayEventEnvelopeV2,
  parseGatewayRequestEnvelopeV2,
  type GatewayEventEnvelopeV2,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { DirectTransportV2 } from "../v2/adapters/direct-transport.js";
import type {
  GatewayDeviceRegistry,
  GatewayTrustedDevice,
  GatewayV2Session,
} from "../v2/gateway/transport-contract.js";

const gateways: DirectTransportV2[] = [];
const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(
    gateways.splice(0).map((gateway) => gateway.close()),
  );
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  vi.restoreAllMocks();
});

describe("DirectTransportV2", () => {
  it("keeps Noise v1 while carrying v2 requests, responses, and events", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const devices = new FakeDevices(deviceKeys.publicKey);
    const session = new FakeV2Session();
    let authenticationMode: string | undefined;
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      loginName: "alice",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      deviceRegistry: devices,
      createSession: (_device, context) => {
        authenticationMode = context.authenticationMode;
        return session;
      },
    });
    gateways.push(gateway);

    const client = await connect({
      port: gateway.port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys,
      auth: {
        mode: "pair",
        pairingId: "pair-1",
        secret: "S".repeat(43),
        deviceName: "Phone",
      },
    });
    expect(client.accepted).toMatchObject({
      version: 1,
      gatewayApiVersion: 2,
      capabilities: ["queue-steer-v1", "tui-handoff-v1"],
    });
    expect(authenticationMode).toBe("pair");

    const requestId = "00000000-0000-4000-8000-000000000001";
    const response = await exchange(client.socket, client.session, {
      version: 2,
      requestId,
      method: "host/ping",
      input: { version: 1 },
    });
    expect(response).toEqual({
      version: 2,
      requestId,
      ok: true,
      result: {
        version: 1,
        hostId: "node-1",
        serverTime: "2026-01-01T00:00:00.000Z",
        gatewayApiVersion: 2,
      },
    });

    const eventPromise = nextEncrypted(client.socket, client.session);
    session.emit(
      gatewayEventEnvelopeV2("queue/removed", {
        version: 1,
        itemId: "queue-1",
      }),
    );
    await expect(eventPromise).resolves.toMatchObject({
      version: 2,
      type: "queue/removed",
      payload: { version: 1, itemId: "queue-1" },
    });
  });

  it("returns an explicit upgrade error instead of silently downgrading", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      deviceRegistry: new FakeDevices(deviceKeys.publicKey),
      createSession: () => new FakeV2Session(),
    });
    gateways.push(gateway);
    const client = await connect({
      port: gateway.port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys,
      auth: {
        mode: "pair",
        pairingId: "pair-1",
        secret: "S".repeat(43),
        deviceName: "Phone",
      },
    });

    const outcome = await exchange(client.socket, client.session, {
      version: 1,
      requestId: "00000000-0000-4000-8000-000000000002",
      method: "host/ping",
      input: { version: 1 },
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "CLIENT_UPGRADE_REQUIRED" },
    });
    await expect(closed(client.socket)).resolves.toBe(1008);
  });

  it("does not trust a login-mode device before CE authentication", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const devices = new FakeDevices(deviceKeys.publicKey);
    let context: { authenticationMode?: string; rememberedDevice?: boolean } =
      {};
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      deviceRegistry: devices,
      createSession: (_device, value) => {
        context = value;
        return new FakeV2Session();
      },
    });
    gateways.push(gateway);

    const client = await connect({
      port: gateway.port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys,
      auth: { mode: "login", deviceName: "New phone", rememberDevice: true },
    });

    expect(context).toMatchObject({
      authenticationMode: "login",
      rememberedDevice: false,
    });
    expect(devices.rememberAuthenticated).not.toHaveBeenCalled();
    client.socket.close();
  });
});

function trackedScope(): Scope {
  const scope = new Scope("direct-transport-v2-test");
  scopes.push(scope);
  return scope;
}

class FakeV2Session implements GatewayV2Session {
  readonly gatewayApiVersion = GATEWAY_API_VERSION;
  readonly #listeners = new Set<(event: GatewayEventEnvelopeV2) => void>();

  async route(input: unknown) {
    let requestId = "00000000-0000-4000-8000-000000000000";
    try {
      const request = parseGatewayRequestEnvelopeV2(input);
      requestId = request.requestId;
      return {
        response: {
          version: 2 as const,
          requestId,
          ok: true as const,
          result: {
            version: 1,
            hostId: "node-1",
            serverTime: "2026-01-01T00:00:00.000Z",
            gatewayApiVersion: 2,
          },
        },
        closeConnection: false,
      };
    } catch (error) {
      const gatewayError =
        error instanceof GatewayV2Error
          ? error
          : new GatewayV2Error("INVALID_REQUEST", "Invalid request");
      if (
        typeof input === "object" &&
        input !== null &&
        "requestId" in input &&
        typeof input.requestId === "string"
      ) {
        requestId = input.requestId;
      }
      return {
        response: gatewayErrorResponse(requestId, gatewayError.toPayload()),
        closeConnection: gatewayError.closeConnection,
      };
    }
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: GatewayEventEnvelopeV2): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

class FakeDevices implements GatewayDeviceRegistry {
  readonly #publicKey: Uint8Array;
  readonly rememberAuthenticated = vi.fn();

  constructor(publicKey: Uint8Array) {
    this.#publicKey = publicKey;
  }

  consumePairing(input: { deviceId: string; deviceName: string }) {
    return Promise.resolve(this.#device(input.deviceId, input.deviceName));
  }

  verify(deviceId: string): Promise<GatewayTrustedDevice> {
    return Promise.resolve(this.#device(deviceId, "Phone"));
  }

  match(): Promise<GatewayTrustedDevice | undefined> {
    return Promise.resolve(undefined);
  }

  #device(id: string, name: string): GatewayTrustedDevice {
    return {
      id,
      name,
      publicKey: this.#publicKey,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }
}

async function connect(input: {
  readonly port: number;
  readonly hostPublicKey: Uint8Array;
  readonly deviceKeys: ReturnType<typeof generateStaticKeyPair>;
  readonly auth: Record<string, unknown>;
}) {
  const socket = new WebSocket(`ws://127.0.0.1:${input.port}/gateway`, {
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const handshake = new NoiseInitiator(
    input.deviceKeys,
    input.hostPublicKey,
    encodePrologue({
      version: 1,
      userId: "unix:1000",
      nodeId: "node-1",
      deviceId: "browser-1",
    }),
  );
  socket.send(
    JSON.stringify({
      type: "handshake/hello",
      version: 1,
      nodeId: "node-1",
      deviceId: "browser-1",
      message: Buffer.from(
        handshake.start(Buffer.from(JSON.stringify(input.auth))),
      ).toString("base64url"),
    }),
  );
  const reply = JSON.parse((await nextMessage(socket)).toString()) as {
    message: string;
  };
  const completed = handshake.finish(Buffer.from(reply.message, "base64url"));
  return {
    socket,
    session: completed.session,
    accepted: JSON.parse(Buffer.from(completed.payload).toString()) as unknown,
  };
}

async function exchange(
  socket: WebSocket,
  session: SecureSession,
  request: unknown,
): Promise<unknown> {
  const response = nextEncrypted(socket, session);
  for (const frame of session.encryptMessage(
    Buffer.from(JSON.stringify(request)),
  )) {
    socket.send(
      JSON.stringify({
        type: "cipher",
        version: PROTOCOL_VERSION,
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        ciphertext: Buffer.from(frame.ciphertext).toString("base64url"),
      }),
    );
  }
  return response;
}

async function nextEncrypted(
  socket: WebSocket,
  session: SecureSession,
): Promise<unknown> {
  for (;;) {
    const wire = JSON.parse(
      (await nextMessage(socket)).toString(),
    ) as GatewayCipherFrame;
    const plaintext = session.decryptMessage({
      sessionId: wire.sessionId,
      sequence: wire.sequence,
      ciphertext: Buffer.from(wire.ciphertext, "base64url"),
    });
    if (plaintext !== undefined) {
      return JSON.parse(Buffer.from(plaintext).toString()) as unknown;
    }
  }
}

function nextMessage(socket: WebSocket): Promise<RawData> {
  return new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
}

function closed(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(1008);
  return new Promise((resolve) =>
    socket.once("close", (code) => resolve(code)),
  );
}
