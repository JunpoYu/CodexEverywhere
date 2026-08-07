import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import {
  NoiseResponder,
  encodePrologue,
  type SecureSession,
  type StaticKeyPair,
} from "@codex-everywhere/crypto";
import {
  PROTOCOL_VERSION,
  type GatewayCipherFrame,
  type EventEnvelope,
  type GatewayHandshakeHello,
  type LoginHandshakePayload,
  type PairingHandshakePayload,
  type RequestEnvelope,
  type ResponseEnvelope,
  type TrustedHandshakePayload,
} from "@codex-everywhere/protocol";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import { DeviceRegistry, type TrustedDevice } from "../host/devices.js";
import { IdempotencyRegistry } from "../host/idempotency.js";
import type { HostStateStore } from "../host/state-store.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_GATEWAY_CONNECTIONS = 128;
const SLOW_REQUEST_THRESHOLD_MS = 5_000;

export type GatewaySession = {
  request(request: RequestEnvelope): Promise<unknown>;
  onEvent?(listener: (event: EventEnvelope) => void): () => void;
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
  state: HostStateStore;
  createSession(
    device: TrustedDevice,
    context: {
      newlyPaired: boolean;
      onAuthenticated?: () => Promise<void>;
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
    socket.once("close", () => this.#connections.delete(socket));
    acceptGatewaySocket(socket, this.#options);
  }
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
    const handshake = new NoiseResponder(this.#options.identity, prologue);
    const auth = parseAuthPayload(
      handshake.receive(Buffer.from(hello.message, "base64url")),
    );
    const completed = handshake.finish(
      Buffer.from(
        JSON.stringify({
          ok: true,
          version: PROTOCOL_VERSION,
          principal: this.#options.principal ?? "user",
          ...(this.#options.loginName
            ? { loginName: this.#options.loginName }
            : {}),
        }),
      ),
    );
    const devices = new DeviceRegistry(this.#options.state);
    let onAuthenticated: (() => Promise<void>) | undefined;
    const device =
      auth.mode === "pair"
        ? await devices.consumePairing({
            pairingId: auth.pairingId,
            secret: auth.secret,
            deviceId: hello.deviceId,
            deviceName: auth.deviceName,
            publicKey: completed.remoteStatic,
          })
        : auth.mode === "connect"
          ? await devices.verify(hello.deviceId, completed.remoteStatic)
          : {
              id: hello.deviceId,
              name: auth.deviceName,
              publicKey: completed.remoteStatic,
              createdAt: new Date().toISOString(),
            };
    if (auth.mode === "login" && auth.rememberDevice) {
      onAuthenticated = async () => {
        await devices.enrollAuthenticated({
          deviceId: hello.deviceId,
          deviceName: auth.deviceName,
          publicKey: completed.remoteStatic,
        });
      };
    }
    this.#session = completed.session;
    this.#trustedDeviceId = device.id;
    this.#handler = await this.#options.createSession(device, {
      newlyPaired: auth.mode === "pair",
      ...(onAuthenticated ? { onAuthenticated } : {}),
    });
    this.#unsubscribe = this.#handler.onEvent?.((event) =>
      this.#sendEncrypted(event),
    );
    this.#socket.send(
      JSON.stringify({
        type: "handshake/reply",
        version: PROTOCOL_VERSION,
        message: Buffer.from(completed.message).toString("base64url"),
      }),
    );

    this.#socket.on("message", (data) => {
      const receivedAt = Date.now();
      this.#receiveQueue = this.#receiveQueue
        .then(() => this.#receiveEncrypted(data, receivedAt))
        .catch(() => this.#socket.close(1008, "protocol error"));
    });
    this.#socket.once("close", () => {
      this.#unsubscribe?.();
      void this.#handler?.close?.();
    });
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
    const outcome = readOnly
      ? await captureResult(execute)
      : await new IdempotencyRegistry(this.#options.state).execute(
          this.#requiredDeviceId(),
          request.idempotencyKey,
          execute,
        );
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

function parseAuthPayload(
  bytes: Uint8Array,
): PairingHandshakePayload | TrustedHandshakePayload | LoginHandshakePayload {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!isRecord(value)) throw new Error("Invalid authentication payload");
  if (value.mode === "connect") return { mode: "connect" };
  if (
    value.mode === "login" &&
    typeof value.deviceName === "string" &&
    value.deviceName.length >= 1 &&
    value.deviceName.length <= 128 &&
    typeof value.rememberDevice === "boolean"
  ) {
    return value as LoginHandshakePayload;
  }
  if (
    value.mode === "pair" &&
    typeof value.pairingId === "string" &&
    typeof value.secret === "string" &&
    typeof value.deviceName === "string"
  ) {
    return value as PairingHandshakePayload;
  }
  throw new Error("Invalid authentication payload");
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
    "node/status",
    "workspace/list",
    "workspace/browse",
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
