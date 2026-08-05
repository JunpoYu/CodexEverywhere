import { EventEmitter } from "node:events";

import WebSocket, { type RawData } from "ws";

import {
  acceptGatewaySocket,
  type DirectGatewayOptions,
} from "./direct-gateway.js";

export type RelayConnectorOptions = DirectGatewayOptions & {
  endpoint: string;
  routeId: string;
  routeCapability: string;
  directEndpoint?: string;
};

const CONTROL_HEARTBEAT_MS = 15_000;
const MAX_INCOMING_TUNNELS = 32;

export class RelayConnector extends EventEmitter<{ connected: [] }> {
  readonly #options: RelayConnectorOptions;
  readonly #sockets = new Set<WebSocket>();
  readonly #incomingTunnels = new Set<WebSocket>();
  #pendingIncomingTunnels = 0;
  #control: WebSocket | undefined;
  #stopped = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #awaitingPong = false;

  private constructor(options: RelayConnectorOptions) {
    super();
    this.#options = options;
  }

  static async start(options: RelayConnectorOptions): Promise<RelayConnector> {
    const connector = new RelayConnector(options);
    await connector.#connectControl();
    return connector;
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    for (const socket of this.#sockets) socket.terminate();
    this.#sockets.clear();
    this.#control = undefined;
  }

  async #connectControl(): Promise<void> {
    const socket = await openSocket(this.#options.endpoint);
    this.#track(socket);
    socket.send(
      JSON.stringify({
        type: "relay/register",
        version: 1,
        capability: this.#options.routeCapability,
        profile: {
          principal: this.#options.principal ?? "user",
          nodeId: this.#options.nodeId,
          userId: this.#options.userId,
          hostPublicKey: Buffer.from(this.#options.identity.publicKey).toString(
            "base64url",
          ),
          hostFingerprint: this.#options.hostFingerprint,
          ...(this.#options.directEndpoint
            ? { directEndpoint: this.#options.directEndpoint }
            : {}),
        },
      }),
    );
    const registered = parseRecord(await nextMessage(socket));
    if (
      registered.type !== "relay/registered" ||
      registered.version !== 1 ||
      registered.routeId !== this.#options.routeId
    ) {
      socket.close(1008, "Relay registration rejected");
      throw new Error("Relay registration rejected");
    }
    this.#control = socket;
    this.#startHeartbeat(socket);
    socket.on("message", (data) => this.#handleControlMessage(data));
    socket.once("close", () => {
      if (this.#control === socket) {
        this.#control = undefined;
        this.#stopHeartbeat();
      }
      this.#scheduleReconnect();
    });
    this.emit("connected");
  }

  #handleControlMessage(data: RawData): void {
    try {
      const message = parseRecord(data.toString());
      if (
        message.type === "relay/incoming" &&
        message.version === 1 &&
        typeof message.connectionId === "string"
      ) {
        void this.#acceptIncoming(message.connectionId);
      }
    } catch {
      this.#control?.close(1008, "Invalid Relay control message");
    }
  }

  async #acceptIncoming(connectionId: string): Promise<void> {
    if (
      this.#incomingTunnels.size + this.#pendingIncomingTunnels >=
      MAX_INCOMING_TUNNELS
    )
      return;
    this.#pendingIncomingTunnels += 1;
    let pending = true;
    try {
      const tunnel = await openSocket(this.#options.endpoint);
      this.#pendingIncomingTunnels -= 1;
      pending = false;
      this.#track(tunnel);
      this.#incomingTunnels.add(tunnel);
      tunnel.once("close", () => this.#incomingTunnels.delete(tunnel));
      tunnel.send(
        JSON.stringify({
          type: "relay/accept",
          version: 1,
          capability: this.#options.routeCapability,
          connectionId,
        }),
      );
      const ready = parseRecord(await nextMessage(tunnel));
      if (ready.type !== "relay/accepted" || ready.version !== 1) {
        tunnel.close(1008, "Relay tunnel rejected");
        return;
      }
      acceptGatewaySocket(tunnel, this.#options);
      tunnel.send(JSON.stringify({ type: "relay/tunnel-ready", version: 1 }));
    } catch {
      if (pending) this.#pendingIncomingTunnels -= 1;
      // A browser may disappear before the tunnel is accepted. The control
      // connection may also be half-open. Re-register so later connections
      // do not repeatedly wait for the same stale route.
      this.#control?.terminate();
    }
  }

  #track(socket: WebSocket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connectControl().catch(() => this.#scheduleReconnect());
    }, 1_000);
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#stopHeartbeat();
    this.#awaitingPong = false;
    socket.on("pong", () => {
      if (this.#control === socket) this.#awaitingPong = false;
    });
    this.#heartbeatTimer = setInterval(() => {
      if (this.#control !== socket || socket.readyState !== WebSocket.OPEN)
        return;
      if (this.#awaitingPong) {
        socket.terminate();
        return;
      }
      this.#awaitingPong = true;
      socket.ping();
    }, CONTROL_HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#awaitingPong = false;
  }
}

function openSocket(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { perMessageDeflate: false });
    const timeout = setTimeout(
      () => finish(new Error("Relay connection timed out")),
      10_000,
    );
    const opened = () => finish(undefined, socket);
    const failed = () => finish(new Error("Cannot reach Relay"));
    const finish = (error?: Error, value?: WebSocket) => {
      clearTimeout(timeout);
      socket.off("open", opened);
      socket.off("error", failed);
      if (error) {
        socket.close();
        reject(error);
      } else resolve(value ?? socket);
    };
    socket.once("open", opened);
    socket.once("error", failed);
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Relay response timed out")),
      10_000,
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
    throw new Error("Invalid Relay message");
  return value as Record<string, unknown>;
}
