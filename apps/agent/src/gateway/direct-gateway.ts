import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import {
  NoiseResponder,
  SecureMessageAssemblyBudget,
  encodePrologue,
  type SecureSession,
  type StaticKeyPair,
} from "@codex-everywhere/crypto";
import {
  GATEWAY_CAPABILITIES,
  PROTOCOL_VERSION,
  parseGatewayAuthenticationPayload,
  type GatewayCipherFrame,
  type GatewayAuthenticationPayload,
  type EventEnvelope,
  type GatewayHandshakeHello,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "@codex-everywhere/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  DeviceRegistry,
  DeviceTrustError,
  type TrustedDevice,
} from "../host/devices.js";
import {
  EphemeralIdempotencyRegistry,
  IdempotencyRegistry,
  type IdempotentResult,
  usesDurableMutationClaim,
  usesEphemeralGatewayIdempotency,
} from "../host/idempotency.js";
import type { HostStateStore } from "../host/state-store.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_GATEWAY_REASSEMBLED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_GATEWAY_CONNECTIONS = 128;
const MAX_GATEWAY_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const GATEWAY_FRAGMENT_ASSEMBLY_TIMEOUT_MS = 10_000;
const GATEWAY_HEARTBEAT_MS = 15_000;
const GATEWAY_HEARTBEAT_MISS_LIMIT = 4;
const SLOW_REQUEST_THRESHOLD_MS = 5_000;
const assemblyBudgets = new WeakMap<
  DirectGatewayOptions,
  SecureMessageAssemblyBudget
>();

export type GatewaySession = {
  request(request: RequestEnvelope): Promise<unknown>;
  validateDurableResult?(
    request: RequestEnvelope,
    result: unknown,
  ): Promise<void> | void;
  onEvent?(listener: (event: EventEnvelope) => void): () => void;
  onClose?(listener: () => void): () => void;
  close?(): Promise<void> | void;
};

export type DirectGatewayOptions = {
  host: string;
  port: number;
  path?: string;
  nodeId: string;
  userId: string;
  principal?: "user" | "host-admin";
  loginName?: string;
  identity: StaticKeyPair;
  hostFingerprint: string;
  directEndpoint?: string;
  relayEndpoint?: string;
  relayRouteId?: string;
  allowedOrigin?: string;
  /** WebSocket ping interval. Primarily configurable for deterministic tests. */
  gatewayHeartbeatMs?: number;
  /** Consecutive unanswered pings tolerated before terminating the socket. */
  gatewayHeartbeatMissLimit?: number;
  state: HostStateStore;
  createSession(
    device: TrustedDevice,
    context: {
      newlyPaired: boolean;
      rememberedDevice: boolean;
      resumeRememberedDeviceInvalid?: boolean;
      resumeToken?: string;
      onAuthenticated?: () => Promise<(() => Promise<void> | void) | void>;
    },
  ): Promise<GatewaySession> | GatewaySession;
};

export class DirectGateway extends EventEmitter<{ listening: [number] }> {
  readonly #server: WebSocketServer;
  readonly #httpServer: HttpServer;
  readonly #options: DirectGatewayOptions;
  readonly #connections = new Set<WebSocket>();

