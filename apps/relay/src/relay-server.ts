import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  relayLoginId,
  routeCapabilityLoginId,
  verifyRouteCapability,
} from "./capability.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const ACCEPT_TIMEOUT_MS = 10_000;
const MAX_RELAY_SOCKETS = 4_096;
const MAX_PENDING_CONNECTIONS = 1_024;
const MAX_CONNECTIONS_PER_ROUTE = 32;

export type RelayServerOptions = {
  host: string;
  port: number;
  signingKey: Uint8Array;
};

type PendingConnection = {
  routeId: string;
  browser: WebSocket;
  timeout: ReturnType<typeof setTimeout>;
};

type PublicHostProfile = {
  nodeId: string;
  userId: string;
  hostPublicKey: string;
  hostFingerprint: string;
  directEndpoint?: string;
};

type RegisteredRoute = {
  socket: WebSocket;
  profile?: PublicHostProfile;
  loginId?: string;
};

export class RelayServer extends EventEmitter<{ listening: [number] }> {
  readonly #server: WebSocketServer;
  readonly #options: RelayServerOptions;
  readonly #routes = new Map<string, RegisteredRoute>();
  readonly #logins = new Map<string, string>();
  readonly #pending = new Map<string, PendingConnection>();
  readonly #sockets = new Set<WebSocket>();
  readonly #activeByRoute = new Map<string, number>();

