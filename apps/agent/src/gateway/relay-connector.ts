import { EventEmitter } from "node:events";

import {
  RELAY_MESSAGE_TYPES,
  RELAY_PROTOCOL_VERSION,
  parseRelayWireMessage,
} from "@codex-everywhere/protocol";
import type { StaticKeyPair } from "@codex-everywhere/crypto";
import WebSocket, { type RawData } from "ws";

export interface RelayConnectorOptions {
  readonly endpoint: string;
  readonly routeId: string;
  routeCapability: string;
  readonly nodeId: string;
  readonly userId: string;
  readonly principal?: "user" | "host-admin";
  readonly identity: Pick<StaticKeyPair, "publicKey">;
  readonly hostFingerprint: string;
  readonly directEndpoint?: string;
  readonly acceptGatewaySocket: (socket: WebSocket) => void;
  /** Relay control ping interval. Primarily configurable for tests. */
  readonly relayControlHeartbeatMs?: number;
  /** Consecutive unanswered control pings tolerated before reconnecting. */
  readonly relayControlHeartbeatMissLimit?: number;
  /** Reconnect delay. Primarily configurable for deterministic tests. */
  readonly relayReconnectDelayMs?: number;
}

const CONTROL_HEARTBEAT_MS = 15_000;
const CONTROL_HEARTBEAT_MISS_LIMIT = 4;
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
  #unansweredPings = 0;
  #controlTransition: Promise<void> = Promise.resolve();

  private constructor(options: RelayConnectorOptions) {
    super();
    this.#options = options;
  }

  static async start(options: RelayConnectorOptions): Promise<RelayConnector> {
    const heartbeatMs = options.relayControlHeartbeatMs ?? CONTROL_HEARTBEAT_MS;
    const heartbeatMissLimit =
      options.relayControlHeartbeatMissLimit ?? CONTROL_HEARTBEAT_MISS_LIMIT;
    const reconnectDelayMs = options.relayReconnectDelayMs ?? 1_000;
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs <= 0)
      throw new Error("Relay control heartbeat interval must be positive");
    if (!Number.isSafeInteger(heartbeatMissLimit) || heartbeatMissLimit <= 0)
      throw new Error("Relay control heartbeat miss limit must be positive");
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs <= 0)
      throw new Error("Relay reconnect delay must be positive");
    const connector = new RelayConnector(options);
    await connector.#transitionControl();
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

  async rotateRouteCapability(routeCapability: string): Promise<void> {
    if (this.#stopped) throw new Error("Relay connector is stopped");
    if (routeCapability === this.#options.routeCapability) return;
    await this.#transitionControl(routeCapability);
  }

  #transitionControl(
    candidateCapability?: string,
    onlyIfDisconnected = false,
  ): Promise<void> {
    const transition = this.#controlTransition.then(async () => {
      if (this.#stopped) throw new Error("Relay connector is stopped");
      if (onlyIfDisconnected && this.#control?.readyState === WebSocket.OPEN) {
        return;
      }
      await this.#connectControl(
        candidateCapability ?? this.#options.routeCapability,
      );
    });
    this.#controlTransition = transition.catch(() => undefined);
    return transition;
  }

  async #connectControl(
    candidateCapability = this.#options.routeCapability,
  ): Promise<void> {
    let socket: WebSocket | undefined;
    const previousCapability = this.#options.routeCapability;
    let registrationSent = false;
    let responseReceived = false;
    let registrationAccepted = false;
    try {
      socket = await openSocket(this.#options.endpoint);
      this.#track(socket);
      socket.send(
        JSON.stringify({
          type: RELAY_MESSAGE_TYPES.register,
          version: RELAY_PROTOCOL_VERSION,
          capability: candidateCapability,
          profile: {
            principal: this.#options.principal ?? "user",
            nodeId: this.#options.nodeId,
            userId: this.#options.userId,
            hostPublicKey: Buffer.from(
              this.#options.identity.publicKey,
            ).toString("base64url"),
            hostFingerprint: this.#options.hostFingerprint,
            ...(this.#options.directEndpoint
              ? { directEndpoint: this.#options.directEndpoint }
              : {}),
          },
        }),
      );
      registrationSent = true;
      // A provisioned renewal is persisted before control rotation begins.
      // Once its registration frame has been sent, a close/timeout is
      // ambiguous: the Relay may already have installed the candidate and
      // advanced its monotonic authorization high-water mark. Reconnect with
      // the candidate in that case. A response that can be parsed as an
      // explicit rejection below still restores the previous capability.
      this.#options.routeCapability = candidateCapability;
      const response = await nextMessage(socket);
      responseReceived = true;
      const registered = parseRelayWireMessage(
        response,
        RELAY_MESSAGE_TYPES.registered,
      );
      if (registered.routeId !== this.#options.routeId)
        throw new Error("Relay registration rejected");
      registrationAccepted = true;
      if (this.#stopped) throw new Error("Relay connector is stopped");
      const previousControl = this.#control;
      this.#options.routeCapability = candidateCapability;
      this.#control = socket;
      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
      this.#startHeartbeat(socket);
      socket.on("message", (data) => {
        if (this.#control === socket) this.#handleControlMessage(data);
      });
      socket.once("close", () => {
        if (this.#control !== socket) return;
        this.#control = undefined;
        this.#stopHeartbeat();
        this.#scheduleReconnect();
      });
      if (
        previousControl &&
        previousControl !== socket &&
        previousControl.readyState !== WebSocket.CLOSED
      ) {
        // A conforming Relay replaces the old route owner, but do not rely on
        // that behaviour: a compatible third-party Relay must not leave the
        // superseded control socket tracked forever. Data tunnels are separate
        // sockets and intentionally remain open across capability rotation.
        previousControl.terminate();
      }
      this.emit("connected");
    } catch (error) {
      if (
        registrationSent &&
        responseReceived &&
        !registrationAccepted &&
        !this.#stopped
      ) {
        this.#options.routeCapability = previousCapability;
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      throw error;
    }
  }

  #handleControlMessage(data: RawData): void {
    try {
      const message = parseRelayWireMessage(
        data.toString(),
        RELAY_MESSAGE_TYPES.incoming,
      );
      if (
        typeof message.connectionId !== "string" ||
        message.connectionId.length === 0 ||
        message.connectionId.length > 128
      )
        throw new Error("Invalid Relay connection ID");
      void this.#acceptIncoming(message.connectionId);
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
    let tunnel: WebSocket | undefined;
    try {
      tunnel = await openSocket(this.#options.endpoint);
      const acceptedTunnel = tunnel;
      this.#pendingIncomingTunnels -= 1;
      pending = false;
      this.#track(acceptedTunnel);
      this.#incomingTunnels.add(acceptedTunnel);
      acceptedTunnel.once("close", () =>
        this.#incomingTunnels.delete(acceptedTunnel),
      );
      acceptedTunnel.send(
        JSON.stringify({
          type: RELAY_MESSAGE_TYPES.accept,
          version: RELAY_PROTOCOL_VERSION,
          capability: this.#options.routeCapability,
          connectionId,
        }),
      );
      parseRelayWireMessage(
        await nextMessage(acceptedTunnel),
        RELAY_MESSAGE_TYPES.accepted,
      );
      this.#options.acceptGatewaySocket(acceptedTunnel);
      acceptedTunnel.send(
        JSON.stringify({
          type: RELAY_MESSAGE_TYPES.tunnelReady,
          version: RELAY_PROTOCOL_VERSION,
        }),
      );
    } catch {
      if (pending) this.#pendingIncomingTunnels -= 1;
      if (tunnel && tunnel.readyState !== WebSocket.CLOSED) tunnel.terminate();
      // A browser may disappear before the tunnel is accepted. The control
      // connection may also be half-open. Re-register so later connections
      // do not repeatedly wait for the same stale route.
      this.#control?.terminate();
    }
  }

  #track(socket: WebSocket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.on("error", () => socket.terminate());
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#transitionControl(undefined, true).catch(() =>
        this.#scheduleReconnect(),
      );
    }, this.#options.relayReconnectDelayMs ?? 1_000);
  }

  #startHeartbeat(socket: WebSocket): void {
    this.#stopHeartbeat();
    this.#unansweredPings = 0;
    socket.on("pong", () => {
      if (this.#control === socket) this.#unansweredPings = 0;
    });
    this.#heartbeatTimer = setInterval(() => {
      if (this.#control !== socket || socket.readyState !== WebSocket.OPEN)
        return;
      if (
        this.#unansweredPings >=
        (this.#options.relayControlHeartbeatMissLimit ??
          CONTROL_HEARTBEAT_MISS_LIMIT)
      ) {
        socket.terminate();
        return;
      }
      this.#unansweredPings += 1;
      socket.ping();
    }, this.#options.relayControlHeartbeatMs ?? CONTROL_HEARTBEAT_MS);
    this.#heartbeatTimer.unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#unansweredPings = 0;
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
