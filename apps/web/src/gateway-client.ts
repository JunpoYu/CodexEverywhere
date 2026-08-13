import {
  NoiseInitiator,
  base64UrlToBytes,
  bytesToBase64Url,
  encodePrologue,
  generateStaticKeyPair,
  type SecureSession,
} from "@codex-everywhere/crypto";
import {
  GATEWAY_CAPABILITIES,
  PROTOCOL_VERSION,
  RELAY_MESSAGE_TYPES,
  RELAY_PROTOCOL_VERSION,
  parseGatewayCipherFrame,
  parseGatewayHandshakeResult,
  parseGatewayHandshakeReply,
  parseGatewayServerEnvelope,
  parseRelayWireMessage,
  type EventEnvelope,
  type ProtocolError,
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

export class GatewayReauthenticationRequired extends Error {
  constructor() {
    super("The Host requires interactive authentication");
    this.name = "GatewayReauthenticationRequired";
  }
}

export class GatewayInteractiveReauthenticationFailed extends Error {
  constructor(cause: unknown) {
    super("Interactive Host authentication did not complete", { cause });
    this.name = "GatewayInteractiveReauthenticationFailed";
  }
}

/**
 * The encrypted request was accepted by the browser transport, but no Host
 * response arrived before its deadline. `transportLost` distinguishes a
 * proven tunnel failure from a slow response. Callers must preserve the
 * idempotency key until the authoritative outcome has been reconciled.
 */
export class GatewayRequestOutcomeUnknownError extends Error {
  readonly method: string;
  readonly idempotencyKey: string;
  readonly transportLost: boolean;

  constructor(
    method: string,
    idempotencyKey: string,
    cause: Error,
    options: { transportLost?: boolean } = {},
  ) {
    const transportLost = options.transportLost ?? false;
    super(
      transportLost
        ? `Host connection failed; outcome unknown for ${method}`
        : `Host request outcome unknown for ${method}`,
      { cause },
    );
    this.name = "GatewayRequestOutcomeUnknownError";
    this.method = method;
    this.idempotencyKey = idempotencyKey;
    this.transportLost = transportLost;
  }
}

export class GatewayResponseError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "GatewayResponseError";
    this.code = error.code;
    this.retryable = error.retryable ?? false;
  }
}

export function isGatewayRequestOutcomeUnknown(
  error: unknown,
): error is GatewayRequestOutcomeUnknownError {
  return error instanceof GatewayRequestOutcomeUnknownError;
}

export type GatewayRequestOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
};