  private constructor(
    server: WebSocketServer,
    httpServer: HttpServer,
    options: DirectGatewayOptions,
  ) {
    super();
    this.#server = server;
    this.#httpServer = httpServer;
    this.#options = options;
    server.on("connection", (socket) => this.#accept(socket));
  }

  static async start(options: DirectGatewayOptions): Promise<DirectGateway> {
    const heartbeatMs = options.gatewayHeartbeatMs ?? GATEWAY_HEARTBEAT_MS;
    const heartbeatMissLimit =
      options.gatewayHeartbeatMissLimit ?? GATEWAY_HEARTBEAT_MISS_LIMIT;
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0)
      throw new Error("Gateway heartbeat interval must be positive");
    if (!Number.isSafeInteger(heartbeatMissLimit) || heartbeatMissLimit <= 0)
      throw new Error("Gateway heartbeat miss limit must be positive");
    const httpServer = createServer((request, response) =>
      handleHttpRequest(request, response, options),
    );
    const server = new WebSocketServer({
      server: httpServer,
      path: options.path ?? "/gateway",
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      verifyClient: (info: { origin: string }) =>
        options.allowedOrigin === undefined ||
        info.origin === options.allowedOrigin,
    });
    const gateway = new DirectGateway(server, httpServer, options);
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        httpServer.off("listening", resolve);
        reject(error);
      };
      httpServer.once("listening", resolve);
      httpServer.once("error", failed);
      httpServer.listen(options.port, options.host);
    });
    gateway.emit("listening", gateway.port);
    return gateway;
  }

  get port(): number {
    const address = this.#httpServer.address();
    if (!address || typeof address === "string")
      throw new Error("Gateway is not listening");
    return address.port;
  }

  async close(): Promise<void> {
    for (const connection of this.#connections)
      connection.close(1001, "gateway stopping");
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      this.#httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #accept(socket: WebSocket): void {
    if (this.#connections.size >= MAX_GATEWAY_CONNECTIONS) {
      socket.close(1013, "gateway busy");
      return;
    }
    this.#connections.add(socket);
    const stopHeartbeat = startGatewayHeartbeat(
      socket,
      this.#options.gatewayHeartbeatMs ?? GATEWAY_HEARTBEAT_MS,
      this.#options.gatewayHeartbeatMissLimit ?? GATEWAY_HEARTBEAT_MISS_LIMIT,
    );
    socket.once("close", () => {
      stopHeartbeat();
      this.#connections.delete(socket);
    });
    acceptGatewaySocket(socket, this.#options);
  }
}

function startGatewayHeartbeat(
  socket: WebSocket,
  heartbeatMs: number,
  heartbeatMissLimit: number,
): () => void {
  let unansweredPings = 0;
  const receivedPong = () => {
    unansweredPings = 0;
  };
  socket.on("pong", receivedPong);
  const heartbeat = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (unansweredPings >= heartbeatMissLimit) {
      socket.terminate();
      return;
    }
    unansweredPings += 1;
    socket.ping();
  }, heartbeatMs);
  heartbeat.unref?.();
  return () => {
    clearInterval(heartbeat);
    socket.off("pong", receivedPong);
  };
}

export function acceptGatewaySocket(
  socket: WebSocket,
  options: DirectGatewayOptions,
): void {
  const connection = new GatewayConnection(socket, options);
  connection.run().catch((error: unknown) => {
    const rejection = gatewayRejection(error);
    console.error(
      JSON.stringify({
        level: "warn",
        event: "gateway.handshake_rejected",
        reason: rejection.reason,
        detail: rejection.detail,
      }),
    );
    socket.close(1008, rejection.reason);
  });
}

function gatewayRejection(error: unknown): {
  reason: string;
  detail: string;
} {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 200)
      : "Unknown gateway error";
  if (detail.includes("Pairing grant has expired"))
    return { reason: "pairing expired", detail };
  if (detail.includes("Pairing grant is invalid or already used"))
    return { reason: "pairing invalid", detail };
  if (detail.includes("Wrong node")) return { reason: "wrong node", detail };
  if (detail.includes("REAUTH_REQUIRED"))
    return { reason: "REAUTH_REQUIRED", detail };
  return { reason: "protocol error", detail };
}

class GatewayConnection {
  readonly #socket: WebSocket;
  readonly #options: DirectGatewayOptions;
  #session: SecureSession | undefined;
  #handler: GatewaySession | undefined;
  #trustedDeviceId: string | undefined;
  #unsubscribe: (() => void) | undefined;
  #receiveQueue: Promise<void> = Promise.resolve();
  #mutationQueue: Promise<void> = Promise.resolve();
  readonly #ephemeralIdempotency = new EphemeralIdempotencyRegistry();

  constructor(socket: WebSocket, options: DirectGatewayOptions) {
    this.#socket = socket;
    this.#options = options;
  }

