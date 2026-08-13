import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  RELAY_MESSAGE_TYPES,
  RELAY_PROTOCOL_VERSION,
  parseRelayWireMessage,
} from "@codex-everywhere/protocol";

import {
  normalizeInstallationId,
  relayInstallationPrincipalLoginId,
  relayPrincipalLoginId,
  routeCapabilityLoginId,
  routeCapabilityEffectiveExpiration,
  routeCapabilityOwnerId,
  routeCapabilityPrincipal,
  type RouteCapabilityPayload,
  type RelayPrincipal,
  verifyRouteCapability,
} from "./capability.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const ACCEPT_TIMEOUT_MS = 10_000;
const MAX_RELAY_SOCKETS = 4_096;
const MAX_SOCKETS_PER_ADDRESS = 128;
const MAX_PENDING_CONNECTIONS = 1_024;
const MAX_CONNECTIONS_PER_ROUTE = 32;
const MAX_ROUTE_AUTHORIZATIONS = 4_096;
const MAX_CONNECTS_PER_WINDOW = 120;
const MAX_LOOKUPS_PER_WINDOW = 120;
const CONNECT_WINDOW_MS = 60_000;
const LOOKUP_WINDOW_MS = 60_000;
const MAX_ADDRESS_RATE_BUCKETS = 4_096;
const MAX_TUNNEL_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_RELAY_BUFFERED_BYTES = 64 * 1024 * 1024;
const TUNNEL_HEARTBEAT_MS = 15_000;
const TUNNEL_HEARTBEAT_MISS_LIMIT = 4;
const MAX_ROUTE_EXPIRATION_TIMER_MS = 2_147_483_647;
const ROUTE_AUTHORIZATION_EXPIRED_REASON = "route authorization expired";

export type RelayExpirationClock = {
  now: () => number;
  setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export type RelayServerOptions = {
  host: string;
  port: number;
  signingKey: Uint8Array;
  installationId: string;
  tunnelHeartbeatMs?: number;
  tunnelHeartbeatMissLimit?: number;
  maxSocketsPerAddress?: number;
  maxRouteAuthorizations?: number;
  maxConnectsPerWindow?: number;
  connectWindowMs?: number;
  maxLookupsPerWindow?: number;
  lookupWindowMs?: number;
  maxAddressRateBuckets?: number;
  maxTunnelBufferedBytes?: number;
  maxRelayBufferedBytes?: number;
  trustLoopbackProxy?: boolean;
  expirationClock?: RelayExpirationClock;
};

const defaultRelayExpirationClock: RelayExpirationClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

type PendingConnection = {
  routeId: string;
  routeOwnerId?: string;
  browser: WebSocket;
  timeout: ReturnType<typeof setTimeout>;
};

type PublicHostProfile = {
  principal: RelayPrincipal;
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
  ownerId?: string;
};

type RouteAuthorizationGeneration = {
  ownerId?: string;
  expiresAt?: number;
  issuedAt: number;
  capabilityDigest: string;
};

type RouteAuthorization = RouteAuthorizationGeneration & {
  timer?: ReturnType<typeof setTimeout>;
};

type PendingTunnelSetup = {
  routeId: string;
  browser: WebSocket;
  agent: WebSocket;
};

type ActiveTunnel = {
  browser: WebSocket;
  agent: WebSocket;
};

type RateBucket = { startedAt: number; count: number };

class RelayBufferedByteBudget {
  readonly #maximumBytes: number;
  #reservedBytes = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("Relay buffered byte budget must be positive");
    }
    this.#maximumBytes = maximumBytes;
  }

  reserve(bytes: number): (() => void) | undefined {
    if (bytes === 0) return () => undefined;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#reservedBytes + bytes > this.#maximumBytes
    ) {
      return undefined;
    }
    this.#reservedBytes += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reservedBytes = Math.max(0, this.#reservedBytes - bytes);
    };
  }
}

