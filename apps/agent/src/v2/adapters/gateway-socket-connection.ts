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
  parseGatewayCipherFrame,
  parseGatewayHandshakeHello,
  type GatewayAuthenticationPayload,
  type GatewayCipherFrame,
} from "@codex-everywhere/protocol";
import {
  GATEWAY_API_VERSION,
  GATEWAY_CAPABILITIES_V2,
  gatewayMethodDefinitions,
  isGatewayMethodName,
  type GatewayRequestEnvelopeV2,
} from "@codex-everywhere/protocol/v2";
import WebSocket, { type RawData } from "ws";

import type {
  GatewayDeviceRegistry,
  GatewayV2SessionFactory,
  GatewayV2Session,
} from "../gateway/transport-contract.js";
import { authenticateGatewayPeer } from "./gateway-peer-authentication.js";

const MAX_REASSEMBLED_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const ASSEMBLY_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const HEARTBEAT_MISS_LIMIT = 4;
const SLOW_REQUEST_THRESHOLD_MS = 5_000;
const assemblyBudgets = new WeakMap<
  GatewaySocketConnectionOptions,
  SecureMessageAssemblyBudget
>();

export type GatewayHandshakeStage =
  | "awaiting-hello"
  | "parsing-hello"
  | "noise-handshake"
  | "peer-authentication"
  | "session-creation"
  | "handshake-reply"
  | "connected";

export interface GatewayFatalRuntimeFailure {
  readonly error: WebAssembly.RuntimeError;
  readonly stage: GatewayHandshakeStage;
}

/** Minimum capabilities required to authenticate and serve one Noise socket. */
export interface GatewaySocketConnectionOptions {
  readonly nodeId: string;
  readonly userId: string;
  readonly principal?: "user" | "host-admin";
  readonly loginName?: string;
  readonly identity: StaticKeyPair;
  readonly heartbeatMs?: number;
  readonly heartbeatMissLimit?: number;
  readonly deviceRegistry: GatewayDeviceRegistry;
  readonly createSession: GatewayV2SessionFactory;
  readonly onFatalRuntimeFailure?: (
    failure: GatewayFatalRuntimeFailure,
  ) => void;
}

/**
 * Copies only socket capabilities. Callers should use this at composition
 * boundaries instead of passing transport, discovery, or Relay configuration.
 */
export function gatewaySocketConnectionOptions(
  options: GatewaySocketConnectionOptions,
): GatewaySocketConnectionOptions {
  return {
    nodeId: options.nodeId,
    userId: options.userId,
    ...(options.principal === undefined
      ? {}
      : { principal: options.principal }),
    ...(options.loginName === undefined
      ? {}
      : { loginName: options.loginName }),
    identity: options.identity,
    ...(options.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.heartbeatMs }),
    ...(options.heartbeatMissLimit === undefined
      ? {}
      : { heartbeatMissLimit: options.heartbeatMissLimit }),
    deviceRegistry: options.deviceRegistry,
    createSession: options.createSession,
    ...(options.onFatalRuntimeFailure === undefined
      ? {}
      : { onFatalRuntimeFailure: options.onFatalRuntimeFailure }),
  };
}

export function validateGatewaySocketConnectionOptions(
  options: GatewaySocketConnectionOptions,
): void {
  validatePositiveInteger(options.heartbeatMs ?? HEARTBEAT_MS, "heartbeat");
  validatePositiveInteger(
    options.heartbeatMissLimit ?? HEARTBEAT_MISS_LIMIT,
    "heartbeat miss limit",
  );
}

