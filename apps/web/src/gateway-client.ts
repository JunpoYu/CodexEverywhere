import {
  NoiseInitiator,
  base64UrlToBytes,
  bytesToBase64Url,
  encodePrologue,
  generateStaticKeyPair,
  type SecureSession,
} from "@codex-everywhere/crypto";
import {
  PROTOCOL_VERSION,
  type EventEnvelope,
  type GatewayCipherFrame,
  type ResponseEnvelope,
} from "@codex-everywhere/protocol";
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { saveHost, type SavedHost } from "./storage.js";
import {
  gatewayReconnectMode,
  type GatewayReconnectMode,
} from "./login-preferences.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type PairingDocument = {
  version: 1;
  principal?: "user" | "host-admin";
  transport: "direct" | "relay";
  endpoint: string;
  directEndpoint?: string;
  relayEndpoint?: string;
  routeId?: string;
  nodeId: string;
  userId: string;
  loginName?: string;
  hostPublicKey: string;
  hostFingerprint: string;
  pairingId: string;
  secret: string;
  expiresAt: string;
};

export type RelayHostDocument = {
  version: 1;
  principal?: "user" | "host-admin";
  transport: "relay";
  endpoint: string;
  directEndpoint?: string;
  routeId: string;
  nodeId: string;
  userId: string;
  hostPublicKey: string;
  hostFingerprint: string;
};

export type DirectHostDocument = {
  version: 1;
  principal?: "user";
  transport: "direct";
  endpoint: string;
  relayEndpoint?: string;
  routeId?: string;
  nodeId: string;
  userId: string;
  hostPublicKey: string;
  hostFingerprint: string;
};

export type HostDocument = RelayHostDocument | DirectHostDocument;

export type ConnectionTarget = {
  transport: "direct" | "relay";
  endpoint: string;
};

export class TemporaryPasswordReauthenticationRequired extends Error {
  constructor() {
    super("Temporary password sessions require interactive login");
    this.name = "TemporaryPasswordReauthenticationRequired";
  }
}

export class GatewayClient {
  readonly host: SavedHost;
  readonly transport: "direct" | "relay";
  readonly #socket: WebSocket;
  readonly #session: SecureSession;
  readonly #pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #eventListeners = new Set<(event: EventEnvelope) => void>();
  readonly #connectionListeners = new Set<(error: Error) => void>();
  #reconnectMode: GatewayReconnectMode = "trusted-device";
  #usable = true;