export class RelayServer extends EventEmitter<{ listening: [number] }> {
  readonly #server: WebSocketServer;
  readonly #options: RelayServerOptions;
  readonly #routes = new Map<string, RegisteredRoute>();
  readonly #routeAuthorizations = new Map<string, RouteAuthorization>();
  readonly #logins = new Map<string, string>();
  readonly #pending = new Map<string, PendingConnection>();
  readonly #pendingTunnelSetups = new Map<string, Set<PendingTunnelSetup>>();
  readonly #sockets = new Set<WebSocket>();
  readonly #socketAddress = new WeakMap<WebSocket, string>();
  readonly #socketsByAddress = new Map<string, number>();
  readonly #connectsByAddress = new Map<string, RateBucket>();
  readonly #lookupsByAddress = new Map<string, RateBucket>();
  readonly #activeByRoute = new Map<string, Set<ActiveTunnel>>();
  readonly #bufferedByteBudget: RelayBufferedByteBudget;
  readonly #expirationClock: RelayExpirationClock;

  private constructor(server: WebSocketServer, options: RelayServerOptions) {
    super();
    this.#server = server;
    this.#options = options;
    this.#bufferedByteBudget = new RelayBufferedByteBudget(
      options.maxRelayBufferedBytes ?? MAX_RELAY_BUFFERED_BYTES,
    );
    this.#expirationClock =
      options.expirationClock ?? defaultRelayExpirationClock;
    server.on("connection", (socket, request) => this.#accept(socket, request));
  }

