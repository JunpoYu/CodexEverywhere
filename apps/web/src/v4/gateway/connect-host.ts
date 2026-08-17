import {
  bytesToBase64Url,
  generateStaticKeyPair,
} from "@codex-everywhere/crypto";
import { Scope } from "@codex-everywhere/kernel";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  MutationOutcomeUnknownError,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";

import { saveHost, type SavedHost } from "../../storage.js";
import { EncryptedGatewayV2Transport } from "./encrypted-transport.js";
import {
  ReconnectingGatewayPort,
  TypedGatewayPort,
  mutationOptions,
  queryOptions,
  type GatewayPort,
} from "./gateway-port.js";

export interface PairingDocumentV1 {
  readonly version: 1;
  readonly principal?: "user" | "host-admin";
  readonly transport: "direct" | "relay";
  readonly endpoint: string;
  readonly directEndpoint?: string;
  readonly relayEndpoint?: string;
  readonly routeId?: string;
  readonly nodeId: string;
  readonly userId: string;
  readonly loginName?: string;
  readonly hostPublicKey: string;
  readonly hostFingerprint: string;
  readonly pairingId: string;
  readonly secret: string;
  readonly expiresAt: string;
}

export async function connectSavedHost(host: SavedHost): Promise<GatewayPort> {
  return reconnectingPort(
    host,
    new TypedGatewayPort(
      await EncryptedGatewayV2Transport.open(host, { mode: "connect" }),
    ),
    { mode: "connect" },
  );
}

export type HostLoginMethod = "passkey" | "password" | "recovery";

export interface HostLoginOptions {
  readonly method: HostLoginMethod;
  readonly deviceName: string;
  readonly rememberDevice: boolean;
  readonly password?: string;
  readonly recoveryCode?: string;
}

export async function loginHost(
  host: SavedHost,
  options: HostLoginOptions,
): Promise<{
  readonly gateway: GatewayPort;
  readonly host: SavedHost;
  readonly temporary: boolean;
  readonly recoveryCodes: readonly string[];
}> {
  let sessionGateway: GatewayPort = new TypedGatewayPort(
    await EncryptedGatewayV2Transport.open(host, {
      mode: "login",
      deviceName: options.deviceName,
      rememberDevice: options.rememberDevice,
    }),
  );
  try {
    const authenticated = await authenticate(sessionGateway, host, options);
    sessionGateway = authenticated.gateway;
    const result = authenticated.result;
    if (authenticated.replayed) {
      const rebound = await authenticatedGateway(host, options, result);
      await sessionGateway.close();
      sessionGateway = rebound;
    }
    if (options.rememberDevice) await saveHost(host);
    const reconnectAuthentication = options.rememberDevice
      ? ({ mode: "connect" } as const)
      : result.resumeToken === undefined
        ? undefined
        : ({ mode: "resume", resumeToken: result.resumeToken } as const);
    const gateway =
      reconnectAuthentication === undefined
        ? sessionGateway
        : reconnectingPort(host, sessionGateway, reconnectAuthentication);
    return {
      gateway,
      host,
      temporary: !options.rememberDevice,
      recoveryCodes: result.recoveryCodes ?? [],
    };
  } catch (error) {
    await sessionGateway.close();
    throw error;
  }
}

