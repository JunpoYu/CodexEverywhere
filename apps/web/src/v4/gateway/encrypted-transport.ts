import {
  NoiseInitiator,
  base64UrlToBytes,
  bytesToBase64Url,
  encodePrologue,
  type SecureSession,
} from "@codex-everywhere/crypto";
import {
  PROTOCOL_VERSION,
  RELAY_MESSAGE_TYPES,
  RELAY_PROTOCOL_VERSION,
  parseGatewayCipherFrame,
  parseGatewayHandshakeReply,
  parseGatewayHandshakeResult,
  parseRelayWireMessage,
} from "@codex-everywhere/protocol";
import {
  GATEWAY_API_VERSION,
  parseGatewayEventEnvelopeV2,
  type GatewayEventEnvelopeV2,
} from "@codex-everywhere/protocol/v2";

import type { SavedHost } from "../../storage.js";
import type { EventfulGatewayV2Transport } from "./gateway-port.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REQUEST_TIMEOUT_MS = 30_000;

export type GatewayAuthentication =
  | {
      readonly mode: "pair";
      readonly pairingId: string;
      readonly secret: string;
      readonly deviceName: string;
    }
  | { readonly mode: "connect" }
  | {
      readonly mode: "login";
      readonly deviceName: string;
      readonly rememberDevice: boolean;
    }
  | { readonly mode: "resume"; readonly resumeToken: string };

export class GatewayUpgradeRequiredError extends Error {
  constructor(readonly direction: "client" | "agent") {
    super(
      direction === "client"
        ? "Web 客户端需要更新后才能连接"
        : "CodexEverywhere Agent 需要升级到 v0.4",
    );
    this.name = "GatewayUpgradeRequiredError";
  }
}

export class GatewayReauthenticationRequiredError extends Error {
  constructor() {
    super("宿主机要求重新验证身份");
    this.name = "GatewayReauthenticationRequiredError";
  }
}