  static async start(options: RelayServerOptions): Promise<RelayServer> {
    const tunnelHeartbeatMs = options.tunnelHeartbeatMs ?? TUNNEL_HEARTBEAT_MS;
    const tunnelHeartbeatMissLimit =
      options.tunnelHeartbeatMissLimit ?? TUNNEL_HEARTBEAT_MISS_LIMIT;
    if (!Number.isSafeInteger(tunnelHeartbeatMs) || tunnelHeartbeatMs <= 0)
      throw new Error("Relay tunnel heartbeat interval must be positive");
    if (
      !Number.isSafeInteger(tunnelHeartbeatMissLimit) ||
      tunnelHeartbeatMissLimit <= 0
    )
      throw new Error("Relay tunnel heartbeat miss limit must be positive");
    const maxRouteAuthorizations =
      options.maxRouteAuthorizations ?? MAX_ROUTE_AUTHORIZATIONS;
    if (
      !Number.isSafeInteger(maxRouteAuthorizations) ||
      maxRouteAuthorizations <= 0
    ) {
      throw new Error("Relay route authorization limit must be positive");
    }
    const normalizedOptions = {
      ...options,
      installationId: normalizeInstallationId(options.installationId),
    };
    const server = new WebSocketServer({
      host: normalizedOptions.host,
      port: normalizedOptions.port,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    const relay = new RelayServer(server, normalizedOptions);
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
    this.#pendingTunnelSetups.clear();
    this.#activeByRoute.clear();
    for (const authorization of this.#routeAuthorizations.values()) {
      if (authorization.timer)
        this.#expirationClock.clearTimeout(authorization.timer);
    }
    this.#routeAuthorizations.clear();
    this.#routes.clear();
    this.#logins.clear();
    for (const socket of this.#sockets) socket.close(1001, "relay stopping");
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  #accept(socket: WebSocket, request: IncomingMessage): void {
    const address = clientAddress(request, this.#options.trustLoopbackProxy);
    const addressCount = this.#socketsByAddress.get(address) ?? 0;
    if (
      this.#sockets.size >= MAX_RELAY_SOCKETS ||
      addressCount >=
        (this.#options.maxSocketsPerAddress ?? MAX_SOCKETS_PER_ADDRESS)
    ) {
      socket.close(1013, "relay busy");
      return;
    }
    this.#sockets.add(socket);
    this.#socketAddress.set(socket, address);
    this.#socketsByAddress.set(address, addressCount + 1);
    socket.once("close", () => {
      this.#sockets.delete(socket);
      const remaining = (this.#socketsByAddress.get(address) ?? 1) - 1;
      if (remaining <= 0) {
        this.#socketsByAddress.delete(address);
      } else {
        this.#socketsByAddress.set(address, remaining);
      }
    });
    nextMessage(socket, ACCEPT_TIMEOUT_MS)
      .then((raw) => this.#routeFirstMessage(socket, raw))
      .catch(() => socket.close(1008, "invalid relay handshake"));
  }

  #routeFirstMessage(socket: WebSocket, raw: string): void {
    const message = parseRelayWireMessage(raw);
    if (message.type === RELAY_MESSAGE_TYPES.register) {
      this.#register(socket, message);
      return;
    }
    if (message.type === RELAY_MESSAGE_TYPES.connect) {
      this.#connect(socket, message);
      return;
    }
    if (message.type === RELAY_MESSAGE_TYPES.lookup) {
      this.#lookup(socket, message);
      return;
    }
    if (message.type === RELAY_MESSAGE_TYPES.accept) {
      this.#acceptTunnel(socket, message);
      return;
    }
    throw new Error("Unknown relay handshake");
  }

  #register(socket: WebSocket, message: Record<string, unknown>): void {
    if (typeof message.capability !== "string")
      throw new Error("Missing capability");
    const capability = this.#verifyCapability(message.capability);
    const loginId = routeCapabilityLoginId(
      capability,
      this.#options.signingKey,
    );
    const ownerId = routeCapabilityOwnerId(
      capability,
      this.#options.signingKey,
    );
    const effectiveExpiration = routeCapabilityEffectiveExpiration(
      message.capability,
    );
    const authorizationGeneration: RouteAuthorizationGeneration = {
      ...(ownerId ? { ownerId } : {}),
      ...(effectiveExpiration
        ? { expiresAt: Date.parse(effectiveExpiration) }
        : {}),
      issuedAt: Date.parse(capability.issuedAt),
      capabilityDigest: routeCapabilityDigest(message.capability),
    };
    const profile = parsePublicHostProfile(message.profile);
    if (loginId && !profile)
      throw new Error("Login-enabled route requires a public profile");
    if (profile && profile.principal !== routeCapabilityPrincipal(capability))
      throw new Error("Relay principal does not match route capability");
    const conflictingRoute = loginId ? this.#logins.get(loginId) : undefined;
    if (conflictingRoute && conflictingRoute !== capability.routeId)
      throw new Error("Login name registered by another route");
    const previousAuthorization = this.#currentRouteAuthorization(
      capability.routeId,
    );
    const previous = this.#routes.get(capability.routeId);
    if (
      (previousAuthorization ?? previous) !== undefined &&
      (previousAuthorization?.ownerId ?? previous?.ownerId) !== ownerId
    ) {
      throw new Error("Route registered by another owner namespace");
    }
    if (previousAuthorization)
      assertMonotonicRouteAuthorization(
        previousAuthorization,
        authorizationGeneration,
      );
    if (
      previous?.loginId &&
      previous.loginId !== loginId &&
      this.#logins.get(previous.loginId) === capability.routeId
    ) {
      this.#logins.delete(previous.loginId);
    }
    this.#authorizeRoute(capability.routeId, authorizationGeneration);
    this.#routes.set(capability.routeId, {
      socket,
      ...(profile ? { profile } : {}),
      ...(loginId ? { loginId } : {}),
      ...(ownerId ? { ownerId } : {}),
    });
    if (loginId) this.#logins.set(loginId, capability.routeId);
    if (previous && previous.socket !== socket)
      previous.socket.close(1008, "route registered elsewhere");
    socket.once("close", () => {
      if (this.#routes.get(capability.routeId)?.socket === socket) {
        this.#routes.delete(capability.routeId);
        if (loginId && this.#logins.get(loginId) === capability.routeId)
          this.#logins.delete(loginId);
        this.#pruneRouteAuthorization(capability.routeId);
      }
    });
    socket.send(
      JSON.stringify({
        type: RELAY_MESSAGE_TYPES.registered,
        version: RELAY_PROTOCOL_VERSION,
        routeId: capability.routeId,
      }),
      (error) => {
        if (error) socket.terminate();
      },
    );
  }

  #connect(socket: WebSocket, message: Record<string, unknown>): void {
    if (
      !this.#consumeAddressBudget(
        socket,
        this.#connectsByAddress,
        this.#options.maxConnectsPerWindow ?? MAX_CONNECTS_PER_WINDOW,
        this.#options.connectWindowMs ?? CONNECT_WINDOW_MS,
      )
    ) {
      socket.close(1013, "connect rate exceeded");
      return;
    }
    if (typeof message.routeId !== "string") throw new Error("Missing route");
    const route = this.#currentRegisteredRoute(message.routeId);
    const control = route?.socket;
    if (!control || control.readyState !== WebSocket.OPEN) {
      socket.close(1013, "route offline");
      return;
    }
    const routeLoad =
      (this.#activeByRoute.get(message.routeId)?.size ?? 0) +
      (this.#pendingTunnelSetups.get(message.routeId)?.size ?? 0) +
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
      this.#clearPending(connectionId);
      socket.close(1013, "agent did not accept connection");
    }, ACCEPT_TIMEOUT_MS);
    this.#pending.set(connectionId, {
      routeId: message.routeId,
      ...(route.ownerId ? { routeOwnerId: route.ownerId } : {}),
      browser: socket,
      timeout,
    });
    socket.once("close", () => this.#clearPending(connectionId));
    control.send(
      JSON.stringify({
        type: RELAY_MESSAGE_TYPES.incoming,
        version: RELAY_PROTOCOL_VERSION,
        connectionId,
      }),
    );
  }

