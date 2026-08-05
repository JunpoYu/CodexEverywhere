import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import {
  NoiseInitiator,
  encodePrologue,
  generateStaticKeyPair,
  type SecureSession,
} from "@codex-everywhere/crypto";
import {
  PROTOCOL_VERSION,
  type GatewayCipherFrame,
  type RequestEnvelope,
} from "@codex-everywhere/protocol";

import { DeviceRegistry } from "../host/devices.js";
import { HostStateStore } from "../host/state-store.js";
import { DirectGateway } from "./direct-gateway.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("DirectGateway", () => {
  it("returns a public profile without opening an authenticated session", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    let sessions = 0;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      loginName: "alice",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      directEndpoint: "wss://hpc.example/gateway",
      relayEndpoint: "wss://relay.example/relay",
      relayRouteId: "route-1",
      allowedOrigin: "https://codex.example",
      state,
      createSession: () => {
        sessions += 1;
        return { request: async () => undefined };
      },
    });
    await expect(
      rejectedWebSocketStatus(
        `ws://127.0.0.1:${gateway.port}/gateway`,
        "https://evil.example",
      ),
    ).resolves.toBe(401);
    const discovered = await fetch(
      `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`,
      { headers: { Origin: "https://codex.example" } },
    );
    expect(discovered.status).toBe(200);
    expect(discovered.headers.get("access-control-allow-origin")).toBe(
      "https://codex.example",
    );
    await expect(discovered.json()).resolves.toMatchObject({
      type: "host/profile",
      directEndpoint: "wss://hpc.example/gateway",
    });
    const preflight = await fetch(
      `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://codex.example",
          "Access-Control-Request-Private-Network": "true",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    const blocked = await fetch(
      `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`,
      { headers: { Origin: "https://evil.example" } },
    );
    expect(blocked.status).toBe(403);
    expect(sessions).toBe(0);
    await gateway.close();
    await state.close();
  });

  it("pairs once, reconnects a trusted device, and exchanges encrypted requests", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const options = {
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      loginName: "alice",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async (request: RequestEnvelope) => request.payload,
      }),
    };
    const gateway = await DirectGateway.start(options);

    const paired = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });
    expect(paired.accepted).toMatchObject({ loginName: "alice" });
    await expect(
      roundTrip(paired.socket, paired.session, { answer: 42 }),
    ).resolves.toEqual({
      answer: 42,
    });
    const largePayload = "x".repeat(3_500_000);
    await expect(
      roundTrip(paired.socket, paired.session, largePayload),
    ).resolves.toBe(largePayload);
    paired.socket.close();
    await onceClosed(paired.socket);

    const trusted = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: { mode: "connect" },
    });
    await expect(
      roundTrip(trusted.socket, trusted.session, "again"),
    ).resolves.toBe("again");
    trusted.socket.close();
    await onceClosed(trusted.socket);

    await gateway.close();
    await state.close();
  }, 30_000);

  it("accepts an unknown device only as a pending login", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    let finishAuthentication: (() => Promise<void>) | undefined;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: (_device, context) => {
        finishAuthentication = context.onAuthenticated;
        return { request: async () => "pending" };
      },
    });

    const pending = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "login",
        deviceName: "New browser",
        rememberDevice: true,
      },
    });
    const devices = new DeviceRegistry(state);
    await expect(devices.get("browser-1")).resolves.toBeUndefined();
    expect(finishAuthentication).toBeTypeOf("function");
    await finishAuthentication!();
    await expect(devices.get("browser-1")).resolves.toMatchObject({
      name: "New browser",
    });

    pending.socket.close();
    await onceClosed(pending.socket);
    await gateway.close();
    await state.close();
  });

  it("does not let a slow read block a later mutation", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    let finishRead: (() => void) | undefined;
    const readPending = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let mutationStarted: (() => void) | undefined;
    const mutationSeen = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async (request: RequestEnvelope) => {
          if (request.method === "thread/read") {
            markReadStarted?.();
            await readPending;
          }
          if (request.method === "turn/start") mutationStarted?.();
          return {};
        },
      }),
    });
    const client = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });

    sendRequest(client.socket, client.session, "thread/read", {});
    await readStarted;
    sendRequest(client.socket, client.session, "turn/start", {});
    await expect(
      Promise.race([
        mutationSeen.then(() => "started"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), 250),
        ),
      ]),
    ).resolves.toBe("started");

    finishRead?.();
    client.socket.close();
    await onceClosed(client.socket);
    await gateway.close();
    await state.close();
  });
});

async function connectClient(input: {
  port: number;
  deviceKeys: ReturnType<typeof generateStaticKeyPair>;
  hostPublicKey: Uint8Array;
  auth: Record<string, unknown>;
}): Promise<{
  socket: WebSocket;
  session: SecureSession;
  accepted: Record<string, unknown>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${input.port}/gateway`, {
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const prologue = encodePrologue({
    version: 1,
    userId: "unix:1000",
    nodeId: "node-1",
    deviceId: "browser-1",
  });
  const handshake = new NoiseInitiator(
    input.deviceKeys,
    input.hostPublicKey,
    prologue,
  );
  socket.send(
    JSON.stringify({
      type: "handshake/hello",
      version: PROTOCOL_VERSION,
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
  const accepted = JSON.parse(
    Buffer.from(completed.payload).toString(),
  ) as Record<string, unknown>;
  expect(accepted).toMatchObject({ ok: true });
  return { socket, session: completed.session, accepted };
}

async function roundTrip(
  socket: WebSocket,
  session: SecureSession,
  payload: unknown,
): Promise<unknown> {
  const requestNumber = ++requestCounter;
  const encrypted = session.encryptMessage(
    Buffer.from(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId: `request-${requestNumber}`,
        idempotencyKey: `idempotency-${requestNumber}`,
        method: "test/echo",
        payload,
      }),
    ),
  );
  const response = nextEncryptedMessage(socket, session);
  for (const frame of encrypted) {
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
  const value = JSON.parse(Buffer.from(await response).toString()) as {
    ok: boolean;
    result: unknown;
  };
  expect(value.ok).toBe(true);
  return value.result;
}

let requestCounter = 0;

function sendRequest(
  socket: WebSocket,
  session: SecureSession,
  method: string,
  payload: unknown,
): void {
  const requestNumber = ++requestCounter;
  const frames = session.encryptMessage(
    Buffer.from(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId: `request-${requestNumber}`,
        idempotencyKey: `idempotency-${requestNumber}`,
        method,
        payload,
      }),
    ),
  );
  for (const frame of frames) {
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

function nextMessage(socket: WebSocket): Promise<RawData> {
  return new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
}

function nextEncryptedMessage(
  socket: WebSocket,
  session: SecureSession,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const handleMessage = (data: RawData) => {
      try {
        const wire = JSON.parse(data.toString()) as GatewayCipherFrame;
        const plaintext = session.decryptMessage({
          sessionId: wire.sessionId,
          sequence: wire.sequence,
          ciphertext: Buffer.from(wire.ciphertext, "base64url"),
        });
        if (!plaintext) return;
        cleanup();
        resolve(plaintext);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Decrypt failed"));
      }
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", handleMessage);
      socket.off("error", handleError);
    };
    socket.on("message", handleMessage);
    socket.once("error", handleError);
  });
}

function onceClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

function rejectedWebSocketStatus(
  endpoint: string,
  origin: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { origin });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("Unexpectedly accepted WebSocket origin"));
    });
    socket.once("error", () => undefined);
  });
}

async function stateStore(): Promise<HostStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "ce-gateway-test-"));
  temporaryDirectories.push(directory);
  return HostStateStore.open(join(directory, "state.sqlite"));
}
