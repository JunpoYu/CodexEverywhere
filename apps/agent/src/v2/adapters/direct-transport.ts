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
import { Scope } from "@codex-everywhere/kernel";
import {
  PROTOCOL_VERSION,
  parseGatewayAuthenticationPayload,
  type GatewayAuthenticationPayload,
  type GatewayCipherFrame,
  type GatewayHandshakeHello,
} from "@codex-everywhere/protocol";
import {
  GATEWAY_API_VERSION,
  GATEWAY_CAPABILITIES_V2,
  gatewayMethodDefinitions,
  isGatewayMethodName,
  type GatewayRequestEnvelopeV2,
} from "@codex-everywhere/protocol/v2";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type {
  GatewayDeviceRegistry,
  GatewayTrustedDevice,
  GatewayV2Session,
} from "../gateway/transport-contract.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_REASSEMBLED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONNECTIONS = 128;
const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const ASSEMBLY_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_MISS_LIMIT = 4;
const SLOW_REQUEST_THRESHOLD_MS = 5_000;
const relayAssemblyBudgets = new WeakMap<
  DirectTransportV2Options,
  SecureMessageAssemblyBudget
>();

export interface DirectTransportV2Options {
  readonly parentScope: Scope;
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly nodeId: string;
  readonly userId: string;
  readonly principal?: "user" | "host-admin";
  readonly loginName?: string;
  readonly identity: StaticKeyPair;
  readonly hostFingerprint: string;
  readonly directEndpoint?: string;
  readonly relayEndpoint?: string;
  readonly relayRouteId?: string;
  readonly allowedOrigin?: string;
  readonly heartbeatMs?: number;
  readonly heartbeatMissLimit?: number;
  readonly deviceRegistry: GatewayDeviceRegistry;
  readonly createSession: (
    device: GatewayTrustedDevice,
    context: {
      readonly authenticationMode: GatewayAuthenticationPayload["mode"];
      readonly newlyPaired: boolean;
      readonly rememberedDevice: boolean;
      readonly resumeRememberedDeviceInvalid?: boolean;
      readonly resumeToken?: string;
    },
  ) => GatewayV2Session | Promise<GatewayV2Session>;
}

/** Noise/WebSocket transport adapter dedicated to Gateway API v2. */
export class DirectTransportV2 extends EventEmitter<{ listening: [number] }> {
  readonly #scope: Scope;
  readonly #server: WebSocketServer;
  readonly #httpServer: HttpServer;
  readonly #options: DirectTransportV2Options;
  readonly #connections = new Set<WebSocket>();
  readonly #assemblyBudget = new SecureMessageAssemblyBudget(
    MAX_ASSEMBLY_BYTES,
  );

  private constructor(
    scope: Scope,
    server: WebSocketServer,
    httpServer: HttpServer,
    options: DirectTransportV2Options,
  ) {
    super();
    this.#scope = scope;
    this.#server = server;
    this.#httpServer = httpServer;
    this.#options = options;
  }

  static async start(
    options: DirectTransportV2Options,
  ): Promise<DirectTransportV2> {
    validatePositiveInteger(options.heartbeatMs ?? HEARTBEAT_MS, "heartbeat");
    validatePositiveInteger(
      options.heartbeatMissLimit ?? HEARTBEAT_MISS_LIMIT,
      "heartbeat miss limit",
    );
    const scope = options.parentScope.fork("direct-transport-v2");
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
    const transport = new DirectTransportV2(scope, server, httpServer, options);
    const accept = (socket: WebSocket) => transport.#accept(socket);
    server.on("connection", accept);
    scope.defer(() => {
      server.off("connection", accept);
    });
    scope.defer(() => closeHttpServer(httpServer));
    scope.defer(() => closeWebSocketServer(server));
    try {
      await listen(httpServer, options.port, options.host);
      transport.emit("listening", transport.port);
      return transport;
    } catch (error) {
      await scope.close("direct-transport-start-failed").catch(() => undefined);
      throw error;
    }
  }

  get port(): number {
    const address = this.#httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Gateway is not listening");
    }
    return address.port;
  }

  close(): Promise<void> {
    return this.#scope.close("direct-transport-stopped");
  }

  #accept(socket: WebSocket): void {
    if (this.#connections.size >= MAX_CONNECTIONS) {
      socket.close(1013, "gateway busy");
      return;
    }
    this.#connections.add(socket);
    const remove = () => this.#connections.delete(socket);
    socket.once("close", remove);
    acceptGatewayV2Socket(
      socket,
      this.#options,
      this.#scope,
      this.#assemblyBudget,
    );
  }
}