  private constructor(server: WebSocketServer, options: RelayServerOptions) {
    super();
    this.#server = server;
    this.#options = options;
    server.on("connection", (socket) => this.#accept(socket));
  }

  static async start(options: RelayServerOptions): Promise<RelayServer> {
    const server = new WebSocketServer({
      host: options.host,
      port: options.port,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    const relay = new RelayServer(server, options);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    relay.emit("listening", relay.port);
    return relay;
  }

  get port(): number {
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw new Error("Relay is not listening");
    return address.port;
  }

  async close(): Promise<void> {
    for (const pending of this.#pending.values()) clearTimeout(pending.timeout);
    this.#pending.clear();
    for (const socket of this.#sockets) socket.close(1001, "relay stopping");
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #accept(socket: WebSocket): void {
    if (this.#sockets.size >= MAX_RELAY_SOCKETS) {
      socket.close(1013, "relay busy");
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    nextMessage(socket, ACCEPT_TIMEOUT_MS)
      .then((raw) => this.#routeFirstMessage(socket, raw))
      .catch(() => socket.close(1008, "invalid relay handshake"));
  }

  #routeFirstMessage(socket: WebSocket, raw: string): void {
    const message = parseRecord(raw);
    if (message.version !== 1 || typeof message.type !== "string") {
      throw new Error("Invalid relay protocol version");
    }
    if (message.type === "relay/register") {
      this.#register(socket, message);
      return;
    }
    if (message.type === "relay/connect") {
      this.#connect(socket, message);
      return;
    }
    if (message.type === "relay/lookup") {
      this.#lookup(socket, message);
      return;
    }
    if (message.type === "relay/accept") {
      this.#acceptTunnel(socket, message);
      return;
    }
    throw new Error("Unknown relay handshake");
  }

  #register(socket: WebSocket, message: Record<string, unknown>): void {
    if (typeof message.capability !== "string")
      throw new Error("Missing capability");
    const capability = verifyRouteCapability(
      message.capability,
      this.#options.signingKey,
    );
    const loginId = routeCapabilityLoginId(
      capability,
      this.#options.signingKey,
    );
    const profile = parsePublicHostProfile(message.profile);
    if (loginId && !profile)
      throw new Error("Login-enabled route requires a public profile");
    const conflictingRoute = loginId ? this.#logins.get(loginId) : undefined;
    if (conflictingRoute && conflictingRoute !== capability.routeId)
      throw new Error("Login name registered by another route");
    const previous = this.#routes.get(capability.routeId);
    if (previous && previous.socket !== socket)
      previous.socket.close(1008, "route registered elsewhere");
    this.#routes.set(capability.routeId, {
      socket,
      ...(profile ? { profile } : {}),
      ...(loginId ? { loginId } : {}),
    });
    if (loginId) this.#logins.set(loginId, capability.routeId);
    socket.once("close", () => {
      if (this.#routes.get(capability.routeId)?.socket === socket) {
        this.#routes.delete(capability.routeId);
        if (loginId && this.#logins.get(loginId) === capability.routeId)
          this.#logins.delete(loginId);
      }
    });
    socket.send(
      JSON.stringify({
        type: "relay/registered",
        version: 1,
        routeId: capability.routeId,
      }),
    );
  }

  #connect(socket: WebSocket, message: Record<string, unknown>): void {
    if (typeof message.routeId !== "string") throw new Error("Missing route");
    const route = this.#routes.get(message.routeId);
    const control = route?.socket;
    if (!control || control.readyState !== WebSocket.OPEN) {
      socket.close(1013, "route offline");
      return;
    }
    const routeLoad =
      (this.#activeByRoute.get(message.routeId) ?? 0) +
      [...this.#pending.values()].filter(
        (pending) => pending.routeId === message.routeId,
      ).length;
    if (
      this.#pending.size >= MAX_PENDING_CONNECTIONS ||
      routeLoad >= MAX_CONNECTIONS_PER_ROUTE
    ) {
      socket.close(1013, "route busy");
      return;
    }
    const connectionId = randomUUID();
    const timeout = setTimeout(() => {
      this.#pending.delete(connectionId);
      socket.close(1013, "agent did not accept connection");
    }, ACCEPT_TIMEOUT_MS);
    this.#pending.set(connectionId, {
      routeId: message.routeId,
      browser: socket,
      timeout,
    });
    socket.once("close", () => this.#clearPending(connectionId));
    control.send(
      JSON.stringify({ type: "relay/incoming", version: 1, connectionId }),
    );
  }

  #lookup(socket: WebSocket, message: Record<string, unknown>): void {
    if (typeof message.loginName !== "string")
      throw new Error("Missing login name");
    const loginId = relayLoginId(this.#options.signingKey, message.loginName);
    const routeId = this.#logins.get(loginId);
    const route = routeId ? this.#routes.get(routeId) : undefined;
    if (
      !routeId ||
      !route?.profile ||
      route.socket.readyState !== WebSocket.OPEN
    ) {
      socket.close(1013, "login unavailable");
      return;
    }
    socket.send(
      JSON.stringify({
        type: "relay/profile",
        version: 1,
        routeId,
        ...route.profile,
      }),
    );
  }

  #acceptTunnel(socket: WebSocket, message: Record<string, unknown>): void {
    if (
      typeof message.capability !== "string" ||
      typeof message.connectionId !== "string"
    ) {
      throw new Error("Invalid tunnel acceptance");
    }
    const capability = verifyRouteCapability(
      message.capability,
      this.#options.signingKey,
    );
    const pending = this.#pending.get(message.connectionId);
    if (!pending || pending.routeId !== capability.routeId)
      throw new Error("Unknown relay connection");
    this.#pending.delete(message.connectionId);
    clearTimeout(pending.timeout);
    if (pending.browser.readyState !== WebSocket.OPEN)
      throw new Error("Browser connection closed");
    socket.send(JSON.stringify({ type: "relay/accepted", version: 1 }));
    nextMessage(socket, ACCEPT_TIMEOUT_MS)
      .then((raw) => {
        const ready = parseRecord(raw);
        if (ready.type !== "relay/tunnel-ready" || ready.version !== 1)
          throw new Error("Agent tunnel is not ready");
        if (pending.browser.readyState !== WebSocket.OPEN)
          throw new Error("Browser connection closed");
        this.#incrementRoute(pending.routeId);
        bridge(pending.browser, socket, () =>
          this.#decrementRoute(pending.routeId),
        );
        pending.browser.send(
          JSON.stringify({ type: "relay/ready", version: 1 }),
        );
      })
      .catch(() => {
        if (pending.browser.readyState === WebSocket.OPEN)
          pending.browser.close(1013, "agent tunnel setup failed");
        if (socket.readyState === WebSocket.OPEN)
          socket.close(1008, "invalid tunnel readiness");
      });
  }

  #clearPending(connectionId: string): void {
    const pending = this.#pending.get(connectionId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(connectionId);
  }

  #incrementRoute(routeId: string): void {
    this.#activeByRoute.set(
      routeId,
      (this.#activeByRoute.get(routeId) ?? 0) + 1,
    );
  }

