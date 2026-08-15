import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthnMocks = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({ saveHost: vi.fn() }));

vi.mock("@simplewebauthn/browser", () => webauthnMocks);
vi.mock("./storage.js", () => storageMocks);

import {
  NoiseResponder,
  SecureSession,
  base64UrlToBytes,
  bytesToBase64Url,
  encodePrologue,
  generateStaticKeyPair,
} from "@codex-everywhere/crypto";
import {
  GATEWAY_CAPABILITIES,
  PROTOCOL_VERSION,
  parseGatewayCipherFrame,
} from "@codex-everywhere/protocol";

import {
  GatewayClient,
  GatewayInteractiveReauthenticationFailed,
  GatewayReauthenticationRequired,
  GatewayResponseError,
  GatewayRequestOutcomeUnknownError,
  connectionTargets,
  firstAvailableTarget,
  isGatewayRequestOutcomeUnknown,
  validatePairingDocument,
  type PairingDocument,
} from "./gateway-client.js";
import type { SavedHost } from "./storage.js";

const RESUME_TOKEN = "resume-token".padEnd(43, "R");

beforeEach(() => {
  webauthnMocks.startAuthentication.mockReset();
  webauthnMocks.startRegistration.mockReset();
  storageMocks.saveHost.mockReset();
  webauthnMocks.startAuthentication.mockResolvedValue({
    response: { userHandle: null },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pairing: PairingDocument = {
  version: 1,
  transport: "relay",
  endpoint: "wss://codex.example/relay",
  routeId: "opaque-route",
  nodeId: "node-1",
  userId: "unix:1000",
  loginName: "alice",
  hostPublicKey: "public-key",
  hostFingerprint: "fingerprint",
  pairingId: "pairing-1",
  secret: "secret",
  expiresAt: "2000-01-01T00:00:00.000Z",
};

describe("pairing document validation", () => {
  it("leaves expiration decisions to the issuing host clock", () => {
    expect(() => validatePairingDocument(pairing)).not.toThrow();
  });

  it("still rejects malformed timestamps", () => {
    expect(() =>
      validatePairingDocument({ ...pairing, expiresAt: "not-a-date" }),
    ).toThrow("格式无效");
  });

  it("rejects a malformed Linux login name field", () => {
    expect(() =>
      validatePairingDocument({ ...pairing, loginName: 1000 } as never),
    ).toThrow("格式无效");
  });
});

describe("connection target selection", () => {
  it("discovers a Direct gateway from the standard HTTPS document", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "host/profile",
            version: 1,
            nodeId: "node-1",
            userId: "unix:1000",
            hostPublicKey: "A".repeat(43),
            hostFingerprint: `sha256:${"B".repeat(43)}`,
            directEndpoint: "wss://hpc.example/gateway",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      GatewayClient.discoverDirect("https://hpc.example/ignored"),
    ).resolves.toMatchObject({
      transport: "direct",
      endpoint: "wss://hpc.example/gateway",
      nodeId: "node-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://hpc.example/.well-known/codex-everywhere"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("tries Direct before Relay while retaining legacy endpoint compatibility", () => {
    const host: SavedHost = {
      id: "node-1",
      name: "alice",
      endpoint: "wss://relay.example/relay",
      transport: "relay",
      directEndpoint: "wss://hpc.example/gateway",
      relayEndpoint: "wss://relay.example/relay",
      routeId: "route-1",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: "A".repeat(43),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: "public-key",
      deviceSecretKey: "secret-key",
    };

    expect(connectionTargets(host)).toEqual([
      { transport: "direct", endpoint: "wss://hpc.example/gateway" },
      { transport: "relay", endpoint: "wss://relay.example/relay" },
    ]);
  });

  it("falls back to Relay only after Direct fails", async () => {
    const attempts: string[] = [];
    const result = await firstAvailableTarget(
      [
        { transport: "direct", endpoint: "wss://hpc.example/gateway" },
        { transport: "relay", endpoint: "wss://relay.example/relay" },
      ],
      async (target) => {
        attempts.push(target.transport);
        if (target.transport === "direct") throw new Error("unreachable");
        return "connected";
      },
    );

    expect(result).toBe("connected");
    expect(attempts).toEqual(["direct", "relay"]);
  });

  it("fails closed when a Host handshake reply uses another version", async () => {
    class WrongVersionWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;

      readyState = WrongVersionWebSocket.CONNECTING;

      constructor(_endpoint: string) {
        super();
        queueMicrotask(() => {
          this.readyState = WrongVersionWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
        });
      }

      send(data: string): void {
        const value = JSON.parse(data) as { type?: string };
        if (value.type !== "handshake/hello") return;
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "handshake/reply",
                version: 2,
                message: "YWJj",
              }),
            }),
          ),
        );
      }

      close(): void {
        this.readyState = WrongVersionWebSocket.CLOSED;
      }
    }
    vi.stubGlobal("WebSocket", WrongVersionWebSocket);
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const host: SavedHost = {
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    };

    await expect(GatewayClient.connect(host)).rejects.toThrow(
      "Invalid gateway handshake reply",
    );
  });
});