  #lookup(socket: WebSocket, message: Record<string, unknown>): void {
    if (!this.#consumeLookup(socket)) {
      socket.close(1013, "lookup rate exceeded");
      return;
    }
    if (typeof message.loginName !== "string")
      throw new Error("Missing login name");
    const principal = parseRelayPrincipal(message.principal);
    const scopedLoginId = relayInstallationPrincipalLoginId(
      this.#options.signingKey,
      this.#options.installationId,
      principal,
      message.loginName,
    );
    const legacyLoginId = relayPrincipalLoginId(
      this.#options.signingKey,
      principal,
      message.loginName,
    );
    const routeId =
      this.#logins.get(scopedLoginId) ?? this.#logins.get(legacyLoginId);
    const route = routeId ? this.#currentRegisteredRoute(routeId) : undefined;
    if (
      !routeId ||
      !route?.profile ||
      route.socket.readyState !== WebSocket.OPEN
    ) {
      socket.close(1013, "login unavailable");
      return;
    }
    const { principal: routePrincipal, ...publicProfile } = route.profile;
    socket.send(
      JSON.stringify({
        type: RELAY_MESSAGE_TYPES.profile,
        version: RELAY_PROTOCOL_VERSION,
        routeId,
        ...(routePrincipal === "host-admin"
          ? { principal: routePrincipal }
          : {}),
        ...publicProfile,
      }),
      (error) => {
        if (error) socket.terminate();
        else socket.close(1000, "lookup complete");
      },
    );
  }

  #consumeLookup(socket: WebSocket): boolean {
    return this.#consumeAddressBudget(
      socket,
      this.#lookupsByAddress,
      this.#options.maxLookupsPerWindow ?? MAX_LOOKUPS_PER_WINDOW,
      this.#options.lookupWindowMs ?? LOOKUP_WINDOW_MS,
    );
  }

  #consumeAddressBudget(
    socket: WebSocket,
    buckets: Map<string, RateBucket>,
    maximum: number,
    windowMs: number,
  ): boolean {
    const address = this.#socketAddress.get(socket) ?? "unknown";
    const now = this.#expirationClock.now();
    let bucket = buckets.get(address);
    if (bucket && now - bucket.startedAt >= windowMs) {
      buckets.delete(address);
      bucket = undefined;
    }
    if (!bucket) {
      const capacity =
        this.#options.maxAddressRateBuckets ?? MAX_ADDRESS_RATE_BUCKETS;
      if (buckets.size >= capacity) {
        const oldest = buckets.entries().next().value as
          [string, RateBucket] | undefined;
        if (!oldest || now - oldest[1].startedAt < windowMs) return false;
        buckets.delete(oldest[0]);
      }
      bucket = { startedAt: now, count: 0 };
      buckets.set(address, bucket);
    }
    bucket.count += 1;
    return bucket.count <= maximum;
  }

  #acceptTunnel(socket: WebSocket, message: Record<string, unknown>): void {
    if (
      typeof message.capability !== "string" ||
      typeof message.connectionId !== "string"
    ) {
      throw new Error("Invalid tunnel acceptance");
    }
    const capability = this.#verifyCapability(message.capability);
    const pending = this.#pending.get(message.connectionId);
    if (!pending || pending.routeId !== capability.routeId)
      throw new Error("Unknown relay connection");
    const ownerId = routeCapabilityOwnerId(
      capability,
      this.#options.signingKey,
    );
    const authorization = this.#currentRouteAuthorization(pending.routeId);
    if (
      !authorization ||
      authorization.ownerId !== ownerId ||
      ownerId !== pending.routeOwnerId
    ) {
      throw new Error("Relay connection belongs to another provisioned owner");
    }
    this.#pending.delete(message.connectionId);
    clearTimeout(pending.timeout);
    if (pending.browser.readyState !== WebSocket.OPEN)
      throw new Error("Browser connection closed");
    const setup: PendingTunnelSetup = {
      routeId: pending.routeId,
      browser: pending.browser,
      agent: socket,
    };
    this.#addPendingTunnelSetup(setup);
    socket.send(
      JSON.stringify({
        type: RELAY_MESSAGE_TYPES.accepted,
        version: RELAY_PROTOCOL_VERSION,
      }),
    );
    nextMessage(socket, ACCEPT_TIMEOUT_MS)
      .then((raw) => {
        parseRelayWireMessage(raw, RELAY_MESSAGE_TYPES.tunnelReady);
        if (!this.#hasPendingTunnelSetup(setup))
          throw new Error("Relay route authorization expired");
        if (!this.#currentRouteAuthorization(pending.routeId))
          throw new Error("Relay route authorization expired");
        if (pending.browser.readyState !== WebSocket.OPEN)
          throw new Error("Browser connection closed");
        const active: ActiveTunnel = {
          browser: pending.browser,
          agent: socket,
        };
        this.#addActiveTunnel(pending.routeId, active);
        this.#removePendingTunnelSetup(setup);
        bridge(
          pending.browser,
          socket,
          () => this.#removeActiveTunnel(pending.routeId, active),
          () => this.#currentRouteAuthorization(pending.routeId) !== undefined,
          this.#options.tunnelHeartbeatMs ?? TUNNEL_HEARTBEAT_MS,
          this.#options.tunnelHeartbeatMissLimit ?? TUNNEL_HEARTBEAT_MISS_LIMIT,
          this.#options.maxTunnelBufferedBytes ?? MAX_TUNNEL_BUFFERED_BYTES,
          this.#bufferedByteBudget,
        );
        pending.browser.send(
          JSON.stringify({
            type: RELAY_MESSAGE_TYPES.ready,
            version: RELAY_PROTOCOL_VERSION,
          }),
        );
      })
      .catch(() => {
        this.#removePendingTunnelSetup(setup);
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
    this.#pruneRouteAuthorization(pending.routeId);
  }

  #addPendingTunnelSetup(setup: PendingTunnelSetup): void {
    const setups =
      this.#pendingTunnelSetups.get(setup.routeId) ??
      new Set<PendingTunnelSetup>();
    setups.add(setup);
    this.#pendingTunnelSetups.set(setup.routeId, setups);
  }

  #hasPendingTunnelSetup(setup: PendingTunnelSetup): boolean {
    return this.#pendingTunnelSetups.get(setup.routeId)?.has(setup) ?? false;
  }

  #removePendingTunnelSetup(setup: PendingTunnelSetup): void {
    const setups = this.#pendingTunnelSetups.get(setup.routeId);
    if (!setups?.delete(setup)) return;
    if (setups.size === 0) this.#pendingTunnelSetups.delete(setup.routeId);
    this.#pruneRouteAuthorization(setup.routeId);
  }

  #addActiveTunnel(routeId: string, active: ActiveTunnel): void {
    const activeTunnels =
      this.#activeByRoute.get(routeId) ?? new Set<ActiveTunnel>();
    activeTunnels.add(active);
    this.#activeByRoute.set(routeId, activeTunnels);
  }

  #removeActiveTunnel(routeId: string, active: ActiveTunnel): void {
    const activeTunnels = this.#activeByRoute.get(routeId);
    if (!activeTunnels?.delete(active)) return;
    if (activeTunnels.size === 0) this.#activeByRoute.delete(routeId);
    this.#pruneRouteAuthorization(routeId);
  }

  #authorizeRoute(
    routeId: string,
    generation: RouteAuthorizationGeneration,
  ): void {
    const previous = this.#routeAuthorizations.get(routeId);
    if (
      !previous &&
      this.#routeAuthorizations.size >=
        (this.#options.maxRouteAuthorizations ?? MAX_ROUTE_AUTHORIZATIONS)
    ) {
      throw new Error("Relay route authorization capacity exceeded");
    }
    if (previous?.timer) this.#expirationClock.clearTimeout(previous.timer);
    const authorization: RouteAuthorization = {
      ...generation,
    };
    this.#routeAuthorizations.set(routeId, authorization);
    this.#scheduleRouteExpiration(routeId, authorization);
  }

  #scheduleRouteExpiration(
    routeId: string,
    authorization: RouteAuthorization,
  ): void {
    if (authorization.expiresAt === undefined) return;
    const remaining = authorization.expiresAt - this.#expirationClock.now();
    const timer = this.#expirationClock.setTimeout(
      () => {
        delete authorization.timer;
        if (this.#routeAuthorizations.get(routeId) !== authorization) return;
        if (
          authorization.expiresAt !== undefined &&
          authorization.expiresAt <= this.#expirationClock.now()
        ) {
          this.#expireRouteAuthorization(routeId, authorization);
          return;
        }
        this.#scheduleRouteExpiration(routeId, authorization);
      },
      Math.min(Math.max(remaining, 0), MAX_ROUTE_EXPIRATION_TIMER_MS),
    );
    authorization.timer = timer;
    timer.unref?.();
  }

  #currentRouteAuthorization(routeId: string): RouteAuthorization | undefined {
    const authorization = this.#routeAuthorizations.get(routeId);
    if (
      authorization?.expiresAt !== undefined &&
      authorization.expiresAt <= this.#expirationClock.now()
    ) {
      this.#expireRouteAuthorization(routeId, authorization);
      return undefined;
    }
    return authorization;
  }

  #currentRegisteredRoute(routeId: string): RegisteredRoute | undefined {
    if (!this.#currentRouteAuthorization(routeId)) return undefined;
    return this.#routes.get(routeId);
  }

  #expireRouteAuthorization(
    routeId: string,
    authorization: RouteAuthorization,
  ): void {
    if (this.#routeAuthorizations.get(routeId) !== authorization) return;
    this.#routeAuthorizations.delete(routeId);
    if (authorization.timer)
      this.#expirationClock.clearTimeout(authorization.timer);

    const route = this.#routes.get(routeId);
    if (route) {
      this.#routes.delete(routeId);
      if (route.loginId && this.#logins.get(route.loginId) === routeId)
        this.#logins.delete(route.loginId);
    }

    for (const [connectionId, pending] of this.#pending) {
      if (pending.routeId !== routeId) continue;
      this.#pending.delete(connectionId);
      clearTimeout(pending.timeout);
      closeForExpiredRouteAuthorization(pending.browser);
    }

    const setups = this.#pendingTunnelSetups.get(routeId);
    this.#pendingTunnelSetups.delete(routeId);
    for (const setup of setups ?? []) {
      closeForExpiredRouteAuthorization(setup.browser);
      closeForExpiredRouteAuthorization(setup.agent);
    }

    const activeTunnels = this.#activeByRoute.get(routeId);
    this.#activeByRoute.delete(routeId);
    for (const active of activeTunnels ?? []) {
      closeForExpiredRouteAuthorization(active.browser);
      closeForExpiredRouteAuthorization(active.agent);
    }

    if (route) closeForExpiredRouteAuthorization(route.socket);
  }

  #pruneRouteAuthorization(routeId: string): void {
    if (
      this.#routes.has(routeId) ||
      this.#pendingTunnelSetups.has(routeId) ||
      this.#activeByRoute.has(routeId) ||
      [...this.#pending.values()].some((pending) => pending.routeId === routeId)
    ) {
      return;
    }
    const authorization = this.#routeAuthorizations.get(routeId);
    if (!authorization) return;
    // Finite generations are the route's rollback high-water mark. Retain them
    // until their effective expiration even while the route is completely
    // offline. Unbounded legacy capabilities cannot be retained forever, so
    // they are released as soon as the route has no live state.
    if (authorization.expiresAt !== undefined) return;
    this.#routeAuthorizations.delete(routeId);
  }

  #verifyCapability(value: string): RouteCapabilityPayload {
    const capability = verifyRouteCapability(
      value,
      this.#options.signingKey,
      new Date(this.#expirationClock.now()),
    );
    if (
      (capability.version === 3 || capability.version === 4) &&
      capability.installationId !== this.#options.installationId
    ) {
      throw new Error("Route capability belongs to another installation");
    }
    return capability;
  }
}

function assertMonotonicRouteAuthorization(
  current: RouteAuthorizationGeneration,
  candidate: RouteAuthorizationGeneration,
): void {
  const currentExpiration = current.expiresAt ?? Number.POSITIVE_INFINITY;
  const candidateExpiration = candidate.expiresAt ?? Number.POSITIVE_INFINITY;
  if (candidateExpiration < currentExpiration) {
    throw new Error("Route capability cannot shorten current authorization");
  }
  if (candidateExpiration > currentExpiration) return;
  if (candidate.issuedAt < current.issuedAt) {
    throw new Error("Route capability predates current authorization");
  }
  if (
    candidate.issuedAt === current.issuedAt &&
    candidate.capabilityDigest !== current.capabilityDigest
  ) {
    throw new Error("Conflicting route capability generation");
  }
}

function routeCapabilityDigest(capability: string): string {
  return createHash("sha256")
    .update("ce-relay-capability-generation-v1\0")
    .update(capability)
    .digest("base64url");
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
    principal: parseRelayPrincipal(profile.principal),
    nodeId: profile.nodeId,
    userId: profile.userId,
    hostPublicKey: profile.hostPublicKey,
    hostFingerprint: profile.hostFingerprint,
    ...(typeof profile.directEndpoint === "string"
      ? { directEndpoint: validDirectEndpoint(profile.directEndpoint) }
      : {}),
  };
}