  async run(): Promise<void> {
    const first = await nextMessage(this.#socket, 10_000);
    const hello = parseHello(first);
    if (hello.nodeId !== this.#options.nodeId) throw new Error("Wrong node");
    const prologue = encodePrologue({
      version: PROTOCOL_VERSION,
      userId: this.#options.userId,
      nodeId: this.#options.nodeId,
      deviceId: hello.deviceId,
    });
    const handshake = new NoiseResponder(this.#options.identity, prologue, {
      maxReceiveMessageBytes: MAX_GATEWAY_REASSEMBLED_MESSAGE_BYTES,
      fragmentAssemblyTimeoutMs: GATEWAY_FRAGMENT_ASSEMBLY_TIMEOUT_MS,
      assemblyBudget: gatewayAssemblyBudget(this.#options),
    });
    const auth = parseAuthPayload(
      handshake.receive(Buffer.from(hello.message, "base64url")),
    );
    const remoteStatic = handshake.remoteStatic();
    const devices = new DeviceRegistry(this.#options.state);
    let onAuthenticated:
      (() => Promise<(() => Promise<void> | void) | void>) | undefined;
    let device: TrustedDevice;
    let matchedDevice: TrustedDevice | undefined;
    let resumeRememberedDeviceInvalid = false;
    if (auth.mode === "pair") {
      device = await devices.consumePairing({
        pairingId: auth.pairingId,
        secret: auth.secret,
        deviceId: hello.deviceId,
        deviceName: auth.deviceName,
        publicKey: remoteStatic,
      });
    } else if (auth.mode === "connect") {
      try {
        device = await devices.verify(hello.deviceId, remoteStatic);
      } catch (error) {
        if (!(error instanceof DeviceTrustError)) throw error;
        // The Noise initiator has already proved possession of the saved
        // device key. Complete that encrypted handshake before rejecting the
        // revoked/missing binding so the browser receives a reliable signal
        // even when an intermediary strips WebSocket close reasons.
        await this.#rejectReauthentication(handshake);
        return;
      }
    } else {
      try {
        matchedDevice = await devices.match(hello.deviceId, remoteStatic);
      } catch (error) {
        if (
          auth.mode !== "resume" ||
          !(error instanceof DeviceTrustError) ||
          error.code !== "KEY_MISMATCH"
        ) {
          throw error;
        }
        // The remembered identity is definitively unusable, but finish the
        // authenticated Noise exchange so the browser gets a structured
        // REAUTH_REQUIRED even when a proxy strips WebSocket close reasons.
        resumeRememberedDeviceInvalid = true;
      }
      device = matchedDevice ?? {
        id: hello.deviceId,
        name: auth.mode === "login" ? auth.deviceName : "Resumed Web session",
        publicKey: remoteStatic,
        createdAt: new Date().toISOString(),
      };
    }
    if (auth.mode === "login" && auth.rememberDevice) {
      onAuthenticated = async () => {
        const remembered = await devices.rememberAuthenticated({
          deviceId: hello.deviceId,
          deviceName: auth.deviceName,
          publicKey: remoteStatic,
        });
        return remembered.rollback;
      };
    }
    try {
      this.#handler = await this.#options.createSession(device, {
        newlyPaired: auth.mode === "pair",
        rememberedDevice:
          auth.mode === "pair" ||
          auth.mode === "connect" ||
          (auth.mode === "login" && auth.rememberDevice) ||
          (auth.mode === "resume" &&
            matchedDevice !== undefined &&
            !matchedDevice.revokedAt),
        ...(auth.mode === "resume" &&
        (resumeRememberedDeviceInvalid ||
          !matchedDevice ||
          matchedDevice.revokedAt)
          ? { resumeRememberedDeviceInvalid: true }
          : {}),
        ...(auth.mode === "resume" ? { resumeToken: auth.resumeToken } : {}),
        ...(onAuthenticated ? { onAuthenticated } : {}),
      });
    } catch (error) {
      if (
        auth.mode !== "resume" ||
        gatewayRejection(error).reason !== "REAUTH_REQUIRED"
      )
        throw error;
      await this.#rejectReauthentication(handshake);
      return;
    }
    const completed = handshake.finish(
      Buffer.from(
        JSON.stringify({
          ok: true,
          version: PROTOCOL_VERSION,
          principal: this.#options.principal ?? "user",
          capabilities: [GATEWAY_CAPABILITIES.sideForkV1],
          ...(this.#options.loginName
            ? { loginName: this.#options.loginName }
            : {}),
        }),
      ),
    );
    this.#session = completed.session;
    this.#trustedDeviceId = device.id;
    this.#unsubscribe = this.#handler.onEvent?.((event) =>
      this.#sendEncrypted(event),
    );
    this.#socket.on("message", (data) => {
      const receivedAt = Date.now();
      this.#receiveQueue = this.#receiveQueue
        .then(() => this.#receiveEncrypted(data, receivedAt))
        .catch(() => this.#socket.close(1008, "protocol error"));
    });
    this.#socket.once("close", () => {
      this.#unsubscribe?.();
      this.#session?.dispose();
      this.#ephemeralIdempotency.clear();
      void this.#handler?.close?.();
    });
    await sendHandshakeReply(this.#socket, completed.message);
  }