export class GatewayClient {
  readonly host: SavedHost;
  readonly transport: "direct" | "relay";
  readonly capabilities: ReadonlySet<string>;
  readonly #socket: WebSocket;
  readonly #session: SecureSession;
  readonly #pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
      method: string;
      idempotencyKey: string;
    }
  >();
  readonly #eventListeners = new Set<(event: EventEnvelope) => void>();
  readonly #connectionListeners = new Set<(error: Error) => void>();
  #reconnectMode: GatewayReconnectMode = "trusted-device";
  #resumeToken: string | undefined;
  #reauthenticationRequired = false;
  #usable = true;

  private constructor(
    host: SavedHost,
    socket: WebSocket,
    session: SecureSession,
    transport: "direct" | "relay",
    capabilities: readonly string[] = [],
  ) {
    this.host = host;
    this.transport = transport;
    this.#socket = socket;
    this.#session = session;
    this.capabilities = new Set(capabilities);
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

  static async connect(
    host: SavedHost,
    options: {
      canInteract?: () => boolean;
      onInteractionStarted?: () => void;
    } = {},
  ): Promise<GatewayClient> {
    const client = await GatewayClient.#openPreferred(host, {
      mode: "connect",
    });
    try {
      await client.#authenticate(
        false,
        false,
        options.canInteract,
        options.onInteractionStarted,
      );
    } catch (error) {
      client.close();
      throw error;
    }
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
          type: RELAY_MESSAGE_TYPES.lookup,
          version: RELAY_PROTOCOL_VERSION,
          loginName,
          principal,
        }),
      );
      const value = parseRelayWireMessage(
        await response,
        RELAY_MESSAGE_TYPES.profile,
      );
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
    await client.#authenticate(false, false);
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
      resumeToken?: string;
    }>("auth/register/verify", { response });
    client.#rememberResumeToken(result);
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
    return firstAvailableTarget(
      connectionTargets(host),
      (target) => GatewayClient.#open(host, auth, target),
      { stopOn: isGatewayReauthenticationRequired },
    );
  }

  static async #open(
    host: SavedHost,
    auth: Record<string, unknown>,
    target: ConnectionTarget,
  ): Promise<GatewayClient> {
    const socket = new WebSocket(target.endpoint);
    let pendingSession: SecureSession | undefined;
    try {
      await socketOpened(socket);
      if (target.transport === "relay") {
        if (!host.routeId) throw new Error("Relay route is missing");
        const readyMessage = nextTextMessage(socket, "Relay route timed out");
        socket.send(
          JSON.stringify({
            type: RELAY_MESSAGE_TYPES.connect,
            version: RELAY_PROTOCOL_VERSION,
            routeId: host.routeId,
          }),
        );
        parseRelayWireMessage(await readyMessage, RELAY_MESSAGE_TYPES.ready);
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
      const reply = parseGatewayHandshakeReply(await replyMessage);
      const completed = handshake.finish(base64UrlToBytes(reply.message));
      pendingSession = completed.session;
      const accepted = parseGatewayHandshakeResult(
        decoder.decode(completed.payload),
      );
      if (!accepted.ok) throw new GatewayReauthenticationRequired();
      const expectedPrincipal = host.kind === "admin" ? "host-admin" : "user";
      if (accepted.principal !== expectedPrincipal) {
        throw new Error("Host returned the wrong identity domain");
      }
      const connectedHost = accepted.loginName?.trim()
        ? {
            ...host,
            name:
              host.name === host.nodeId ? accepted.loginName.trim() : host.name,
            loginName: accepted.loginName.trim(),
          }
        : host;
      const client = new GatewayClient(
        connectedHost,
        socket,
        completed.session,
        target.transport,
        accepted.capabilities,
      );
      pendingSession = undefined;
      return client;
    } catch (error) {
      pendingSession?.dispose();
      socket.close();
      throw error;
    }
  }

  supportsCapability(
    capability: (typeof GATEWAY_CAPABILITIES)[keyof typeof GATEWAY_CAPABILITIES],
  ): boolean {
    return this.capabilities.has(capability);
  }

  async #authenticate(
    newlyPaired: boolean,
    discoverable: boolean,
    canInteract: () => boolean = () => true,
    onInteractionStarted: () => void = () => undefined,
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
        resumeToken?: string;
      }>("auth/register/verify", { response });
      this.#rememberResumeToken(result);
      return result.recoveryCodes;
    }
    const options = await this.request<PublicKeyCredentialRequestOptionsJSON>(
      "auth/login/options",
      { discoverable },
    );
    if (!canInteract()) throw new GatewayReauthenticationRequired();
    onInteractionStarted();
    const response = await startAuthentication({ optionsJSON: options });
    if (
      discoverable &&
      response.response.userHandle !== this.host.hostPublicKey
    ) {
      throw new Error("这个 Passkey 不属于目标 Codex 宿主机，请选择正确的账户");
    }
    const result = await this.request<{
      authenticated: true;
      resumeToken?: string;
    }>("auth/login/verify", { response });
    this.#rememberResumeToken(result);
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
    const result = await this.request<{
      authenticated: true;
      resumeToken?: string;
    }>("auth/password/login/finish", {
      finishLoginRequest: finished.finishLoginRequest,
    });
    this.#rememberResumeToken(result);
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
    options: GatewayRequestOptions = {},
  ): Promise<T> {
    if (!this.#usable || this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Host connection is unavailable"));
    }
    const requestId = crypto.randomUUID();
    const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
    const frames = this.#session.encryptMessage(
      encoder.encode(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          requestId,
          idempotencyKey,
          method,
          payload,
        }),
      ),
    );
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        const cause = new Error(`Host request timed out: ${method}`);
        const error = new GatewayRequestOutcomeUnknownError(
          method,
          idempotencyKey,
          cause,
        );
        reject(error);
        // The request outcome is unknown, but a slow Host method is not proof
        // that the encrypted transport died. Keep unrelated in-flight work and
        // the socket alive; callers reconcile mutations with the same key.
      }, options.timeoutMs ?? 30_000);
      this.#pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        method,
        idempotencyKey,
      });
      let sentFrames = 0;
      try {
        for (const frame of frames) {
          this.#socket.send(encodeFrame(frame));
          sentFrames += 1;
        }
      } catch {
        this.#pending.delete(requestId);
        clearTimeout(timeout);
        const cause = new Error(
          `Host connection failed while sending: ${method}`,
        );
        const error =
          sentFrames > 0
            ? new GatewayRequestOutcomeUnknownError(
                method,
                idempotencyKey,
                cause,
                { transportLost: true },
              )
            : cause;
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

  get canReconnectSilently(): boolean {
    return this.#resumeToken !== undefined;
  }

  async reconnect(
    options: {
      allowInteractive?: boolean;
      canInteract?: () => boolean;
    } = {},
  ): Promise<GatewayClient> {
    const canInteract =
      options.canInteract ?? (() => options.allowInteractive ?? true);
    const resumeToken = this.#resumeToken;
    if (resumeToken) {
      try {
        const client = await GatewayClient.#openPreferred(this.host, {
          mode: "resume",
          resumeToken,
        });
        client.#resumeToken = resumeToken;
        client.#reconnectMode = this.#reconnectMode;
        return client;
      } catch (error) {
        if (!isGatewayReauthenticationRequired(error)) throw error;
        this.#resumeToken = undefined;
        this.#reauthenticationRequired = true;
      }
    }
    if (this.#reauthenticationRequired) {
      if (!canInteract()) throw new GatewayReauthenticationRequired();
      if (this.#reconnectMode === "temporary-password") {
        throw new TemporaryPasswordReauthenticationRequired();
      }
      return this.#runInteractiveRecovery((onInteractionStarted) =>
        this.reauthenticateWithPasskey(
          this.#reconnectMode === "trusted-device",
          canInteract,
          onInteractionStarted,
        ),
      );
    }
    if (!canInteract()) throw new GatewayReauthenticationRequired();
    if (this.#reconnectMode === "temporary-password") {
      throw new TemporaryPasswordReauthenticationRequired();
    }
    if (this.#reconnectMode === "temporary-passkey") {
      return this.#runInteractiveRecovery((onInteractionStarted) =>
        this.reauthenticateWithPasskey(
          false,
          canInteract,
          onInteractionStarted,
        ),
      );
    }
    return this.#runInteractiveRecovery((onInteractionStarted) =>
      GatewayClient.connect(this.host, {
        canInteract,
        onInteractionStarted,
      }),
    );
  }

  async #runInteractiveRecovery(
    operation: (onInteractionStarted: () => void) => Promise<GatewayClient>,
  ): Promise<GatewayClient> {
    let interactionStarted = false;
    try {
      return await operation(() => {
        interactionStarted = true;
      });
    } catch (error) {
      if (error instanceof GatewayReauthenticationRequired) throw error;
      if (!interactionStarted) throw error;
      // A visible recovery may open WebAuthn once. Treat every failure after
      // that point as interactive, not as a transport retry, so a network
      // error or cancellation cannot reopen the prompt in a loop.
      throw new GatewayInteractiveReauthenticationFailed(error);
    }
  }

  async reauthenticateWithPasskey(
    rememberDevice: boolean,
    canInteract: () => boolean = () => true,
    onInteractionStarted: () => void = () => undefined,
  ): Promise<GatewayClient> {
    const client = await GatewayClient.#openPreferred(this.host, {
      mode: "login",
      deviceName: this.host.deviceName,
      rememberDevice,
    });
    try {
      await client.#authenticate(
        false,
        false,
        canInteract,
        onInteractionStarted,
      );
    } catch (error) {
      client.close();
      throw error;
    }
    client.#reconnectMode = gatewayReconnectMode("passkey", rememberDevice);
    if (rememberDevice) await saveHost(client.host);
    return client;
  }

  async reauthenticateWithPassword(
    password: string,
    rememberDevice: boolean,
  ): Promise<GatewayClient> {
    const client = await GatewayClient.#openPreferred(this.host, {
      mode: "login",
      deviceName: this.host.deviceName,
      rememberDevice,
    });
    try {
      await client.#authenticatePassword(password);
    } catch (error) {
      client.close();
      throw error;
    }
    client.#reconnectMode = gatewayReconnectMode("password", rememberDevice);
    if (rememberDevice) await saveHost(client.host);
    return client;
  }

  #rememberResumeToken(value: { resumeToken?: unknown }): void {
    if (
      typeof value.resumeToken === "string" &&
      /^[A-Za-z0-9_-]{43}$/u.test(value.resumeToken)
    ) {
      this.#resumeToken = value.resumeToken;
    }
  }

  close(): void {
    this.#invalidate(new Error("Host connection closed"));
  }

  #invalidate(error: Error, closeSocket = true): void {
    if (!this.#usable) return;
    this.#usable = false;
    this.#session.dispose();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new GatewayRequestOutcomeUnknownError(
          pending.method,
          pending.idempotencyKey,
          error,
          { transportLost: true },
        ),
      );
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
    if (typeof event.data !== "string") {
      this.#invalidate(new Error("Host sent an invalid binary protocol frame"));
      return;
    }
    try {
      const wire = parseGatewayCipherFrame(event.data);
      const plaintext = this.#session.decryptMessage({
        sessionId: wire.sessionId,
        sequence: wire.sequence,
        ciphertext: base64UrlToBytes(wire.ciphertext),
      });
      if (!plaintext) return;
      const envelope = parseGatewayServerEnvelope(decoder.decode(plaintext));
      if ("requestId" in envelope) {
        const pending = this.#pending.get(envelope.requestId);
        if (!pending) return;
        this.#pending.delete(envelope.requestId);
        clearTimeout(pending.timeout);
        if (envelope.ok) pending.resolve(envelope.result);
        else if (envelope.error) {
          pending.reject(new GatewayResponseError(envelope.error));
        } else {
          // parseGatewayServerEnvelope rejects this shape before it reaches
          // here; keep the branch exhaustive for protocol evolution.
          pending.reject(new Error("Host request failed"));
        }
      } else {
        for (const listener of this.#eventListeners) listener(envelope);
      }
    } catch (error) {
      this.#invalidate(
        new Error("Host sent an invalid encrypted protocol message", {
          cause: error,
        }),
      );
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
  options: { stopOn?(error: unknown): boolean } = {},
): Promise<T> {
  let lastError: unknown;
  for (const target of targets) {
    try {
      return await open(target);
    } catch (error) {
      if (options.stopOn?.(error)) throw error;
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
              : event.reason === "REAUTH_REQUIRED"
                ? "REAUTH_REQUIRED"
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

function isGatewayReauthenticationRequired(error: unknown): boolean {
  return (
    error instanceof GatewayReauthenticationRequired ||
    (error instanceof Error && error.message === "REAUTH_REQUIRED")
  );
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