function parseRelayPrincipal(value: unknown): RelayPrincipal {
  if (value === undefined || value === "user") return "user";
  if (value === "host-admin") return value;
  throw new Error("Invalid Relay principal");
}

function validDirectEndpoint(value: string): string {
  if (value.length > 2048) throw new Error("Invalid direct endpoint");
  const endpoint = new URL(value);
  if (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:")
    throw new Error("Invalid direct endpoint");
  return endpoint.toString();
}

function bridge(
  left: WebSocket,
  right: WebSocket,
  onClose: () => void,
  isAuthorized: () => boolean,
  heartbeatMs: number,
  heartbeatMissLimit: number,
  maxBufferedBytes: number,
  bufferedByteBudget: RelayBufferedByteBudget,
): void {
  let closed = false;
  let leftUnansweredPings = 0;
  let rightUnansweredPings = 0;
  const pendingReservations = new Set<() => void>();
  const heartbeat = setInterval(() => {
    if (!isAuthorized()) return;
    const leftTimedOut = leftUnansweredPings >= heartbeatMissLimit;
    const rightTimedOut = rightUnansweredPings >= heartbeatMissLimit;
    if (leftTimedOut) left.terminate();
    if (rightTimedOut) right.terminate();
    if (leftTimedOut || rightTimedOut) return;
    if (left.readyState === WebSocket.OPEN) {
      leftUnansweredPings += 1;
      left.ping();
    }
    if (right.readyState === WebSocket.OPEN) {
      rightUnansweredPings += 1;
      right.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const release of pendingReservations) release();
    pendingReservations.clear();
    onClose();
  };
  left.on("pong", () => {
    leftUnansweredPings = 0;
  });
  right.on("pong", () => {
    rightUnansweredPings = 0;
  });
  left.on("message", (data, isBinary) => {
    if (!isAuthorized()) return;
    forward(
      left,
      right,
      data,
      isBinary,
      maxBufferedBytes,
      bufferedByteBudget,
      pendingReservations,
    );
  });
  right.on("message", (data, isBinary) => {
    if (!isAuthorized()) return;
    forward(
      right,
      left,
      data,
      isBinary,
      maxBufferedBytes,
      bufferedByteBudget,
      pendingReservations,
    );
  });
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

function closeForExpiredRouteAuthorization(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.close(1008, ROUTE_AUTHORIZATION_EXPIRED_REASON);
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

function forward(
  source: WebSocket,
  target: WebSocket,
  data: RawData,
  isBinary: boolean,
  maxBufferedBytes: number,
  bufferedByteBudget: RelayBufferedByteBudget,
  pendingReservations: Set<() => void>,
): void {
  if (target.readyState !== WebSocket.OPEN) return;
  const bytes = rawDataBytes(data);
  if (target.bufferedAmount + bytes > maxBufferedBytes) {
    target.terminate();
    if (source.readyState === WebSocket.OPEN)
      source.close(1013, "relay peer is too slow");
    return;
  }
  const release = bufferedByteBudget.reserve(bytes);
  if (!release) {
    target.terminate();
    if (source.readyState === WebSocket.OPEN)
      source.close(1013, "relay buffer budget exceeded");
    return;
  }
  pendingReservations.add(release);
  const settled = (error?: Error) => {
    pendingReservations.delete(release);
    release();
    if (error && target.readyState === WebSocket.OPEN)
      target.close(1011, "relay forwarding failed");
  };
  try {
    target.send(data, { binary: isBinary }, settled);
  } catch (error) {
    settled(error instanceof Error ? error : new Error("Relay send failed"));
  }
}

function rawDataBytes(data: RawData): number {
  if (Array.isArray(data))
    return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function clientAddress(
  request: IncomingMessage,
  trustLoopbackProxy = false,
): string {
  const direct = request.socket.remoteAddress ?? "unknown";
  if (!trustLoopbackProxy || !isLoopbackAddress(direct)) return direct;
  const forwarded = request.headers["x-real-ip"];
  if (typeof forwarded !== "string" || isIP(forwarded) === 0) return direct;
  return forwarded;
}

function isLoopbackAddress(value: string): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
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