  private constructor(
    host: SavedHost,
    socket: WebSocket,
    session: SecureSession,
    transport: "direct" | "relay",
  ) {
    this.host = host;
    this.transport = transport;
    this.#socket = socket;
    this.#session = session;
    socket.addEventListener("message", (event) => this.#handleMessage(event));
    socket.addEventListener("close", () =>
      this.#invalidate(new Error("Host connection closed"), false),
    );
    socket.addEventListener("error", () =>
      this.#invalidate(new Error("Host connection failed")),
    );
  }

  static async pair(
    document: PairingDocument,
    deviceName: string,
  ): Promise<{ client: GatewayClient; recoveryCodes: string[] }> {
    validatePairingDocument(document);
    const deviceKeys = generateStaticKeyPair();
    const host: SavedHost = {
      id: document.nodeId,
      kind: document.principal === "host-admin" ? "admin" : "user",
      name: document.loginName ?? document.nodeId,
      ...(document.loginName ? { loginName: document.loginName } : {}),
      endpoint: document.endpoint,
      transport: document.transport,
      ...(document.directEndpoint
        ? { directEndpoint: document.directEndpoint }
        : {}),
      ...(document.relayEndpoint
        ? { relayEndpoint: document.relayEndpoint }
        : {}),
      ...(document.routeId ? { routeId: document.routeId } : {}),
      nodeId: document.nodeId,
      userId: document.userId,
      hostPublicKey: document.hostPublicKey,
      hostFingerprint: document.hostFingerprint,
      deviceId: crypto.randomUUID(),
      deviceName,
      devicePublicKey: bytesToBase64Url(deviceKeys.publicKey),
      deviceSecretKey: bytesToBase64Url(deviceKeys.secretKey),
    };
    const client = await GatewayClient.#openPreferred(host, {
      mode: "pair",
      pairingId: document.pairingId,
      secret: document.secret,
      deviceName,
    });
    const recoveryCodes = await client.#authenticate(true, false);
    await saveHost(host);
    return { client, recoveryCodes };
  }

  static async connect(host: SavedHost): Promise<GatewayClient> {
    const client = await GatewayClient.#openPreferred(host, {
      mode: "connect",
    });
    await client.#authenticate(false, false);
    return client;
  }

  static async lookupRelay(
    endpoint: string,
    loginName: string,
    principal: "user" | "host-admin" = "user",
  ): Promise<RelayHostDocument> {
    const socket = new WebSocket(endpoint);
    await socketOpened(socket);
    try {
      const response = nextTextMessage(socket, "找不到在线的 Codex Agent");
      socket.send(
        JSON.stringify({
          type: "relay/lookup",
          version: 1,
          loginName,
          principal,
        }),
      );
      const value: unknown = JSON.parse(await response);
      if (!isRelayProfile(value))
        throw new Error("Relay 返回了无效的宿主机资料");
      if ((value.principal ?? "user") !== principal)
        throw new Error("Relay 返回了错误的身份域");
      return {
        version: 1,
        principal,
        transport: "relay",
        endpoint,
        ...(typeof value.directEndpoint === "string"
          ? { directEndpoint: value.directEndpoint }
          : {}),
        routeId: value.routeId,
        nodeId: value.nodeId,
        userId: value.userId,
        hostPublicKey: value.hostPublicKey,
        hostFingerprint: value.hostFingerprint,
      };
    } finally {
      socket.close();
    }
  }

  static async discoverDirect(address: string): Promise<DirectHostDocument> {
    const target = new URL(address);
    if (
      target.protocol !== "https:" &&
      !(
        target.protocol === "http:" &&
        (target.hostname === "localhost" || target.hostname === "127.0.0.1")
      )
    )
      throw new Error("Direct 地址必须使用 https://");
    target.pathname = "/.well-known/codex-everywhere";
    target.search = "";
    target.hash = "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(target, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Direct 发现失败 (${response.status})`);
      const value: unknown = await response.json();
      if (!isDirectProfile(value))
        throw new Error("Direct Agent 返回了无效的宿主机资料");
      const endpoint =
        typeof value.directEndpoint === "string"
          ? value.directEndpoint
          : `${target.protocol === "https:" ? "wss:" : "ws:"}//${target.host}/gateway`;
      assertWebSocketEndpoint(endpoint);
      return {
        version: 1,
        transport: "direct",
        endpoint,
        ...(typeof value.relayEndpoint === "string"
          ? { relayEndpoint: value.relayEndpoint }
          : {}),
        ...(typeof value.routeId === "string"
          ? { routeId: value.routeId }
          : {}),
        nodeId: value.nodeId,
        userId: value.userId,
        hostPublicKey: value.hostPublicKey,
        hostFingerprint: value.hostFingerprint,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw new Error("Direct 发现超时");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  static async loginWithPasskey(
    document: HostDocument,
    options: {
      loginName: string;
      deviceName: string;
      rememberDevice: boolean;
    },
  ): Promise<GatewayClient> {
    const deviceKeys = generateStaticKeyPair();
    const host: SavedHost = {
      id: document.nodeId,
      kind: document.principal === "host-admin" ? "admin" : "user",
      name: options.loginName,
      loginName: options.loginName,
      endpoint: document.endpoint,
      transport: document.transport,
      ...(document.transport === "direct"
        ? {
            directEndpoint: document.endpoint,
            ...(document.relayEndpoint
              ? { relayEndpoint: document.relayEndpoint }
              : {}),
          }
        : {
            relayEndpoint: document.endpoint,
            ...(document.directEndpoint
              ? { directEndpoint: document.directEndpoint }
              : {}),
          }),
      ...(document.routeId ? { routeId: document.routeId } : {}),
      nodeId: document.nodeId,
      userId: document.userId,
      hostPublicKey: document.hostPublicKey,
      hostFingerprint: document.hostFingerprint,
      deviceId: crypto.randomUUID(),
      deviceName: options.deviceName,
      devicePublicKey: bytesToBase64Url(deviceKeys.publicKey),
      deviceSecretKey: bytesToBase64Url(deviceKeys.secretKey),
    };
    const client = await GatewayClient.#openPreferred(host, {
      mode: "login",
      deviceName: options.deviceName,
      rememberDevice: options.rememberDevice,
    });
    await client.#authenticate(false, true);
    client.#reconnectMode = gatewayReconnectMode(
      "passkey",
      options.rememberDevice,
    );
    if (options.rememberDevice) await saveHost(host);
    return client;
  }

  static async loginWithPassword(
    document: HostDocument,
    options: {
      loginName: string;
      password: string;
      deviceName: string;
      rememberDevice: boolean;
    },
  ): Promise<GatewayClient> {
    const deviceKeys = generateStaticKeyPair();
    const host: SavedHost = {
      id: document.nodeId,
      kind: document.principal === "host-admin" ? "admin" : "user",
      name: options.loginName,
      loginName: options.loginName,
      endpoint: document.endpoint,
      transport: document.transport,
      ...(document.transport === "direct"
        ? {
            directEndpoint: document.endpoint,
            ...(document.relayEndpoint
              ? { relayEndpoint: document.relayEndpoint }
              : {}),
          }
        : {
            relayEndpoint: document.endpoint,
            ...(document.directEndpoint
              ? { directEndpoint: document.directEndpoint }
              : {}),
          }),
      ...(document.routeId ? { routeId: document.routeId } : {}),
      nodeId: document.nodeId,
      userId: document.userId,
      hostPublicKey: document.hostPublicKey,
      hostFingerprint: document.hostFingerprint,
      deviceId: crypto.randomUUID(),
      deviceName: options.deviceName,
      devicePublicKey: bytesToBase64Url(deviceKeys.publicKey),
      deviceSecretKey: bytesToBase64Url(deviceKeys.secretKey),
    };
    const gateway = await GatewayClient.#openPreferred(host, {
      mode: "login",
      deviceName: options.deviceName,
      rememberDevice: options.rememberDevice,
    });
    await gateway.#authenticatePassword(options.password);
    gateway.#reconnectMode = gatewayReconnectMode(
      "password",
      options.rememberDevice,
    );
    if (options.rememberDevice) await saveHost(host);
    return gateway;
  }

  static async recover(
    document: HostDocument,
    options: {
      loginName: string;
      recoveryCode: string;
      deviceName: string;
      rememberDevice: boolean;
    },
  ): Promise<{ client: GatewayClient; recoveryCodes: string[] }> {
    const deviceKeys = generateStaticKeyPair();
    const host: SavedHost = {
      id: document.nodeId,
      kind: document.principal === "host-admin" ? "admin" : "user",
      name: options.loginName,
      loginName: options.loginName,
      endpoint: document.endpoint,
      transport: document.transport,
      ...(document.transport === "direct"
        ? {
            directEndpoint: document.endpoint,
            ...(document.relayEndpoint
              ? { relayEndpoint: document.relayEndpoint }
              : {}),
          }
        : {
            relayEndpoint: document.endpoint,
            ...(document.directEndpoint
              ? { directEndpoint: document.directEndpoint }
              : {}),
          }),
      ...(document.routeId ? { routeId: document.routeId } : {}),
      nodeId: document.nodeId,
      userId: document.userId,
      hostPublicKey: document.hostPublicKey,
      hostFingerprint: document.hostFingerprint,
      deviceId: crypto.randomUUID(),
      deviceName: options.deviceName,
      devicePublicKey: bytesToBase64Url(deviceKeys.publicKey),
      deviceSecretKey: bytesToBase64Url(deviceKeys.secretKey),
    };
    const client = await GatewayClient.#openPreferred(host, {
      mode: "login",
      deviceName: options.deviceName,
      rememberDevice: options.rememberDevice,
    });
    await client.request("auth/recover", { code: options.recoveryCode });
    const registrationOptions =
      await client.request<PublicKeyCredentialCreationOptionsJSON>(
        "auth/register/options",
        {},
      );
    const response = await startRegistration({
      optionsJSON: registrationOptions,
    });
    const result = await client.request<{
      authenticated: true;
      recoveryCodes: string[];
    }>("auth/register/verify", { response });
    client.#reconnectMode = gatewayReconnectMode(
      "recovery",
      options.rememberDevice,
    );
    if (options.rememberDevice) await saveHost(host);
    return { client, recoveryCodes: result.recoveryCodes };
  }

  static async #openPreferred(
    host: SavedHost,
    auth: Record<string, unknown>,
  ): Promise<GatewayClient> {
    return firstAvailableTarget(connectionTargets(host), (target) =>
      GatewayClient.#open(host, auth, target),
    );
  }

  static async #open(
    host: SavedHost,
    auth: Record<string, unknown>,
    target: ConnectionTarget,
  ): Promise<GatewayClient> {
    const socket = new WebSocket(target.endpoint);
    try {
      await socketOpened(socket);
      if (target.transport === "relay") {
        if (!host.routeId) throw new Error("Relay route is missing");
        const readyMessage = nextTextMessage(socket, "Relay route timed out");
        socket.send(
          JSON.stringify({
            type: "relay/connect",
            version: 1,
            routeId: host.routeId,
          }),
        );
        const ready = JSON.parse(await readyMessage) as {
          type?: string;
          version?: number;
        };
        if (ready.type !== "relay/ready" || ready.version !== 1) {
          throw new Error("Relay route was rejected");
        }
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
      const replyMessage = nextTextMessage(
        socket,
        "Encrypted handshake timed out",
      );
      socket.send(
        JSON.stringify({
          type: "handshake/hello",
          version: PROTOCOL_VERSION,
          nodeId: host.nodeId,
          deviceId: host.deviceId,
          message: bytesToBase64Url(
            handshake.start(encoder.encode(JSON.stringify(auth))),
          ),
        }),
      );
      const reply = JSON.parse(await replyMessage) as {
        type?: string;
        message?: string;
      };
      if (
        reply.type !== "handshake/reply" ||
        typeof reply.message !== "string"
      ) {
        throw new Error("Host rejected the encrypted handshake");
      }
      const completed = handshake.finish(base64UrlToBytes(reply.message));
      const accepted = JSON.parse(decoder.decode(completed.payload)) as {
        ok?: boolean;
        loginName?: string;
      };
      if (!accepted.ok) throw new Error("Host did not accept this device");
      const connectedHost = accepted.loginName?.trim()
        ? {
            ...host,
            name:
              host.name === host.nodeId ? accepted.loginName.trim() : host.name,
            loginName: accepted.loginName.trim(),
          }
        : host;
      return new GatewayClient(
        connectedHost,
        socket,
        completed.session,
        target.transport,
      );
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  async #authenticate(
    newlyPaired: boolean,
    discoverable: boolean,
  ): Promise<string[]> {
    const status = await this.request<{
      authenticated: boolean;
      registrationRequired: boolean;
    }>("auth/status", {});
    if (status.authenticated) return [];
    if (status.registrationRequired && newlyPaired) {
      const options =
        await this.request<PublicKeyCredentialCreationOptionsJSON>(
          "auth/register/options",
          {},
        );
      const response = await startRegistration({ optionsJSON: options });
      const result = await this.request<{
        authenticated: true;
        recoveryCodes: string[];
      }>("auth/register/verify", { response });
      return result.recoveryCodes;
    }
    const options = await this.request<PublicKeyCredentialRequestOptionsJSON>(
      "auth/login/options",
      { discoverable },
    );
    const response = await startAuthentication({ optionsJSON: options });
    if (
      discoverable &&
      response.response.userHandle !== this.host.hostPublicKey
    ) {
      throw new Error("这个 Passkey 不属于目标 Codex 宿主机，请选择正确的账户");
    }
    await this.request("auth/login/verify", { response });
    return [];
  }

  async setPassword(password: string): Promise<void> {
    if (
      password.length < 9 ||
      !/[A-Za-z]/u.test(password) ||
      !/[0-9]/u.test(password)
    )
      throw new Error("密码至少 9 个字符，并需要同时包含字母和数字");
    const opaque = await loadOpaque();
    await opaque.ready;
    const started = opaque.client.startRegistration({ password });
    const response = await this.request<{ registrationResponse: string }>(
      "auth/password/register/start",
      { registrationRequest: started.registrationRequest },
    );
    const finished = opaque.client.finishRegistration({
      password,
      clientRegistrationState: started.clientRegistrationState,
      registrationResponse: response.registrationResponse,
      identifiers: this.#opaqueIdentifiers(),
    });
    await this.request("auth/password/register/finish", {
      registrationRecord: finished.registrationRecord,
    });
  }

  async addPasskey(): Promise<void> {
    const options = await this.request<PublicKeyCredentialCreationOptionsJSON>(
      "auth/register/options",
      {},
    );
    const response = await startRegistration({ optionsJSON: options });
    await this.request("auth/register/verify", { response });
  }

  async rotateRecoveryCodes(): Promise<string[]> {
    return (
      await this.request<{ recoveryCodes: string[] }>(
        "auth/recovery/rotate",
        {},
      )
    ).recoveryCodes;
  }

  async #authenticatePassword(password: string): Promise<void> {
    const opaque = await loadOpaque();
    await opaque.ready;
    const started = opaque.client.startLogin({ password });
    const response = await this.request<{ loginResponse: string }>(
      "auth/password/login/start",
      { startLoginRequest: started.startLoginRequest },
    );
    const finished = opaque.client.finishLogin({
      password,
      clientLoginState: started.clientLoginState,
      loginResponse: response.loginResponse,
      identifiers: this.#opaqueIdentifiers(),
    });
    if (!finished) throw new Error("CodexEverywhere 密码不正确");
    await this.request("auth/password/login/finish", {
      finishLoginRequest: finished.finishLoginRequest,
    });
  }

  #opaqueIdentifiers(): { client: string; server: string } {
    return {
      client: this.host.userId,
      server: this.host.hostPublicKey,
    };
  }

  request<T = unknown>(
    method: string,
    payload: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.#usable || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Host connection is unavailable"));
    }
    const requestId = crypto.randomUUID();
    const frames = this.#session.encryptMessage(
      encoder.encode(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          requestId,
          idempotencyKey: crypto.randomUUID(),
          method,
          payload,
        }),
      ),
    );
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        const error = new Error(`Host request timed out: ${method}`);
        reject(error);
        // A timed-out request may have been written to a half-open tunnel.
        // Never reuse that transport and never retry the request implicitly:
        // state-changing methods may already have reached the Host.
        this.#invalidate(error);
      }, options.timeoutMs ?? 30_000);
      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        for (const frame of frames) this.#socket.send(encodeFrame(frame));
      } catch {
        this.#pending.delete(requestId);
        clearTimeout(timeout);
        const error = new Error(
          `Host connection failed while sending: ${method}`,
        );
        reject(error);
        this.#invalidate(error);
      }
    });
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    this.#connectionListeners.add(listener);
    return () => this.#connectionListeners.delete(listener);
  }

  async healthCheck(timeoutMs = 4_000): Promise<void> {
    try {
      await this.request("host/ping", {}, { timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Receiving a structured "unknown method" response from an older Agent
      // still proves that the encrypted transport is alive.
      if (
        /Unsupported gateway method:\s*host\/ping|method not found|unknown method/iu.test(
          message,
        )
      )
        return;
      throw error;
    }
  }

  async reconnect(): Promise<GatewayClient> {
    if (this.#reconnectMode === "temporary-password") {
      throw new TemporaryPasswordReauthenticationRequired();
    }
    if (this.#reconnectMode === "temporary-passkey") {
      return GatewayClient.loginWithPasskey(hostDocument(this.host), {
        loginName: this.host.loginName ?? this.host.name,
        deviceName: this.host.deviceName,
        rememberDevice: false,
      });
    }
    return GatewayClient.connect(this.host);
  }

  close(): void {
    this.#invalidate(new Error("Host connection closed"));
  }

  #invalidate(error: Error, closeSocket = true): void {
    if (!this.#usable) return;
    this.#usable = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#connectionListeners) {
      try {
        listener(error);
      } catch {
        // Connection cleanup must complete even if a UI listener fails.
      }
    }
    if (
      closeSocket &&
      (this.#socket.readyState === WebSocket.OPEN ||
        this.#socket.readyState === WebSocket.CONNECTING)
    ) {
      this.#socket.close();
    }
  }

  #handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    try {
      const wire = JSON.parse(event.data) as GatewayCipherFrame;
      const plaintext = this.#session.decryptMessage({
        sessionId: wire.sessionId,
        sequence: wire.sequence,
        ciphertext: base64UrlToBytes(wire.ciphertext),
      });
      if (!plaintext) return;
      const value: unknown = JSON.parse(decoder.decode(plaintext));
      if (!isRecord(value)) return;
      if (typeof value.requestId === "string") {
        const response = value as ResponseEnvelope;
        const pending = this.#pending.get(response.requestId);
        if (!pending) return;
        this.#pending.delete(response.requestId);
        clearTimeout(pending.timeout);
        if (response.ok) pending.resolve(response.result);
        else
          pending.reject(
            new Error(response.error?.message ?? "Host request failed"),
          );
      } else if (typeof value.eventId === "string") {
        for (const listener of this.#eventListeners)
          listener(value as EventEnvelope);
      }
    } catch {
      this.#socket.close();
    }
  }
}