/** Used by the Relay tunnel adapter after its version-1 wire handshake. */
export function acceptGatewayV2Socket(
  socket: WebSocket,
  options: DirectTransportV2Options,
  parentScope: Scope,
  assemblyBudget = assemblyBudgetFor(options),
): void {
  const scope = parentScope.fork(`gateway-connection-${crypto.randomUUID()}`);
  scope.defer(() => {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      socket.terminate();
    }
  });
  const closeScope = () => void scope.close("gateway-socket-closed");
  socket.once("close", closeScope);
  scope.defer(() => {
    socket.off("close", closeScope);
  });
  startHeartbeat(scope, socket, options);
  const connection = new GatewayV2Connection(
    socket,
    options,
    scope,
    assemblyBudget,
  );
  connection.run().catch((error: unknown) => {
    const rejection = gatewayRejection(error);
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        event: "gateway.handshake_rejected",
        reason: rejection.reason,
        detail: rejection.detail,
      })}\n`,
    );
    socket.close(1008, rejection.reason);
  });
}

class GatewayV2Connection {
  readonly #socket: WebSocket;
  readonly #options: DirectTransportV2Options;
  readonly #scope: Scope;
  readonly #assemblyBudget: SecureMessageAssemblyBudget;
  #session: SecureSession | undefined;
  #handler: GatewayV2Session | undefined;
  #receiveQueue: Promise<void> = Promise.resolve();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    socket: WebSocket,
    options: DirectTransportV2Options,
    scope: Scope,
    assemblyBudget: SecureMessageAssemblyBudget,
  ) {
    this.#socket = socket;
    this.#options = options;
    this.#scope = scope;
    this.#assemblyBudget = assemblyBudget;
  }

  async run(): Promise<void> {
    const first = await nextMessage(this.#scope, this.#socket, 10_000);
    const hello = parseHello(first);
    if (hello.nodeId !== this.#options.nodeId) throw new Error("Wrong node");
    const handshake = new NoiseResponder(
      this.#options.identity,
      encodePrologue({
        version: PROTOCOL_VERSION,
        userId: this.#options.userId,
        nodeId: this.#options.nodeId,
        deviceId: hello.deviceId,
      }),
      {
        maxReceiveMessageBytes: MAX_REASSEMBLED_MESSAGE_BYTES,
        fragmentAssemblyTimeoutMs: ASSEMBLY_TIMEOUT_MS,
        assemblyBudget: this.#assemblyBudget,
      },
    );
    const authentication = parseAuthentication(
      handshake.receive(Buffer.from(hello.message, "base64url")),
    );
    const remoteStatic = handshake.remoteStatic();
    let matchedDevice: GatewayTrustedDevice | undefined;
    let resumeRememberedDeviceInvalid = false;
    let device: GatewayTrustedDevice;
    if (authentication.mode === "pair") {
      device = await this.#options.deviceRegistry.consumePairing({
        pairingId: authentication.pairingId,
        secret: authentication.secret,
        deviceId: hello.deviceId,
        deviceName: authentication.deviceName,
        publicKey: remoteStatic,
      });
    } else if (authentication.mode === "connect") {
      try {
        device = await this.#options.deviceRegistry.verify(
          hello.deviceId,
          remoteStatic,
        );
      } catch (error) {
        if (deviceTrustErrorCode(error) === undefined) throw error;
        await this.#rejectReauthentication(handshake);
        return;
      }
    } else {
      try {
        matchedDevice = await this.#options.deviceRegistry.match(
          hello.deviceId,
          remoteStatic,
        );
      } catch (error) {
        if (
          authentication.mode !== "resume" ||
          deviceTrustErrorCode(error) !== "KEY_MISMATCH"
        ) {
          throw error;
        }
        resumeRememberedDeviceInvalid = true;
      }
      device = matchedDevice ?? {
        id: hello.deviceId,
        name:
          authentication.mode === "login"
            ? authentication.deviceName
            : "Resumed Web session",
        publicKey: remoteStatic,
        createdAt: new Date().toISOString(),
      };
    }

    try {
      this.#handler = await this.#options.createSession(device, {
        authenticationMode: authentication.mode,
        newlyPaired: authentication.mode === "pair",
        rememberedDevice:
          authentication.mode === "pair" ||
          authentication.mode === "connect" ||
          (authentication.mode === "resume" &&
            matchedDevice !== undefined &&
            !matchedDevice.revokedAt),
        ...(authentication.mode === "resume" &&
        (resumeRememberedDeviceInvalid ||
          matchedDevice === undefined ||
          matchedDevice.revokedAt)
          ? { resumeRememberedDeviceInvalid: true }
          : {}),
        ...(authentication.mode === "resume"
          ? { resumeToken: authentication.resumeToken }
          : {}),
      });
    } catch (error) {
      if (
        authentication.mode !== "resume" ||
        gatewayRejection(error).reason !== "REAUTH_REQUIRED"
      ) {
        throw error;
      }
      await this.#rejectReauthentication(handshake);
      return;
    }

    const completed = handshake.finish(
      Buffer.from(
        JSON.stringify({
          ok: true,
          version: PROTOCOL_VERSION,
          gatewayApiVersion: GATEWAY_API_VERSION,
          principal: this.#options.principal ?? "user",
          capabilities: Object.values(GATEWAY_CAPABILITIES_V2),
          ...(this.#options.loginName === undefined
            ? {}
            : { loginName: this.#options.loginName }),
        }),
      ),
    );
    this.#session = completed.session;
    this.#scope.defer(() => this.#handler?.close?.());
    this.#scope.defer(() => this.#session?.dispose());
    const receive = (data: RawData) => {
      const receivedAt = Date.now();
      this.#receiveQueue = this.#receiveQueue
        .then(() => this.#receiveEncrypted(data, receivedAt))
        .catch(() => this.#socket.close(1008, "protocol error"));
    };
    this.#socket.on("message", receive);
    this.#scope.defer(() => {
      this.#socket.off("message", receive);
    });
    await sendHandshakeReply(this.#socket, completed.message);
    const unsubscribe = this.#handler.onEvent?.((event) =>
      this.#sendEncrypted(event),
    );
    if (unsubscribe !== undefined) this.#scope.defer(unsubscribe);
  }

  #receiveEncrypted(data: RawData, receivedAt: number): void {
    if (this.#session === undefined || this.#handler === undefined) {
      throw new Error("Handshake incomplete");
    }
    const frame = parseCipherFrame(data.toString());
    const plaintext = this.#session.decryptMessage({
      sessionId: frame.sessionId,
      sequence: frame.sequence,
      ciphertext: Buffer.from(frame.ciphertext, "base64url"),
    });
    if (plaintext === undefined) return;
    const request = parseJsonMessage(plaintext);
    if (isQuery(request)) {
      void this.#execute(request, receivedAt).catch(() =>
        this.#socket.close(1011, "request processing failed"),
      );
      return;
    }
    this.#mutationQueue = this.#mutationQueue
      .then(() => this.#execute(request, receivedAt))
      .catch(() => this.#socket.close(1011, "request processing failed"));
  }

  async #execute(request: unknown, receivedAt: number): Promise<void> {
    if (this.#handler === undefined) throw new Error("Handshake incomplete");
    const operationStartedAt = Date.now();
    const outcome = await this.#handler.route(request);
    const completedAt = Date.now();
    if (completedAt - receivedAt >= SLOW_REQUEST_THRESHOLD_MS) {
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          event: "gateway.request_slow",
          method: safeMethod(request),
          queueWaitMs: operationStartedAt - receivedAt,
          operationMs: completedAt - operationStartedAt,
          totalMs: completedAt - receivedAt,
        })}\n`,
      );
    }
    this.#sendEncrypted(outcome.response);
    if (outcome.closeConnection) {
      this.#socket.close(1008, "gateway request rejected");
    }
  }

  #sendEncrypted(value: unknown): void {
    if (
      this.#session === undefined ||
      this.#socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
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
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          event: "gateway.encrypted_message_rejected",
          detail: safeError(error),
        })}\n`,
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

function startHeartbeat(
  scope: Scope,
  socket: WebSocket,
  options: DirectTransportV2Options,
): void {
  let unansweredPings = 0;
  const pong = () => {
    unansweredPings = 0;
  };
  socket.on("pong", pong);
  scope.defer(() => {
    socket.off("pong", pong);
  });
  const timer = scope.setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (
      unansweredPings >= (options.heartbeatMissLimit ?? HEARTBEAT_MISS_LIMIT)
    ) {
      socket.terminate();
      return;
    }
    unansweredPings += 1;
    socket.ping();
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref?.();
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: DirectTransportV2Options,
): void {
  const pathname = new URL(request.url ?? "/", "http://gateway.invalid")
    .pathname;
  if (pathname !== "/.well-known/codex-everywhere") {
    writeHttp(response, 404, "Not found\n");
    return;
  }
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    options.allowedOrigin !== undefined &&
    origin !== options.allowedOrigin
  ) {
    writeHttp(response, 403, "Origin not allowed\n");
    return;
  }
  const corsHeaders = {
    ...(options.allowedOrigin === undefined
      ? {}
      : { "Access-Control-Allow-Origin": options.allowedOrigin }),
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

function publicHostProfile(options: DirectTransportV2Options) {
  return {
    type: "host/profile" as const,
    version: PROTOCOL_VERSION,
    nodeId: options.nodeId,
    userId: options.userId,
    hostPublicKey: Buffer.from(options.identity.publicKey).toString(
      "base64url",
    ),
    hostFingerprint: options.hostFingerprint,
    ...(options.directEndpoint === undefined
      ? {}
      : { directEndpoint: options.directEndpoint }),
    ...(options.relayEndpoint !== undefined &&
    options.relayRouteId !== undefined
      ? {
          relayEndpoint: options.relayEndpoint,
          routeId: options.relayRouteId,
        }
      : {}),
  };
}

function nextMessage(
  scope: Scope,
  socket: WebSocket,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("message", message);
      socket.off("close", closed);
      scope.signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve(value ?? "");
    };
    const message = (data: RawData) => finish(undefined, data.toString());
    const closed = () =>
      finish(new Error("Gateway connection closed during handshake"));
    const aborted = () => finish(new Error("Gateway connection aborted"));
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for gateway handshake")),
      timeoutMs,
    );
    socket.once("message", message);
    socket.once("close", closed);
    scope.signal.addEventListener("abort", aborted, { once: true });
  });
}

function parseHello(raw: string): GatewayHandshakeHello {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.type !== "handshake/hello" ||
    value.version !== PROTOCOL_VERSION ||
    typeof value.nodeId !== "string" ||
    typeof value.deviceId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(value.deviceId) ||
    typeof value.message !== "string"
  ) {
    throw new Error("Invalid gateway handshake");
  }
  return value as GatewayHandshakeHello;
}

function parseAuthentication(bytes: Uint8Array): GatewayAuthenticationPayload {
  return parseGatewayAuthenticationPayload(
    JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
  );
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

function parseJsonMessage(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function isQuery(value: unknown): value is GatewayRequestEnvelopeV2 {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    isGatewayMethodName(value.method) &&
    gatewayMethodDefinitions[value.method].kind === "query"
  );
}

function safeMethod(value: unknown): string {
  return isRecord(value) &&
    typeof value.method === "string" &&
    isGatewayMethodName(value.method)
    ? value.method
    : "invalid";
}

function deviceTrustErrorCode(
  error: unknown,
): "NOT_TRUSTED" | "REVOKED" | "KEY_MISMATCH" | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return code === "NOT_TRUSTED" || code === "REVOKED" || code === "KEY_MISMATCH"
    ? code
    : undefined;
}

function gatewayRejection(error: unknown): {
  readonly reason: string;
  readonly detail: string;
} {
  const detail = safeError(error);
  if (detail.includes("Pairing grant has expired")) {
    return { reason: "pairing expired", detail };
  }
  if (detail.includes("Pairing grant is invalid or already used")) {
    return { reason: "pairing invalid", detail };
  }
  if (detail.includes("Wrong node")) return { reason: "wrong node", detail };
  if (detail.includes("REAUTH_REQUIRED")) {
    return { reason: "REAUTH_REQUIRED", detail };
  }
  return { reason: "protocol error", detail };
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`.slice(0, 200)
    : "Unknown gateway error";
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

function writeHttp(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Gateway ${label} must be a positive integer`);
  }
}

function assemblyBudgetFor(
  options: DirectTransportV2Options,
): SecureMessageAssemblyBudget {
  let budget = relayAssemblyBudgets.get(options);
  if (budget === undefined) {
    budget = new SecureMessageAssemblyBudget(MAX_ASSEMBLY_BYTES);
    relayAssemblyBudgets.set(options, budget);
  }
  return budget;
}

function listen(server: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => {
      server.off("listening", resolve);
      reject(error);
    };
    server.once("listening", resolve);
    server.once("error", failed);
    server.listen(port, host);
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();
  return new Promise((resolve) => server.close(() => resolve()));
}

function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