describe("ambiguous gateway request outcomes", () => {
  it("keeps a temporary Passkey device identity stable across reconnects", async () => {
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.loginWithPasskey(
      {
        version: 1,
        transport: "direct",
        endpoint: "wss://hpc.example/gateway",
        nodeId: "node-1",
        userId: "unix:1000",
        hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
        hostFingerprint: `sha256:${"B".repeat(43)}`,
      },
      {
        loginName: "alice",
        deviceName: "Temporary browser",
        rememberDevice: false,
      },
    );
    const originalIdentity = {
      deviceId: client.host.deviceId,
      publicKey: client.host.devicePublicKey,
      secretKey: client.host.deviceSecretKey,
    };

    const reconnected = await client.reconnect();

    expect(simulation.loginOptionDiscoverability()).toEqual([false]);
    expect(client.canReconnectSilently).toBe(true);
    expect(reconnected.host).toMatchObject({
      deviceId: originalIdentity.deviceId,
      devicePublicKey: originalIdentity.publicKey,
      deviceSecretKey: originalIdentity.secretKey,
    });
  });

  it("keeps a resume token only in memory and uses it for silent reconnect", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    const reconnected = await client.reconnect({ allowInteractive: false });

    expect(client.canReconnectSilently).toBe(true);
    expect(reconnected.canReconnectSilently).toBe(true);
    expect(simulation.handshakeModes()).toEqual(["connect", "resume"]);
    expect(JSON.stringify(client.host)).not.toContain("resume-token");
    expect(JSON.stringify(client)).not.toContain("resume-token");
  });

  it("negotiates optional encrypted Gateway capabilities", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const capable = simulatedHostWebSocket(hostIdentity, {
      capabilities: [GATEWAY_CAPABILITIES.sideForkV1],
    });
    vi.stubGlobal("WebSocket", capable.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    expect(client.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1)).toBe(
      true,
    );
    client.close();

    const legacy = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", legacy.WebSocketClass);
    const legacyClient = await GatewayClient.connect({
      ...client.host,
      deviceId: "legacy-device",
    });
    expect(
      legacyClient.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1),
    ).toBe(false);
    legacyClient.close();
  });

  it("defers interactive authentication when an in-memory resume token is rejected", async () => {
    const dispose = vi.spyOn(SecureSession.prototype, "dispose");
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      rejectResume: true,
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    const disposalsBeforeResume = dispose.mock.calls.length;
    try {
      await expect(
        client.reconnect({ allowInteractive: false }),
      ).rejects.toBeInstanceOf(GatewayReauthenticationRequired);
      expect(client.canReconnectSilently).toBe(false);
      expect(simulation.handshakeModes()).toEqual(["connect", "resume"]);
      expect(dispose.mock.calls.length).toBe(disposalsBeforeResume + 1);

      const reauthenticated = await client.reconnect({
        allowInteractive: true,
      });
      expect(reauthenticated.canReconnectSilently).toBe(true);
      expect(simulation.handshakeModes()).toEqual([
        "connect",
        "resume",
        "login",
      ]);
      expect(simulation.handshakeAuthentications().at(-1)).toMatchObject({
        mode: "login",
        rememberDevice: true,
      });
      expect(simulation.loginOptionDiscoverability()).toEqual([false, false]);
    } finally {
      dispose.mockRestore();
    }
  });

  it("sends an explicit page-session release before discarding its resume token", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    expect(client.canReconnectSilently).toBe(true);

    client.releasePageSession();

    expect(client.canReconnectSilently).toBe(false);
    expect(simulation.socket().lastRequest).toMatchObject({
      method: "auth/session/release",
      payload: { version: 1 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
  });

  it("waits for a confirmed page-session release before clearing recovery", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    await expect(client.releasePageSessionConfirmed()).resolves.toBe(true);
    expect(client.canReconnectSilently).toBe(false);
    expect(simulation.socket().lastRequest).toMatchObject({
      method: "auth/session/release",
      payload: { version: 1 },
    });
  });

  it("enables acknowledged continuity only when the Host advertises it", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      capabilities: [GATEWAY_CAPABILITIES.sideContinuityAckV1],
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    await expect(client.enableSideContinuityAcknowledgements()).resolves.toBe(
      true,
    );
    expect(simulation.socket().lastRequest).toMatchObject({
      method: "auth/session/events/enable",
      payload: { version: 1 },
    });
    client.onEvent(() => undefined);
    simulation.socket().deliverServerEnvelope({
      version: 1,
      eventId: "side-event-1",
      cursor: "1",
      type: "turn/started",
      payload: { threadId: "side-1" },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(simulation.socket().lastRequest).toMatchObject({
      method: "auth/session/events/ack",
      payload: { version: 1, eventId: "side-event-1" },
    });
    client.close();
  });

  it("does not send continuity acknowledgements to an older Agent", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      capabilities: [GATEWAY_CAPABILITIES.sideForkV1],
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    await expect(client.enableSideContinuityAcknowledgements()).resolves.toBe(
      false,
    );
    const requestBeforeEvent = simulation.socket().lastRequest;
    client.onEvent(() => undefined);
    simulation.socket().deliverServerEnvelope({
      version: 1,
      eventId: "legacy-event",
      cursor: "1",
      type: "turn/started",
      payload: { threadId: "side-1" },
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(simulation.socket().lastRequest).toBe(requestBeforeEvent);
    client.close();
  });

  it("retries a lost continuity acknowledgement until the Host responds", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      capabilities: [GATEWAY_CAPABILITIES.sideContinuityAckV1],
      dropContinuityAckResponses: 1,
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    await client.enableSideContinuityAcknowledgements();
    client.onEvent(() => undefined);
    simulation.socket().deliverServerEnvelope({
      version: 1,
      eventId: "overflow-event",
      cursor: "4097",
      type: "gateway/session/continuity-overflow",
      payload: { version: 1, reason: "buffer-limit", threadId: "side-1" },
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(simulation.continuityAckRequests()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_100);
    expect(simulation.continuityAckRequests()).toBe(2);
    expect(simulation.socket().lastRequest).toMatchObject({
      method: "auth/session/events/ack",
      payload: { version: 1, eventId: "overflow-event" },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(simulation.continuityAckRequests()).toBe(2);
    client.close();
  });

  it("falls back to the buffered Side event when a newer live-only event is not acknowledged", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      capabilities: [GATEWAY_CAPABILITIES.sideContinuityAckV1],
      acknowledgeContinuityEvent: (eventId) => eventId === "side-buffered",
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    await client.enableSideContinuityAcknowledgements();
    client.onEvent(() => undefined);
    simulation.socket().deliverServerEnvelope({
      version: 1,
      eventId: "side-buffered",
      cursor: "1",
      type: "turn/completed",
      payload: { threadId: "side-1" },
    });
    simulation.socket().deliverServerEnvelope({
      version: 1,
      eventId: "live-only",
      cursor: "2",
      type: "queue/updated",
      payload: { threadId: "other-thread" },
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(simulation.continuityAckEventIds()).toEqual(["live-only"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(simulation.continuityAckEventIds()).toEqual([
      "live-only",
      "side-buffered",
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(simulation.continuityAckEventIds()).toHaveLength(2);
    client.close();
  });

  it("cancels continuity acknowledgement retries when the transport closes", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      capabilities: [GATEWAY_CAPABILITIES.sideContinuityAckV1],
      dropContinuityAckResponses: 10,
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    await client.enableSideContinuityAcknowledgements();
    client.onEvent(() => undefined);
    simulation.socket().deliverServerEnvelope({
      version: 1,
      eventId: "side-event-before-close",
      cursor: "2",
      type: "turn/completed",
      payload: { threadId: "side-1" },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(simulation.continuityAckRequests()).toBe(1);

    simulation.socket().close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(simulation.continuityAckRequests()).toBe(1);
  });

  it("does not retry WebAuthn after visible reauthentication is cancelled", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      rejectResume: true,
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    await expect(
      client.reconnect({ allowInteractive: false }),
    ).rejects.toBeInstanceOf(GatewayReauthenticationRequired);
    const cancelled = new DOMException(
      "The operation was cancelled",
      "NotAllowedError",
    );
    webauthnMocks.startAuthentication.mockRejectedValueOnce(cancelled);

    await expect(
      client.reconnect({ allowInteractive: true }),
    ).rejects.toMatchObject({
      name: "GatewayInteractiveReauthenticationFailed",
      cause: cancelled,
    } satisfies Partial<GatewayInteractiveReauthenticationFailed>);
    expect(simulation.handshakeModes()).toEqual(["connect", "resume", "login"]);
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledTimes(2);
    expect(simulation.socket().readyState).toBe(3);
  });

  it("rechecks visibility after an in-flight resume rejection before opening WebAuthn", async () => {
    let canInteract = true;
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      rejectResume: true,
      onResumeHello: () => {
        canInteract = false;
      },
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    await expect(
      client.reconnect({ canInteract: () => canInteract }),
    ).rejects.toBeInstanceOf(GatewayReauthenticationRequired);
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledTimes(1);
    expect(simulation.handshakeModes()).toEqual(["connect", "resume"]);

    canInteract = true;
    webauthnMocks.startAuthentication.mockResolvedValue({
      response: { userHandle: bytesToBase64Url(hostIdentity.publicKey) },
    });
    await expect(
      client.reconnect({ canInteract: () => canInteract }),
    ).resolves.toBeInstanceOf(GatewayClient);
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledTimes(2);
    expect(simulation.handshakeModes()).toEqual(["connect", "resume", "login"]);
  });

  it("keeps retrying transport failures that happen before WebAuthn starts", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity, {
      rejectResume: true,
    });
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    await expect(
      client.reconnect({ allowInteractive: false }),
    ).rejects.toBeInstanceOf(GatewayReauthenticationRequired);
    simulation.failNextLoginOptions();

    const failedBeforeInteraction = await client
      .reconnect({ allowInteractive: true })
      .catch((error: unknown) => error);
    expect(failedBeforeInteraction).not.toBeInstanceOf(
      GatewayInteractiveReauthenticationFailed,
    );
    expect(failedBeforeInteraction).toMatchObject({
      name: "GatewayRequestOutcomeUnknownError",
      transportLost: true,
    });
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledTimes(1);

    webauthnMocks.startAuthentication.mockResolvedValue({
      response: { userHandle: bytesToBase64Url(hostIdentity.publicKey) },
    });
    await expect(
      client.reconnect({ allowInteractive: true }),
    ).resolves.toBeInstanceOf(GatewayClient);
    expect(webauthnMocks.startAuthentication).toHaveBeenCalledTimes(2);
    expect(simulation.handshakeModes()).toEqual([
      "connect",
      "resume",
      "login",
      "login",
    ]);
  });

  it("retains the mutation idempotency key for caller-driven reconciliation", () => {
    const error = new GatewayRequestOutcomeUnknownError(
      "turn/start",
      "stable-operation-1",
      new Error("Host connection closed"),
    );

    expect(isGatewayRequestOutcomeUnknown(error)).toBe(true);
    expect(error).toMatchObject({
      method: "turn/start",
      idempotencyKey: "stable-operation-1",
      transportLost: false,
    });
    expect(error.message).toContain("outcome unknown");
  });

  it("does not classify an explicit Host rejection as an unknown outcome", () => {
    expect(isGatewayRequestOutcomeUnknown(new Error("request rejected"))).toBe(
      false,
    );
  });

  it("preserves the Host protocol error code for safe caller decisions", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    const pending = client.request("thread/start", { cwd: "/work" });
    const socket = simulation.socket();
    socket.deliverServerEnvelope({
      version: 1,
      requestId: socket.lastRequest?.requestId,
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        message: "Outcome cannot be replayed safely",
        retryable: false,
      },
    });

    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        name: "GatewayResponseError",
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      }),
    );
    await expect(pending).rejects.toBeInstanceOf(GatewayResponseError);
  });

  it("fails closed on a malformed decrypted response without losing the idempotency key", async () => {
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const host: SavedHost = {
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    };
    const client = await GatewayClient.connect(host);
    const pending = client.request(
      "turn/start",
      {},
      {
        idempotencyKey: "stable-operation-2",
      },
    );
    const socket = simulation.socket();
    expect(socket.lastRequest).toMatchObject({ method: "turn/start" });

    socket.deliverServerEnvelope({
      version: 1,
      requestId: socket.lastRequest?.requestId,
      ok: false,
      // A failed response requires a structured ProtocolError.
    });

    await expect(pending).rejects.toMatchObject({
      name: "GatewayRequestOutcomeUnknownError",
      method: "turn/start",
      idempotencyKey: "stable-operation-2",
      transportLost: true,
    });
  });

  it("times out only the slow request while keeping a healthy tunnel usable", async () => {
    vi.useFakeTimers();
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });

    const pending = client.request(
      "thread/read",
      { threadId: "slow-thread" },
      { timeoutMs: 10, idempotencyKey: "slow-read-1" },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "GatewayRequestOutcomeUnknownError",
      transportLost: false,
    });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;

    await expect(client.healthCheck(100)).resolves.toBeUndefined();
    expect(simulation.socket().readyState).toBe(WebSocket.OPEN);
  });

  it("marks pending outcomes as transport-lost after an actual socket close", async () => {
    const dispose = vi.spyOn(SecureSession.prototype, "dispose");
    const device = generateStaticKeyPair();
    const hostIdentity = generateStaticKeyPair();
    const simulation = simulatedHostWebSocket(hostIdentity);
    vi.stubGlobal("WebSocket", simulation.WebSocketClass);
    const client = await GatewayClient.connect({
      id: "node-1",
      name: "alice",
      endpoint: "wss://hpc.example/gateway",
      transport: "direct",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: bytesToBase64Url(hostIdentity.publicKey),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: bytesToBase64Url(device.publicKey),
      deviceSecretKey: bytesToBase64Url(device.secretKey),
    });
    const disposalsBeforeClose = dispose.mock.calls.length;
    try {
      const lost = vi.fn();
      client.onConnectionLost(lost);
      const pending = client.request("thread/read", { threadId: "thread-1" });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "GatewayRequestOutcomeUnknownError",
        transportLost: true,
      });

      simulation.socket().close();

      await rejected;
      expect(lost).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledTimes(disposalsBeforeClose + 1);
      client.close();
      expect(dispose).toHaveBeenCalledTimes(disposalsBeforeClose + 1);
    } finally {
      dispose.mockRestore();
    }
  });
});