function loadOpaque(): Promise<typeof import("@serenity-kit/opaque")> {
  return import("@serenity-kit/opaque");
}

function isRelayProfile(value: unknown): value is {
  type: "relay/profile";
  version: 1;
  routeId: string;
  nodeId: string;
  userId: string;
  hostPublicKey: string;
  hostFingerprint: string;
  directEndpoint?: string;
  principal?: "user" | "host-admin";
} {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.type === "relay/profile" &&
    profile.version === 1 &&
    (profile.principal === undefined ||
      profile.principal === "user" ||
      profile.principal === "host-admin") &&
    typeof profile.routeId === "string" &&
    typeof profile.nodeId === "string" &&
    typeof profile.userId === "string" &&
    typeof profile.hostPublicKey === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(profile.hostPublicKey) &&
    typeof profile.hostFingerprint === "string"
  );
}

function isDirectProfile(value: unknown): value is {
  type: "host/profile";
  version: 1;
  nodeId: string;
  userId: string;
  hostPublicKey: string;
  hostFingerprint: string;
  directEndpoint?: string;
  relayEndpoint?: string;
  routeId?: string;
} {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return (
    profile.type === "host/profile" &&
    profile.version === 1 &&
    typeof profile.nodeId === "string" &&
    typeof profile.userId === "string" &&
    typeof profile.hostPublicKey === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(profile.hostPublicKey) &&
    typeof profile.hostFingerprint === "string" &&
    (profile.directEndpoint === undefined ||
      typeof profile.directEndpoint === "string") &&
    (profile.relayEndpoint === undefined ||
      typeof profile.relayEndpoint === "string") &&
    (profile.routeId === undefined || typeof profile.routeId === "string")
  );
}

