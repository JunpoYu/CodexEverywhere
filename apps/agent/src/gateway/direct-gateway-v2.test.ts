import {
  NoiseInitiator,
  SecureMessageAssemblyBudget,
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
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DirectTransportV2 } from "../v2/adapters/direct-transport.js";
import {
  acceptGatewayV2Socket,
  gatewaySocketConnectionOptions,
  validateGatewaySocketConnectionOptions,
} from "../v2/adapters/gateway-socket-connection.js";
import type {
  GatewayDeviceRegistry,
  GatewayTrustedDevice,
  GatewayV2Session,
} from "../v2/gateway/transport-contract.js";

const gateways: DirectTransportV2[] = [];
const scopes: Scope[] = [];
const socketServers: WebSocketServer[] = [];
const socketCloseCodes = new WeakMap<WebSocket, Promise<number>>();

afterEach(async () => {
  await Promise.allSettled(
    gateways.splice(0).map((gateway) => gateway.close()),
  );
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  await Promise.allSettled(
    socketServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
});

describe("DirectTransportV2", () => {
  it("validates the shared socket seam and strips outer transport metadata", () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const source = {
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      heartbeatMs: 0,
      deviceRegistry: new FakeDevices(deviceKeys.publicKey),
      createSession: () => new FakeV2Session(),
      routeCapability: "must-not-cross-the-socket-seam",
    };

    expect(() => validateGatewaySocketConnectionOptions(source)).toThrow(
      "Gateway heartbeat must be a positive integer",
    );
    const projected = gatewaySocketConnectionOptions({
      ...source,
      heartbeatMs: 20,
    });
    expect(projected).not.toHaveProperty("routeCapability");
    expect(projected).toMatchObject({
      nodeId: "node-1",
      userId: "unix:1000",
      heartbeatMs: 20,
    });
  });

  it("serves an origin-bound public profile through the discovery adapter", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const origin = "https://codex.example.test";
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      directEndpoint: "wss://direct.example.test/gateway",
      relayEndpoint: "wss://relay.example.test",
      relayRouteId: "route-1",
      allowedOrigin: origin,
      deviceRegistry: new FakeDevices(deviceKeys.publicKey),
      createSession: () => new FakeV2Session(),
    });
    gateways.push(gateway);
    const endpoint = `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`;

    const response = await fetch(endpoint, { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    await expect(response.json()).resolves.toEqual({
      type: "host/profile",
      version: 1,
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: Buffer.from(hostKeys.publicKey).toString("base64url"),
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      directEndpoint: "wss://direct.example.test/gateway",
      relayEndpoint: "wss://relay.example.test",
      routeId: "route-1",
    });

    const forbidden = await fetch(endpoint, {
      headers: { Origin: "https://attacker.example.test" },
    });
    expect(forbidden.status).toBe(403);

    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Private-Network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
  });

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
    let authenticationMode: string | undefined;
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
        authenticationMode = value.authenticationMode;
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

    expect(authenticationMode).toBe("login");
    client.socket.close();
  });

  it("rejects a revoked device during resume before creating a session", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const devices = new FakeDevices(deviceKeys.publicKey, {
      matchedDevice: trustedDevice(deviceKeys.publicKey, {
        revokedAt: "2026-01-02T00:00:00.000Z",
      }),
    });
    const createSession = vi.fn(() => new FakeV2Session());
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      deviceRegistry: devices,
      createSession,
    });
    gateways.push(gateway);

    const client = await connect({
      port: gateway.port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys,
      auth: { mode: "resume", resumeToken: "R".repeat(43) },
    });

    expect(client.accepted).toEqual({
      version: 1,
      ok: false,
      error: { code: "REAUTH_REQUIRED" },
    });
    expect(createSession).not.toHaveBeenCalled();
    await expect(closed(client.socket)).resolves.toBe(1008);
  });

  it("turns a mismatched resume binding into an explicit reauthentication result", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const devices = new FakeDevices(deviceKeys.publicKey, {
      matchError: trustError("KEY_MISMATCH"),
    });
    const createSession = vi.fn(() => {
      throw new Error("REAUTH_REQUIRED");
    });
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      deviceRegistry: devices,
      createSession,
    });
    gateways.push(gateway);

    const client = await connect({
      port: gateway.port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys,
      auth: { mode: "resume", resumeToken: "R".repeat(43) },
    });

    expect(client.accepted).toMatchObject({
      ok: false,
      error: { code: "REAUTH_REQUIRED" },
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "browser-1",
        publicKey: deviceKeys.publicKey,
      }),
      expect.objectContaining({
        authenticationMode: "resume",
        resumeToken: "R".repeat(43),
      }),
    );
  });

  it("runs queries around the mutation queue while preserving mutation order", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const session = new SchedulingV2Session();
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      deviceRegistry: new FakeDevices(deviceKeys.publicKey),
      createSession: () => session,
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
    const firstMutationId = "10000000-0000-4000-8000-000000000001";
    const secondMutationId = "10000000-0000-4000-8000-000000000002";
    const queryId = "10000000-0000-4000-8000-000000000003";

    sendEncryptedRequest(client.socket, client.session, {
      version: 2,
      requestId: firstMutationId,
      operationKey: "20000000-0000-4000-8000-000000000001",
      method: "turn/interrupt",
      input: { version: 1, threadId: "thread-1" },
    });
    await waitFor(() => session.started.includes(firstMutationId));
    sendEncryptedRequest(client.socket, client.session, {
      version: 2,
      requestId: secondMutationId,
      operationKey: "20000000-0000-4000-8000-000000000002",
      method: "turn/interrupt",
      input: { version: 1, threadId: "thread-1" },
    });
    sendEncryptedRequest(client.socket, client.session, {
      version: 2,
      requestId: queryId,
      method: "host/ping",
      input: { version: 1 },
    });

    await waitFor(() => session.started.includes(queryId));
    expect(session.started).not.toContain(secondMutationId);
    session.releaseFirstMutation();
    await waitFor(() => session.started.includes(secondMutationId));
    expect(session.started.indexOf(firstMutationId)).toBeLessThan(
      session.started.indexOf(secondMutationId),
    );
    client.socket.close();
  });

  it("terminates a connected browser after the configured missed Pong limit", async () => {
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const session = new FakeV2Session();
    const gateway = await DirectTransportV2.start({
      parentScope: trackedScope(),
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      heartbeatMs: 20,
      heartbeatMissLimit: 2,
      deviceRegistry: new FakeDevices(deviceKeys.publicKey),
      createSession: () => session,
    });
    gateways.push(gateway);

    const client = await connect({
      port: gateway.port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys,
      autoPong: false,
      auth: {
        mode: "pair",
        pairingId: "pair-1",
        secret: "S".repeat(43),
        deviceName: "Phone",
      },
    });

    await expect(closed(client.socket)).resolves.toBe(1006);
    await waitFor(() => session.close.mock.calls.length === 1);
  });

  it("enforces and releases one fragment assembly budget across sockets", async () => {
    const hostKeys = generateStaticKeyPair();
    const firstKeys = generateStaticKeyPair();
    const secondKeys = generateStaticKeyPair();
    const scope = trackedScope();
    const budget = new SecureMessageAssemblyBudget(700_000);
    const port = await startSocketGateway(
      {
        parentScope: scope,
        host: "127.0.0.1",
        port: 0,
        nodeId: "node-1",
        userId: "unix:1000",
        identity: hostKeys,
        hostFingerprint: `sha256:${"A".repeat(43)}`,
        deviceRegistry: new FakeDevices(firstKeys.publicKey),
        createSession: () => new FakeV2Session(),
      },
      budget,
    );
    const first = await connect({
      port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys: firstKeys,
      auth: {
        mode: "pair",
        pairingId: "pair-1",
        secret: "S".repeat(43),
        deviceName: "First",
      },
    });
    const second = await connect({
      port,
      hostPublicKey: hostKeys.publicKey,
      deviceKeys: secondKeys,
      auth: {
        mode: "pair",
        pairingId: "pair-2",
        secret: "S".repeat(43),
        deviceName: "Second",
      },
    });

    sendFirstFragment(first.socket, first.session, 400_000);
    await waitFor(() => budget.reservedBytes === 400_000);
    sendFirstFragment(second.socket, second.session, 400_000);

    await expect(closed(second.socket)).resolves.toBe(1008);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
    expect(budget.reservedBytes).toBe(400_000);
    first.socket.close();
    await waitFor(() => budget.reservedBytes === 0);
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
  readonly close = vi.fn();

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

class SchedulingV2Session implements GatewayV2Session {
  readonly gatewayApiVersion = GATEWAY_API_VERSION;
  readonly started: string[] = [];
  readonly close = vi.fn();
  readonly #firstMutation = deferred<void>();
  #mutationCount = 0;

  async route(input: unknown) {
    const request = parseGatewayRequestEnvelopeV2(input);
    this.started.push(request.requestId);
    if (request.method === "turn/interrupt") {
      this.#mutationCount += 1;
      if (this.#mutationCount === 1) await this.#firstMutation.promise;
    }
    return {
      response: {
        version: 2 as const,
        requestId: request.requestId,
        ok: true as const,
        result: { version: 1 },
      },
      closeConnection: false,
    };
  }

  releaseFirstMutation(): void {
    this.#firstMutation.resolve();
  }
}

class FakeDevices implements GatewayDeviceRegistry {
  readonly #publicKey: Uint8Array;
  readonly #options: {
    readonly matchedDevice?: GatewayTrustedDevice;
    readonly matchError?: unknown;
    readonly verifyError?: unknown;
  };
  constructor(
    publicKey: Uint8Array,
    options: {
      readonly matchedDevice?: GatewayTrustedDevice;
      readonly matchError?: unknown;
      readonly verifyError?: unknown;
    } = {},
  ) {
    this.#publicKey = publicKey;
    this.#options = options;
  }

  consumePairing(input: { deviceId: string; deviceName: string }) {
    return Promise.resolve(this.#device(input.deviceId, input.deviceName));
  }

  verify(deviceId: string): Promise<GatewayTrustedDevice> {
    if (this.#options.verifyError !== undefined) {
      return Promise.reject(this.#options.verifyError);
    }
    return Promise.resolve(this.#device(deviceId, "Phone"));
  }

  match(): Promise<GatewayTrustedDevice | undefined> {
    if (this.#options.matchError !== undefined) {
      return Promise.reject(this.#options.matchError);
    }
    return Promise.resolve(this.#options.matchedDevice);
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

function trustedDevice(
  publicKey: Uint8Array,
  options: { readonly revokedAt?: string } = {},
): GatewayTrustedDevice {
  return {
    id: "browser-1",
    name: "Phone",
    publicKey,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(options.revokedAt === undefined
      ? {}
      : { revokedAt: options.revokedAt }),
  };
}

function trustError(code: "NOT_TRUSTED" | "REVOKED" | "KEY_MISMATCH") {
  return Object.assign(new Error(`Device trust failed: ${code}`), { code });
}

async function startSocketGateway(
  options: Parameters<typeof DirectTransportV2.start>[0],
  budget: SecureMessageAssemblyBudget,
): Promise<number> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
  });
  socketServers.push(server);
  server.on("connection", (socket) =>
    acceptGatewayV2Socket(socket, options, options.parentScope, budget),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test WebSocket server is not listening on TCP");
  }
  return address.port;
}

function sendFirstFragment(
  socket: WebSocket,
  session: SecureSession,
  byteLength: number,
): void {
  const frame = session.encryptMessage(new Uint8Array(byteLength))[0];
  if (frame === undefined) throw new Error("Expected a fragmented frame");
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

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(input: {
  readonly port: number;
  readonly hostPublicKey: Uint8Array;
  readonly deviceKeys: ReturnType<typeof generateStaticKeyPair>;
  readonly auth: Record<string, unknown>;
  readonly autoPong?: boolean;
}) {
  const socket = new WebSocket(`ws://127.0.0.1:${input.port}/gateway`, {
    perMessageDeflate: false,
    autoPong: input.autoPong ?? true,
  });
  socketCloseCodes.set(
    socket,
    new Promise((resolve) => socket.once("close", (code) => resolve(code))),
  );
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
  sendEncryptedRequest(socket, session, request);
  return response;
}

function sendEncryptedRequest(
  socket: WebSocket,
  session: SecureSession,
  request: unknown,
): void {
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
  return (
    socketCloseCodes.get(socket) ??
    new Promise((resolve) => socket.once("close", (code) => resolve(code)))
  );
}