function simulatedHostWebSocket(
  hostIdentity: ReturnType<typeof generateStaticKeyPair>,
  options: {
    rejectResume?: boolean;
    onResumeHello?: () => void;
    capabilities?: string[];
    dropContinuityAckResponses?: number;
    acknowledgeContinuityEvent?: (eventId: string) => boolean;
  } = {},
): {
  WebSocketClass: typeof WebSocket;
  socket(): SimulatedHostSocket;
  handshakeModes(): string[];
  handshakeAuthentications(): Record<string, unknown>[];
  loginOptionDiscoverability(): unknown[];
  continuityAckRequests(): number;
  continuityAckEventIds(): string[];
  failNextLoginOptions(): void;
} {
  let current: SimulatedHostSocket | undefined;
  const handshakeModes: string[] = [];
  const handshakeAuthentications: Record<string, unknown>[] = [];
  const loginOptionDiscoverability: unknown[] = [];
  let failNextLoginOptions = false;
  let continuityAckRequests = 0;
  const continuityAckEventIds: string[] = [];
  let remainingDroppedContinuityAckResponses =
    options.dropContinuityAckResponses ?? 0;

  class SimulatedHostSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = SimulatedHostSocket.CONNECTING;
    serverSession: SecureSession | undefined;
    lastRequest:
      | {
          requestId: string;
          method: string;
          payload?: Record<string, unknown>;
        }
      | undefined;

    constructor(_endpoint: string) {
      super();
      current = this;
      queueMicrotask(() => {
        this.readyState = SimulatedHostSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(data: string): void {
      const value = JSON.parse(data) as Record<string, unknown>;
      if (value.type === "handshake/hello") {
        const responder = new NoiseResponder(
          hostIdentity,
          encodePrologue({
            version: 1,
            userId: "unix:1000",
            nodeId: "node-1",
            deviceId: String(value.deviceId),
          }),
        );
        const authPayload = responder.receive(
          base64UrlToBytes(String(value.message)),
        );
        const auth = JSON.parse(
          new TextDecoder().decode(authPayload),
        ) as Record<string, unknown> & { mode: string };
        handshakeModes.push(auth.mode);
        handshakeAuthentications.push(auth);
        if (auth.mode === "resume") options.onResumeHello?.();
        const completed = responder.finish(
          new TextEncoder().encode(
            JSON.stringify({
              version: PROTOCOL_VERSION,
              ...(auth.mode === "resume" && options.rejectResume
                ? {
                    ok: false,
                    error: { code: "REAUTH_REQUIRED" },
                  }
                : {
                    ok: true,
                    principal: "user",
                    loginName: "alice",
                    ...(options.capabilities
                      ? { capabilities: options.capabilities }
                      : {}),
                  }),
            }),
          ),
        );
        this.serverSession = completed.session;
        this.deliverRaw({
          type: "handshake/reply",
          version: PROTOCOL_VERSION,
          message: bytesToBase64Url(completed.message),
        });
        if (auth.mode === "resume" && options.rejectResume) {
          // A reverse proxy is allowed to strip the close reason. The Noise
          // result above remains the authoritative reauthentication signal.
          queueMicrotask(() => this.close());
        }
        return;
      }
      if (value.type !== "cipher" || !this.serverSession) return;
      const wire = parseGatewayCipherFrame(value);
      const plaintext = this.serverSession.decryptMessage({
        sessionId: wire.sessionId,
        sequence: wire.sequence,
        ciphertext: base64UrlToBytes(wire.ciphertext),
      });
      if (!plaintext) return;
      const request = JSON.parse(new TextDecoder().decode(plaintext)) as {
        requestId: string;
        method: string;
        payload?: Record<string, unknown>;
      };
      this.lastRequest = request;
      if (request.method === "auth/session/events/ack") {
        continuityAckRequests += 1;
        const eventId = String(request.payload?.eventId ?? "");
        continuityAckEventIds.push(eventId);
        if (remainingDroppedContinuityAckResponses > 0) {
          remainingDroppedContinuityAckResponses -= 1;
          return;
        }
        this.deliverServerEnvelope({
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result: {
            version: 1,
            acknowledged: options.acknowledgeContinuityEvent?.(eventId) ?? true,
          },
        });
        return;
      }
      if (request.method === "auth/login/options") {
        loginOptionDiscoverability.push(request.payload?.discoverable);
      }
      if (request.method === "auth/login/options" && failNextLoginOptions) {
        failNextLoginOptions = false;
        queueMicrotask(() => this.close());
        return;
      }
      if (
        request.method === "auth/status" ||
        request.method === "auth/login/options" ||
        request.method === "auth/login/verify" ||
        request.method === "auth/session/release" ||
        request.method === "auth/session/events/enable" ||
        request.method === "host/ping"
      ) {
        this.deliverServerEnvelope({
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result: (() => {
            switch (request.method) {
              case "auth/status":
                return {
                  authenticated: false,
                  registrationRequired: false,
                };
              case "auth/login/options":
                return {};
              case "auth/login/verify":
                return { authenticated: true, resumeToken: RESUME_TOKEN };
              case "auth/session/events/enable":
                return { version: 1, enabled: true };
              case "auth/session/release":
                return { version: 1, released: 1 };
              default:
                return { ok: true };
            }
          })(),
        });
      }
    }

    deliverServerEnvelope(value: unknown): void {
      if (!this.serverSession) throw new Error("Handshake is incomplete");
      const frames = this.serverSession.encryptMessage(
        new TextEncoder().encode(JSON.stringify(value)),
      );
      for (const frame of frames) {
        this.deliverRaw({
          type: "cipher",
          version: PROTOCOL_VERSION,
          sessionId: frame.sessionId,
          sequence: frame.sequence,
          ciphertext: bytesToBase64Url(frame.ciphertext),
        });
      }
    }

    deliverRaw(value: unknown): void {
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", { data: JSON.stringify(value) }),
        ),
      );
    }

    close(): void {
      if (this.readyState === SimulatedHostSocket.CLOSED) return;
      this.readyState = SimulatedHostSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }

    closeWithReason(reason: string): void {
      if (this.readyState === SimulatedHostSocket.CLOSED) return;
      this.readyState = SimulatedHostSocket.CLOSED;
      const event = new Event("close");
      Object.defineProperty(event, "reason", { value: reason });
      this.dispatchEvent(event);
    }
  }

  return {
    WebSocketClass: SimulatedHostSocket as unknown as typeof WebSocket,
    socket: () => {
      if (!current) throw new Error("WebSocket was not created");
      return current;
    },
    handshakeModes: () => [...handshakeModes],
    handshakeAuthentications: () =>
      handshakeAuthentications.map((authentication) => ({
        ...authentication,
      })),
    loginOptionDiscoverability: () => [...loginOptionDiscoverability],
    continuityAckRequests: () => continuityAckRequests,
    continuityAckEventIds: () => [...continuityAckEventIds],
    failNextLoginOptions: () => {
      failNextLoginOptions = true;
    },
  };
}

type SimulatedHostSocket = EventTarget & {
  readyState: number;
  lastRequest:
    | {
        requestId: string;
        method: string;
        payload?: Record<string, unknown>;
      }
    | undefined;
  deliverServerEnvelope(value: unknown): void;
  close(): void;
};