function assertWebSocketEndpoint(endpoint: string): void {
  const value = new URL(endpoint);
  if (value.protocol !== "wss:" && value.protocol !== "ws:")
    throw new Error("Direct Gateway 必须使用 wss:// 或 ws://");
}

function hostDocument(host: SavedHost): HostDocument {
  if (host.transport === "direct") {
    return {
      version: 1,
      transport: "direct",
      endpoint: host.directEndpoint ?? host.endpoint,
      ...(host.relayEndpoint ? { relayEndpoint: host.relayEndpoint } : {}),
      ...(host.routeId ? { routeId: host.routeId } : {}),
      nodeId: host.nodeId,
      userId: host.userId,
      hostPublicKey: host.hostPublicKey,
      hostFingerprint: host.hostFingerprint,
    };
  }
  if (!host.routeId) throw new Error("Relay route is missing");
  return {
    version: 1,
    ...(host.kind === "admin" ? { principal: "host-admin" as const } : {}),
    transport: "relay",
    endpoint: host.relayEndpoint ?? host.endpoint,
    ...(host.directEndpoint ? { directEndpoint: host.directEndpoint } : {}),
    routeId: host.routeId,
    nodeId: host.nodeId,
    userId: host.userId,
    hostPublicKey: host.hostPublicKey,
    hostFingerprint: host.hostFingerprint,
  };
}