/** Used by Direct and Relay after their respective outer wire handshakes. */
export function acceptGatewayV2Socket(
  socket: WebSocket,
  options: GatewaySocketConnectionOptions,
  parentScope: Scope,
  assemblyBudget = assemblyBudgetFor(options),
): void {
  validateGatewaySocketConnectionOptions(options);
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
        stage: connection.stage,
        reason: rejection.reason,
        detail: rejection.detail,
      })}\n`,
    );
    socket.close(1008, rejection.reason);
    connection.reportFatalRuntimeFailure(error);
  });
}

class GatewayV2Connection {
  readonly #socket: WebSocket;
  readonly #options: GatewaySocketConnectionOptions;
  readonly #scope: Scope;
  readonly #assemblyBudget: SecureMessageAssemblyBudget;
  #session: SecureSession | undefined;
  #handler: GatewayV2Session | undefined;
  #stage: GatewayHandshakeStage = "awaiting-hello";
  #receiveQueue: Promise<void> = Promise.resolve();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    socket: WebSocket,
    options: GatewaySocketConnectionOptions,
    scope: Scope,
    assemblyBudget: SecureMessageAssemblyBudget,
  ) {
    this.#socket = socket;
    this.#options = options;
    this.#scope = scope;
    this.#assemblyBudget = assemblyBudget;
  }

  get stage(): GatewayHandshakeStage {
    return this.#stage;
  }

  reportFatalRuntimeFailure(error: unknown): void {
    if (
      !(error instanceof WebAssembly.RuntimeError) ||
      this.#options.onFatalRuntimeFailure === undefined
    ) {
      return;
    }
    try {
      this.#options.onFatalRuntimeFailure({ error, stage: this.#stage });
    } catch {
      // A failure reporter must not escape the rejected connection or request.
    }
  }

  async run(): Promise<void> {
    const first = await nextMessage(this.#scope, this.#socket, 10_000);
    this.#stage = "parsing-hello";
    const hello = parseGatewayHandshakeHello(first);
    if (hello.nodeId !== this.#options.nodeId) throw new Error("Wrong node");
    this.#stage = "noise-handshake";
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
    this.#stage = "peer-authentication";
    const peer = await authenticateGatewayPeer(
      authentication,
      { deviceId: hello.deviceId, publicKey: remoteStatic },
      this.#options.deviceRegistry,
    );
    if (!peer.accepted) {
      await this.#rejectReauthentication(handshake);
      return;
    }

    this.#stage = "session-creation";
    try {
      this.#handler = await this.#options.createSession(
        peer.device,
        peer.context,
      );
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

    this.#stage = "handshake-reply";
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
    this.#stage = "connected";
    this.#scope.defer(() => this.#handler?.close?.());
    this.#scope.defer(() => this.#session?.dispose());
    const receive = (data: RawData) => {
      const receivedAt = Date.now();
      this.#receiveQueue = this.#receiveQueue
        .then(() => this.#receiveEncrypted(data, receivedAt))
        .catch((error: unknown) => {
          this.reportFatalRuntimeFailure(error);
          this.#socket.close(1008, "protocol error");
        });
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
    const frame = parseGatewayCipherFrame(data.toString());
    const plaintext = this.#session.decryptMessage({
      sessionId: frame.sessionId,
      sequence: frame.sequence,
      ciphertext: Buffer.from(frame.ciphertext, "base64url"),
    });
    if (plaintext === undefined) return;
    const request = parseJsonMessage(plaintext);
    if (isQuery(request)) {
      void this.#execute(request, receivedAt).catch((error: unknown) => {
        this.reportFatalRuntimeFailure(error);
        this.#socket.close(1011, "request processing failed");
      });
      return;
    }
    this.#mutationQueue = this.#mutationQueue
      .then(() => this.#execute(request, receivedAt))
      .catch((error: unknown) => {
        this.reportFatalRuntimeFailure(error);
        this.#socket.close(1011, "request processing failed");
      });
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
      this.reportFatalRuntimeFailure(error);
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
  options: GatewaySocketConnectionOptions,
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

function parseAuthentication(bytes: Uint8Array): GatewayAuthenticationPayload {
  return parseGatewayAuthenticationPayload(
    JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
  );
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

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Gateway ${label} must be a positive integer`);
  }
}

function assemblyBudgetFor(
  options: GatewaySocketConnectionOptions,
): SecureMessageAssemblyBudget {
  let budget = assemblyBudgets.get(options);
  if (budget === undefined) {
    budget = new SecureMessageAssemblyBudget(MAX_ASSEMBLY_BYTES);
    assemblyBudgets.set(options, budget);
  }
  return budget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