  #receiveEncrypted(data: RawData, receivedAt: number): void {
    if (!this.#session || !this.#handler)
      throw new Error("Handshake incomplete");
    const frame = parseCipherFrame(data.toString());
    const plaintext = this.#session.decryptMessage({
      sessionId: frame.sessionId,
      sequence: frame.sequence,
      ciphertext: Buffer.from(frame.ciphertext, "base64url"),
    });
    if (!plaintext) return;
    const request = parseRequest(plaintext);
    if (isReadMethod(request.method)) {
      void this.#executeRequest(request, receivedAt, true);
      return;
    }
    this.#mutationQueue = this.#mutationQueue
      .then(() => this.#executeRequest(request, receivedAt, false))
      .catch(() => this.#socket.close(1011, "request processing failed"));
  }

  async #executeRequest(
    request: RequestEnvelope,
    receivedAt: number,
    readOnly: boolean,
  ): Promise<void> {
    if (!this.#handler) throw new Error("Handshake incomplete");
    const operationStartedAt = Date.now();
    const execute = () => this.#handler!.request(request);
    let outcome: IdempotentResult = readOnly
      ? await captureResult(execute)
      : usesEphemeralGatewayIdempotency(request.method)
        ? await this.#ephemeralIdempotency.execute(request, execute)
        : await new IdempotencyRegistry(this.#options.state).execute(
            this.#requiredDeviceId(),
            request.idempotencyKey,
            execute,
            usesDurableMutationClaim(request.method)
              ? {
                  durableClaim: {
                    method: request.method,
                    payload: request.payload,
                  },
                }
              : undefined,
          );
    if (outcome.ok && usesDurableMutationClaim(request.method)) {
      try {
        await this.#handler.validateDurableResult?.(request, outcome.result);
      } catch {
        outcome = {
          ok: false,
          error: {
            code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
            message:
              "The durable mutation result no longer refers to live app-server state; automatic replay is disabled",
            retryable: false,
          },
        };
      }
    }
    const completedAt = Date.now();
    if (completedAt - receivedAt >= SLOW_REQUEST_THRESHOLD_MS) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "gateway.request_slow",
          method: request.method,
          queueWaitMs: operationStartedAt - receivedAt,
          operationMs: completedAt - operationStartedAt,
          totalMs: completedAt - receivedAt,
        }),
      );
    }
    const response: ResponseEnvelope = outcome.ok
      ? {
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result: outcome.result,
        }
      : {
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: false,
          error: outcome.error,
        };
    this.#sendEncrypted(response);
  }

  #requiredDeviceId(): string {
    if (!this.#trustedDeviceId) throw new Error("Handshake incomplete");
    return this.#trustedDeviceId;
  }

  #sendEncrypted(value: unknown): void {
    if (!this.#session || this.#socket.readyState !== WebSocket.OPEN) return;
    try {
      const frames = this.#session.encryptMessage(
        Buffer.from(JSON.stringify(value)),
      );
      for (const frame of frames) {
        const wire: GatewayCipherFrame = {
          type: "cipher",
          version: PROTOCOL_VERSION,
          sessionId: frame.sessionId,
          sequence: frame.sequence,
          ciphertext: Buffer.from(frame.ciphertext).toString("base64url"),
        };
        this.#socket.send(JSON.stringify(wire));
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "gateway.encrypted_message_rejected",
          detail:
            error instanceof Error
              ? `${error.name}: ${error.message}`.slice(0, 200)
              : "Unknown encryption error",
        }),
      );
      this.#socket.close(1009, "encrypted message too large");
    }
  }

  async #rejectReauthentication(handshake: NoiseResponder): Promise<void> {
    const rejected = handshake.finish(
      Buffer.from(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          ok: false,
          error: { code: "REAUTH_REQUIRED" },
        }),
      ),
    );
    try {
      await sendHandshakeReply(this.#socket, rejected.message);
    } finally {
      rejected.session.dispose();
      this.#socket.close(1008, "REAUTH_REQUIRED");
    }
  }
}