export function connectionTargets(host: SavedHost): ConnectionTarget[] {
  const targets: ConnectionTarget[] = [];
  const add = (target: ConnectionTarget | undefined) => {
    if (!target) return;
    if (
      targets.some(
        (existing) =>
          existing.transport === target.transport &&
          existing.endpoint === target.endpoint,
      )
    )
      return;
    targets.push(target);
  };
  add(
    host.directEndpoint
      ? { transport: "direct", endpoint: host.directEndpoint }
      : undefined,
  );
  add(
    host.transport === "direct"
      ? { transport: "direct", endpoint: host.endpoint }
      : undefined,
  );
  add(
    host.relayEndpoint
      ? { transport: "relay", endpoint: host.relayEndpoint }
      : undefined,
  );
  add(
    host.transport === "relay"
      ? { transport: "relay", endpoint: host.endpoint }
      : undefined,
  );
  return targets;
}

export async function firstAvailableTarget<T>(
  targets: ConnectionTarget[],
  open: (target: ConnectionTarget) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const target of targets) {
    try {
      return await open(target);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("没有可用的 CodexEverywhere 连接路径");
}

function encodeFrame(frame: {
  sessionId: string;
  sequence: number;
  ciphertext: Uint8Array;
}): string {
  return JSON.stringify({
    type: "cipher",
    version: PROTOCOL_VERSION,
    sessionId: frame.sessionId,
    sequence: frame.sequence,
    ciphertext: bytesToBase64Url(frame.ciphertext),
  });
}

function socketOpened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Host connection timed out")),
      10_000,
    );
    const opened = () => finish();
    const failed = () => finish(new Error("Cannot reach host"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      if (error) reject(error);
      else resolve();
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
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, 10_000);
    const handleMessage = (event: MessageEvent) => {
      cleanup();
      if (typeof event.data === "string") resolve(event.data);
      else reject(new Error("Unexpected binary handshake reply"));
    };
    const handleClose = (event: CloseEvent) => {
      cleanup();
      const message =
        event.reason === "pairing expired"
          ? "配对资料已过期，请重新运行 ce device pair"
          : event.reason === "pairing invalid"
            ? "配对资料无效或已经使用，请重新运行 ce device pair"
            : event.reason === "wrong node"
              ? "配对资料与当前宿主机不匹配"
              : "Host closed the connection during handshake";
      reject(new Error(message));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("close", handleClose);
    };
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", handleClose, { once: true });
  });
}

export function validatePairingDocument(value: PairingDocument): void {
  if (
    value.version !== 1 ||
    (value.principal !== undefined &&
      value.principal !== "user" &&
      value.principal !== "host-admin") ||
    (value.transport !== "direct" && value.transport !== "relay") ||
    typeof value.endpoint !== "string" ||
    (value.directEndpoint !== undefined &&
      typeof value.directEndpoint !== "string") ||
    (value.relayEndpoint !== undefined &&
      typeof value.relayEndpoint !== "string") ||
    typeof value.nodeId !== "string" ||
    typeof value.userId !== "string" ||
    (value.loginName !== undefined && typeof value.loginName !== "string") ||
    typeof value.hostPublicKey !== "string" ||
    typeof value.pairingId !== "string" ||
    typeof value.secret !== "string" ||
    (value.transport === "relay" && typeof value.routeId !== "string") ||
    typeof value.expiresAt !== "string" ||
    Number.isNaN(Date.parse(value.expiresAt))
  ) {
    throw new Error("配对资料格式无效");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