export class EncryptedGatewayV2Transport implements EventfulGatewayV2Transport {
  readonly #socket: WebSocket;
  readonly #session: SecureSession;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
      readonly detachAbort: () => void;
    }
  >();
  readonly #events = new Set<(event: GatewayEventEnvelopeV2) => void>();
  readonly #connectionListeners = new Set<(error: Error) => void>();
  #closed = false;

  private constructor(socket: WebSocket, session: SecureSession) {
    this.#socket = socket;
    this.#session = session;
    socket.addEventListener("message", (event) => this.#message(event));
    socket.addEventListener("close", () =>
      this.#invalidate(new Error("宿主机连接已关闭"), false),
    );
    socket.addEventListener("error", () =>
      this.#invalidate(new Error("宿主机连接失败")),
    );
  }

  static async open(
    host: SavedHost,
    authentication: GatewayAuthentication,
  ): Promise<EncryptedGatewayV2Transport> {
    let lastError: unknown;
    for (const target of connectionTargets(host)) {
      try {
        return await EncryptedGatewayV2Transport.#openTarget(
          host,
          authentication,
          target,
        );
      } catch (error) {
        if (
          error instanceof GatewayUpgradeRequiredError ||
          error instanceof GatewayReauthenticationRequiredError
        ) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("没有可用的 CodexEverywhere 连接路径");
  }

  static async #openTarget(
    host: SavedHost,
    authentication: GatewayAuthentication,
    target: {
      readonly transport: "direct" | "relay";
      readonly endpoint: string;
    },
  ): Promise<EncryptedGatewayV2Transport> {
    const socket = new WebSocket(target.endpoint);
    let pendingSession: SecureSession | undefined;
    try {
      await socketOpened(socket);
      if (target.transport === "relay") {
        if (host.routeId === undefined)
          throw new Error("Relay route is missing");
        const reply = nextTextMessage(socket, "Relay route timed out");
        socket.send(
          JSON.stringify({
            type: RELAY_MESSAGE_TYPES.connect,
            version: RELAY_PROTOCOL_VERSION,
            routeId: host.routeId,
          }),
        );
        parseRelayWireMessage(await reply, RELAY_MESSAGE_TYPES.ready);
      }
      const handshake = new NoiseInitiator(
        {
          publicKey: base64UrlToBytes(host.devicePublicKey),
          secretKey: base64UrlToBytes(host.deviceSecretKey),
        },
        base64UrlToBytes(host.hostPublicKey),
        encodePrologue({
          version: PROTOCOL_VERSION,
          userId: host.userId,
          nodeId: host.nodeId,
          deviceId: host.deviceId,
        }),
      );
      const reply = nextTextMessage(socket, "Encrypted handshake timed out");
      socket.send(
        JSON.stringify({
          type: "handshake/hello",
          version: PROTOCOL_VERSION,
          nodeId: host.nodeId,
          deviceId: host.deviceId,
          message: bytesToBase64Url(
            handshake.start(encoder.encode(JSON.stringify(authentication))),
          ),
        }),
      );
      const wireReply = parseGatewayHandshakeReply(await reply);
      const completed = handshake.finish(base64UrlToBytes(wireReply.message));
      pendingSession = completed.session;
      const accepted = parseGatewayHandshakeResult(
        decoder.decode(completed.payload),
      );
      if (!accepted.ok) throw new GatewayReauthenticationRequiredError();
      if (accepted.gatewayApiVersion !== GATEWAY_API_VERSION) {
        throw new GatewayUpgradeRequiredError("agent");
      }
      const expectedPrincipal = host.kind === "admin" ? "host-admin" : "user";
      if (accepted.principal !== expectedPrincipal) {
        throw new Error("宿主机返回了错误的身份域");
      }
      const transport = new EncryptedGatewayV2Transport(
        socket,
        completed.session,
      );
      pendingSession = undefined;
      return transport;
    } catch (error) {
      pendingSession?.dispose();
      socket.close();
      throw error;
    }
  }

  exchange(
    request: unknown,
    options: { signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("宿主机连接不可用"));
    }
    const requestId = readRequestId(request);
    const frames = this.#session.encryptMessage(
      encoder.encode(JSON.stringify(request)),
    );
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.detachAbort();
        reject(
          options.signal?.reason ?? new DOMException("Aborted", "AbortError"),
        );
      };
      const detachAbort = () =>
        options.signal?.removeEventListener("abort", abort);
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        detachAbort();
        reject(new Error("宿主机请求超时，结果需要对账"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, {
        resolve,
        reject,
        timeout,
        detachAbort,
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      try {
        for (const frame of frames) {
          this.#socket.send(
            JSON.stringify({
              type: "cipher",
              version: PROTOCOL_VERSION,
              sessionId: frame.sessionId,
              sequence: frame.sequence,
              ciphertext: bytesToBase64Url(frame.ciphertext),
            }),
          );
        }
      } catch (error) {
        this.#pending.delete(requestId);
        clearTimeout(timeout);
        detachAbort();
        reject(error instanceof Error ? error : new Error("发送请求失败"));
      }
    });
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  close(): void {
    this.#invalidate(new Error("连接已关闭"));
  }

  #message(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.#invalidate(new Error("宿主机发送了无效二进制帧"));
      return;
    }
    try {
      const wire = parseGatewayCipherFrame(event.data);
      const plaintext = this.#session.decryptMessage({
        sessionId: wire.sessionId,
        sequence: wire.sequence,
        ciphertext: base64UrlToBytes(wire.ciphertext),
      });
      if (plaintext === undefined) return;
      const value = JSON.parse(decoder.decode(plaintext)) as unknown;
      const requestId = optionalRequestId(value);
      if (requestId !== undefined) {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timeout);
        pending.detachAbort();
        pending.resolve(value);
        return;
      }
      const gatewayEvent = parseGatewayEventEnvelopeV2(value);
      for (const listener of [...this.#events]) listener(gatewayEvent);
    } catch (error) {
      this.#invalidate(new Error("宿主机发送了无效加密消息", { cause: error }));
    }
  }

  #invalidate(error: Error, closeSocket = true): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#session.dispose();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.detachAbort();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of [...this.#connectionListeners]) listener(error);
    if (closeSocket && this.#socket.readyState < WebSocket.CLOSING) {
      this.#socket.close();
    }
  }
}

function connectionTargets(host: SavedHost): Array<{
  readonly transport: "direct" | "relay";
  readonly endpoint: string;
}> {
  const candidates = [
    host.directEndpoint === undefined
      ? undefined
      : { transport: "direct" as const, endpoint: host.directEndpoint },
    host.transport === "direct"
      ? { transport: "direct" as const, endpoint: host.endpoint }
      : undefined,
    host.relayEndpoint === undefined
      ? undefined
      : { transport: "relay" as const, endpoint: host.relayEndpoint },
    host.transport === "relay"
      ? { transport: "relay" as const, endpoint: host.endpoint }
      : undefined,
  ].filter((value) => value !== undefined);
  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex(
        (other) =>
          other.transport === candidate.transport &&
          other.endpoint === candidate.endpoint,
      ) === index,
  );
}

function readRequestId(value: unknown): string {
  const requestId = optionalRequestId(value);
  if (requestId === undefined) throw new Error("Gateway request has no ID");
  return requestId;
}

function optionalRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : undefined;
}

function socketOpened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("连接宿主机超时")),
      10_000,
    );
    const opened = () => finish();
    const failed = () => finish(new Error("无法连接宿主机"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      if (error === undefined) resolve();
      else reject(error);
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });
}

function nextTextMessage(
  socket: WebSocket,
  timeoutMessage: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(timeoutMessage)), 10_000);
    const message = (event: MessageEvent) =>
      finish(
        typeof event.data === "string"
          ? undefined
          : new Error("握手返回了二进制消息"),
        typeof event.data === "string" ? event.data : undefined,
      );
    const closed = () => finish(new Error("握手期间连接关闭"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timeout);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    socket.addEventListener("message", message, { once: true });
    socket.addEventListener("close", closed, { once: true });
  });
}