function sendHandshakeReply(
  socket: WebSocket,
  message: Uint8Array,
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(
      JSON.stringify({
        type: "handshake/reply",
        version: PROTOCOL_VERSION,
        message: Buffer.from(message).toString("base64url"),
      }),
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function gatewayAssemblyBudget(
  options: DirectGatewayOptions,
): SecureMessageAssemblyBudget {
  let budget = assemblyBudgets.get(options);
  if (!budget) {
    budget = new SecureMessageAssemblyBudget(MAX_GATEWAY_ASSEMBLY_BYTES);
    assemblyBudgets.set(options, budget);
  }
  return budget;
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DirectGatewayOptions,
): void {
  const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
    .pathname;
  if (pathname !== "/.well-known/codex-everywhere") {
    response.writeHead(404, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Not found\n");
    return;
  }
  const origin = request.headers.origin;
  if (origin && options.allowedOrigin && origin !== options.allowedOrigin) {
    response.writeHead(403, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Origin not allowed\n");
    return;
  }
  const corsHeaders = {
    ...(options.allowedOrigin
      ? { "Access-Control-Allow-Origin": options.allowedOrigin }
      : {}),
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    ...(request.headers["access-control-request-private-network"] === "true"
      ? { "Access-Control-Allow-Private-Network": "true" }
      : {}),
    "Cache-Control": "no-store",
    Vary: "Origin",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders);
    response.end();
    return;
  }
  if (request.method !== "GET") {
    response.writeHead(405, {
      ...corsHeaders,
      Allow: "GET, OPTIONS",
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end("Method not allowed\n");
    return;
  }
  response.writeHead(200, {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(publicHostProfile(options))}\n`);
}

function publicHostProfile(options: DirectGatewayOptions) {
  return {
    type: "host/profile" as const,
    version: PROTOCOL_VERSION,
    nodeId: options.nodeId,
    userId: options.userId,
    hostPublicKey: Buffer.from(options.identity.publicKey).toString(
      "base64url",
    ),
    hostFingerprint: options.hostFingerprint,
    ...(options.directEndpoint
      ? { directEndpoint: options.directEndpoint }
      : {}),
    ...(options.relayEndpoint && options.relayRouteId
      ? {
          relayEndpoint: options.relayEndpoint,
          routeId: options.relayRouteId,
        }
      : {}),
  };
}

function nextMessage(socket: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for gateway handshake"));
    }, timeoutMs);
    const handleMessage = (data: RawData) => {
      cleanup();
      resolve(data.toString());
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Gateway connection closed during handshake"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", handleMessage);
      socket.off("close", handleClose);
    };
    socket.once("message", handleMessage);
    socket.once("close", handleClose);
  });
}

function parseHello(raw: string): GatewayHandshakeHello {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.type !== "handshake/hello" ||
    value.version !== 1
  ) {
    throw new Error("Invalid gateway handshake");
  }
  if (
    typeof value.nodeId !== "string" ||
    typeof value.deviceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.deviceId) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid gateway handshake");
  }
  return value as GatewayHandshakeHello;
}

function parseAuthPayload(bytes: Uint8Array): GatewayAuthenticationPayload {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  return parseGatewayAuthenticationPayload(value);
}

function parseCipherFrame(raw: string): GatewayCipherFrame {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.type !== "cipher" ||
    value.version !== PROTOCOL_VERSION ||
    typeof value.sessionId !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("Invalid cipher frame");
  }
  return value as GatewayCipherFrame;
}

function parseRequest(bytes: Uint8Array): RequestEnvelope {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    !isRecord(value) ||
    value.version !== PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.method !== "string"
  ) {
    throw new Error("Invalid request envelope");
  }
  return value as RequestEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReadMethod(method: string): boolean {
  return new Set([
    "host/ping",
    "node/status",
    "workspace/list",
    "workspace/browse",
    "preferences/read",
    "model/list",
    "thread/list",
    "thread/read",
    "thread/turns/list",
    "thread/goal/get",
    "skills/list",
    "mcpServerStatus/list",
    "account/rateLimits/read",
    "account/usage/read",
  ]).has(method);
}

async function captureResult(
  operation: () => Promise<unknown>,
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }
> {
  try {
    return { ok: true, result: await operation() };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "REQUEST_FAILED",
        message: error instanceof Error ? error.message : "Request failed",
      },
    };
  }
}