  #decrementRoute(routeId: string): void {
    const remaining = (this.#activeByRoute.get(routeId) ?? 1) - 1;
    if (remaining <= 0) this.#activeByRoute.delete(routeId);
    else this.#activeByRoute.set(routeId, remaining);
  }
}

function parsePublicHostProfile(value: unknown): PublicHostProfile | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object")
    throw new Error("Invalid public host profile");
  const profile = value as Record<string, unknown>;
  if (
    typeof profile.nodeId !== "string" ||
    typeof profile.userId !== "string" ||
    typeof profile.hostPublicKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(profile.hostPublicKey) ||
    typeof profile.hostFingerprint !== "string" ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(profile.hostFingerprint) ||
    (profile.directEndpoint !== undefined &&
      typeof profile.directEndpoint !== "string")
  ) {
    throw new Error("Invalid public host profile");
  }
  return {
    nodeId: profile.nodeId,
    userId: profile.userId,
    hostPublicKey: profile.hostPublicKey,
    hostFingerprint: profile.hostFingerprint,
    ...(typeof profile.directEndpoint === "string"
      ? { directEndpoint: validDirectEndpoint(profile.directEndpoint) }
      : {}),
  };
}

function validDirectEndpoint(value: string): string {
  if (value.length > 2048) throw new Error("Invalid direct endpoint");
  const endpoint = new URL(value);
  if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:")
    throw new Error("Invalid direct endpoint");
  return endpoint.toString();
}

function bridge(left: WebSocket, right: WebSocket, onClose: () => void): void {
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  left.on("message", (data, isBinary) => forward(right, data, isBinary));
  right.on("message", (data, isBinary) => forward(left, data, isBinary));
  left.once("close", (code, reason) => {
    finish();
    closePeer(right, code, reason);
  });
  right.once("close", (code, reason) => {
    finish();
    closePeer(left, code, reason);
  });
  left.once("error", () => right.close(1011, "peer connection failed"));
  right.once("error", () => left.close(1011, "peer connection failed"));
}

function closePeer(target: WebSocket, code: number, reason: Buffer): void {
  if (target.readyState !== WebSocket.OPEN) return;
  // 1005/1006 are local sentinel values and cannot be put on the wire.
  // Browsers and reverse proxies commonly disconnect without a close frame.
  const sendable =
    (code >= 1000 &&
      code <= 1014 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006) ||
    (code >= 3000 && code <= 4999);
  target.close(sendable ? code : 1000, sendable ? reason : undefined);
}

function forward(target: WebSocket, data: RawData, isBinary: boolean): void {
  if (target.readyState === WebSocket.OPEN)
    target.send(data, { binary: isBinary });
}

function nextMessage(socket: WebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Relay handshake timed out")),
      timeoutMs,
    );
    const message = (data: RawData) => finish(undefined, data.toString());
    const closed = () => finish(new Error("Relay connection closed"));
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timeout);
      socket.off("message", message);
      socket.off("close", closed);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    socket.once("message", message);
    socket.once("close", closed);
  });
}

function parseRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("Invalid relay message");
  return value as Record<string, unknown>;
}