export async function pairHost(
  rawDocument: string,
  deviceName: string,
): Promise<{
  readonly host: SavedHost;
  readonly gateway: GatewayPort;
  readonly recoveryCodes: readonly string[];
}> {
  const document = parsePairingDocument(rawDocument);
  const keys = generateStaticKeyPair();
  const host: SavedHost = {
    id: document.nodeId,
    kind: document.principal === "host-admin" ? "admin" : "user",
    name: document.loginName ?? document.nodeId,
    ...(document.loginName === undefined
      ? {}
      : { loginName: document.loginName }),
    endpoint: document.endpoint,
    transport: document.transport,
    ...(document.directEndpoint === undefined
      ? {}
      : { directEndpoint: document.directEndpoint }),
    ...(document.relayEndpoint === undefined
      ? {}
      : { relayEndpoint: document.relayEndpoint }),
    ...(document.routeId === undefined ? {} : { routeId: document.routeId }),
    nodeId: document.nodeId,
    userId: document.userId,
    hostPublicKey: document.hostPublicKey,
    hostFingerprint: document.hostFingerprint,
    deviceId: crypto.randomUUID(),
    deviceName,
    devicePublicKey: bytesToBase64Url(keys.publicKey),
    deviceSecretKey: bytesToBase64Url(keys.secretKey),
  };
  const transport = await EncryptedGatewayV2Transport.open(host, {
    mode: "pair",
    pairingId: document.pairingId,
    secret: document.secret,
    deviceName,
  });
  let sessionGateway: GatewayPort = new TypedGatewayPort(transport);
  try {
    // The pairing grant has already been consumed and this device is now
    // trusted. Persist its key before WebAuthn so a cancelled prompt or a
    // dropped secret response never strands the one-time pairing.
    await saveHost(host);
    sessionGateway = reconnectingPort(host, sessionGateway, {
      mode: "connect",
    });
    const status = await sessionGateway.request(
      "auth/status",
      { version: 1 },
      queryOptions(),
    );
    let recoveryCodes: readonly string[] = [];
    if (!status.initialized) {
      const challenge = await sessionGateway.request(
        "auth/register/options",
        { version: 1, deviceName },
        mutationOptions(),
      );
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({
        optionsJSON:
          challenge.options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      const verified = await replayableEphemeralMutation(
        sessionGateway,
        "auth/register/verify",
        {
          version: 1,
          challengeId: challenge.challengeId,
          deviceName,
          response: response as unknown as Record<string, never>,
          rememberDevice: true,
        },
      );
      recoveryCodes = verified.recoveryCodes ?? [];
    }
    return { host, gateway: sessionGateway, recoveryCodes };
  } catch (error) {
    await sessionGateway.close();
    throw error;
  }
}

export function createLoginHost(
  profile: Omit<PairingDocumentV1, "pairingId" | "secret" | "expiresAt">,
  input: { readonly loginName: string; readonly deviceName: string },
): SavedHost {
  const keys = generateStaticKeyPair();
  return {
    id: profile.nodeId,
    kind: profile.principal === "host-admin" ? "admin" : "user",
    name: input.loginName,
    loginName: input.loginName,
    endpoint: profile.endpoint,
    transport: profile.transport,
    ...(profile.directEndpoint === undefined
      ? {}
      : { directEndpoint: profile.directEndpoint }),
    ...(profile.relayEndpoint === undefined
      ? {}
      : { relayEndpoint: profile.relayEndpoint }),
    ...(profile.routeId === undefined ? {} : { routeId: profile.routeId }),
    nodeId: profile.nodeId,
    userId: profile.userId,
    hostPublicKey: profile.hostPublicKey,
    hostFingerprint: profile.hostFingerprint,
    deviceId: crypto.randomUUID(),
    deviceName: input.deviceName,
    devicePublicKey: bytesToBase64Url(keys.publicKey),
    deviceSecretKey: bytesToBase64Url(keys.secretKey),
  };
}

export async function registerPassword(
  gateway: GatewayPort,
  host: SavedHost,
  password: string,
  rememberDevice: boolean,
): Promise<readonly string[]> {
  assertPassword(password);
  const opaque = await import("@serenity-kit/opaque");
  await opaque.ready;
  const started = opaque.client.startRegistration({ password });
  const challenge = await gateway.request(
    "auth/password/register/start",
    { version: 1, registrationRequest: started.registrationRequest },
    mutationOptions(),
  );
  const finished = opaque.client.finishRegistration({
    password,
    clientRegistrationState: started.clientRegistrationState,
    registrationResponse: challenge.message,
    identifiers: opaqueIdentifiers(host),
  });
  const result = await replayableEphemeralMutation(
    gateway,
    "auth/password/register/finish",
    {
      version: 1,
      challengeId: challenge.challengeId,
      registrationRecord: finished.registrationRecord,
      deviceName: host.deviceName,
      rememberDevice,
    },
  );
  return result.recoveryCodes ?? [];
}

export async function registerPasskey(
  gateway: GatewayPort,
  deviceName: string,
  rememberDevice: boolean,
): Promise<readonly string[]> {
  const challenge = await gateway.request(
    "auth/register/options",
    { version: 1, deviceName },
    mutationOptions(),
  );
  const { startRegistration } = await import("@simplewebauthn/browser");
  const response = await startRegistration({
    optionsJSON:
      challenge.options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  const result = await replayableEphemeralMutation(
    gateway,
    "auth/register/verify",
    {
      version: 1,
      challengeId: challenge.challengeId,
      deviceName,
      response: response as unknown as Record<string, never>,
      rememberDevice,
    },
  );
  return result.recoveryCodes ?? [];
}

export async function rotateRecoveryCodes(
  gateway: GatewayPort,
): Promise<readonly string[]> {
  return (
    await replayableEphemeralMutation(gateway, "auth/recovery/rotate", {
      version: 1,
    })
  ).recoveryCodes;
}

async function authenticate(
  gateway: GatewayPort,
  host: SavedHost,
  options: HostLoginOptions,
): Promise<{
  readonly gateway: GatewayPort;
  readonly result: OutputOf<"auth/login/verify">;
  readonly replayed: boolean;
}> {
  const status = await gateway.request(
    "auth/status",
    { version: 1 },
    queryOptions(),
  );
  if (!status.initialized) {
    throw new Error("该宿主机尚未初始化 Web 身份，请先执行首次配对");
  }
  let completion: AuthenticationCompletion;
  if (options.method === "passkey") {
    const challenge = await gateway.request(
      "auth/login/options",
      { version: 1, deviceName: options.deviceName },
      mutationOptions(),
    );
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const response = await startAuthentication({
      optionsJSON:
        challenge.options as unknown as PublicKeyCredentialRequestOptionsJSON,
    });
    completion = await finishAuthentication(
      gateway,
      host,
      options,
      "auth/login/verify",
      {
        version: 1,
        challengeId: challenge.challengeId,
        response: response as unknown as Record<string, never>,
        deviceName: options.deviceName,
        rememberDevice: options.rememberDevice,
      },
    );
  } else if (options.method === "password") {
    const password = options.password ?? "";
    if (password.length === 0) throw new Error("请输入 CodexEverywhere 密码");
    const opaque = await import("@serenity-kit/opaque");
    await opaque.ready;
    const started = opaque.client.startLogin({ password });
    const challenge = await gateway.request(
      "auth/password/login/start",
      { version: 1, loginRequest: started.startLoginRequest },
      mutationOptions(),
    );
    const finished = opaque.client.finishLogin({
      password,
      clientLoginState: started.clientLoginState,
      loginResponse: challenge.message,
      identifiers: opaqueIdentifiers(host),
    });
    if (finished === undefined) {
      throw new Error("CodexEverywhere 密码不正确");
    }
    completion = await finishAuthentication(
      gateway,
      host,
      options,
      "auth/password/login/finish",
      {
        version: 1,
        challengeId: challenge.challengeId,
        loginFinish: finished.finishLoginRequest,
        deviceName: options.deviceName,
        rememberDevice: options.rememberDevice,
      },
    );
  } else {
    const recoveryCode = options.recoveryCode?.trim() ?? "";
    if (recoveryCode.length === 0) throw new Error("请输入恢复码");
    completion = await finishAuthentication(
      gateway,
      host,
      options,
      "auth/recover",
      {
        version: 1,
        recoveryCode,
        deviceName: options.deviceName,
        rememberDevice: options.rememberDevice,
      },
    );
  }
  return {
    gateway: completion.gateway,
    result: completion.result,
    replayed: completion.replayed,
  };
}

type AuthenticationFinalMethod =
  "auth/login/verify" | "auth/password/login/finish" | "auth/recover";

interface AuthenticationCompletion {
  readonly gateway: GatewayPort;
  readonly result: OutputOf<"auth/login/verify">;
  readonly replayed: boolean;
}

async function finishAuthentication<Method extends AuthenticationFinalMethod>(
  gateway: GatewayPort,
  host: SavedHost,
  options: HostLoginOptions,
  method: Method,
  input: InputOf<Method>,
): Promise<AuthenticationCompletion> {
  const operationKey = crypto.randomUUID();
  try {
    return {
      gateway,
      result: await gateway.request(
        method,
        input,
        mutationOptions(operationKey) as RequestOptionsOf<Method>,
      ),
      replayed: false,
    };
  } catch (error) {
    if (!(error instanceof MutationOutcomeUnknownError)) throw error;
  }

  await gateway.close();
  const replacement = new TypedGatewayPort(
    await EncryptedGatewayV2Transport.open(host, loginAuthentication(options)),
  );
  try {
    return {
      gateway: replacement,
      result: await replacement.request(
        method,
        input,
        mutationOptions(operationKey) as RequestOptionsOf<Method>,
      ),
      replayed: true,
    };
  } catch (error) {
    await replacement.close();
    throw error;
  }
}

async function authenticatedGateway(
  host: SavedHost,
  options: HostLoginOptions,
  result: OutputOf<"auth/login/verify">,
): Promise<GatewayPort> {
  const authentication = options.rememberDevice
    ? ({ mode: "connect" } as const)
    : result.resumeToken === undefined
      ? undefined
      : ({ mode: "resume", resumeToken: result.resumeToken } as const);
  if (authentication === undefined) {
    throw new Error("宿主机没有返回可恢复的临时会话票据");
  }
  return new TypedGatewayPort(
    await EncryptedGatewayV2Transport.open(host, authentication),
  );
}

function loginAuthentication(options: HostLoginOptions) {
  return {
    mode: "login" as const,
    deviceName: options.deviceName,
    rememberDevice: options.rememberDevice,
  };
}

type ReplayableEphemeralMethod =
  | "auth/register/verify"
  | "auth/password/register/finish"
  | "auth/recovery/rotate";

/**
 * Replays a secret-bearing ephemeral mutation with one in-memory operation
 * key. The Agent cache spans physical sessions but never writes the result to
 * SQLite; after its bounded window, failure is explicit rather than guessed.
 */
async function replayableEphemeralMutation<
  Method extends ReplayableEphemeralMethod,
>(
  gateway: GatewayPort,
  method: Method,
  input: InputOf<Method>,
): Promise<OutputOf<Method>> {
  const operationKey = crypto.randomUUID();
  const scope = new Scope(`secret-mutation-${method}`);
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        return await gateway.request(
          method,
          input,
          mutationOptions(
            operationKey,
            scope.signal,
          ) as RequestOptionsOf<Method>,
        );
      } catch (error) {
        if (!(error instanceof MutationOutcomeUnknownError)) throw error;
        if (attempt === 119) {
          throw new Error(
            "一次性凭据响应在重连后仍无法确认；请保持当前页面并重新执行身份操作",
            { cause: error },
          );
        }
        await scopedDelay(scope, 250);
      }
    }
    throw new Error("一次性身份操作未能完成");
  } finally {
    await scope.close("secret-mutation-finished");
  }
}

function scopedDelay(scope: Scope, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(scope.signal.reason ?? new DOMException("Aborted", "AbortError"));
    scope.signal.addEventListener("abort", aborted, { once: true });
    const timer = scope.setTimeout(() => {
      scope.signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    if (scope.signal.aborted) {
      clearTimeout(timer);
      aborted();
    }
  });
}

function reconnectingPort(
  host: SavedHost,
  initial: GatewayPort,
  authentication:
    | { readonly mode: "connect" }
    | { readonly mode: "resume"; readonly resumeToken: string },
): GatewayPort {
  return new ReconnectingGatewayPort({
    initial,
    reconnect: async (signal) => {
      if (signal.aborted) throw signal.reason;
      return new TypedGatewayPort(
        await EncryptedGatewayV2Transport.open(host, authentication),
      );
    },
  });
}

function opaqueIdentifiers(host: SavedHost): {
  readonly client: string;
  readonly server: string;
} {
  return { client: host.userId, server: host.hostPublicKey };
}

function assertPassword(password: string): void {
  if (
    password.length < 9 ||
    !/[A-Za-z]/u.test(password) ||
    !/[0-9]/u.test(password)
  ) {
    throw new Error("密码至少 9 个字符，并需要同时包含字母和数字");
  }
}

export function parsePairingDocument(raw: string): PairingDocumentV1 {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("配对资料不是有效 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("配对资料格式无效");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.principal !== undefined &&
      record.principal !== "user" &&
      record.principal !== "host-admin") ||
    (record.transport !== "direct" && record.transport !== "relay") ||
    !requiredString(record.endpoint) ||
    !requiredString(record.nodeId) ||
    !requiredString(record.userId) ||
    !base64Key(record.hostPublicKey) ||
    !requiredString(record.hostFingerprint) ||
    !requiredString(record.pairingId) ||
    !requiredString(record.secret) ||
    !requiredString(record.expiresAt) ||
    Date.parse(record.expiresAt) <= Date.now()
  ) {
    throw new Error("配对资料无效或已经过期");
  }
  return record as unknown as PairingDocumentV1;
}

function requiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 16_384;
}

function base64Key(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}
