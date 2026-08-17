import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";
import { GatewayV2Error, jsonValueSchema } from "@codex-everywhere/protocol/v2";
import { ready, server as opaqueServer } from "@serenity-kit/opaque";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import type { IdentityRepository } from "../repositories/identity-repository.js";
import type {
  GatewayDeviceBinding,
  IdentityGatewayContext,
} from "../gateway/identity-gateway-context.js";
import type { IdentityHandlerMap } from "../gateway/handler-types.js";
import { AuthenticationRateLimiter } from "./authentication-rate-limiter.js";
import type { SessionTicketService } from "./session-ticket-service.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface IdentityServiceConfiguration {
  readonly origin: string;
  readonly rpId: string;
  readonly nodeId: string;
  readonly loginName: string;
  readonly opaqueServerSetup: string;
  readonly opaqueIdentifiers: {
    readonly client: string;
    readonly server: string;
  };
  readonly access?: "user" | "admin";
  readonly principal?: "user" | "host-admin";
  readonly principalId?: string;
}

export interface IdentityServiceOptions extends IdentityServiceConfiguration {
  readonly scope: Scope;
  readonly repository: IdentityRepository;
  readonly tickets: SessionTicketService;
  readonly rateLimiter?: AuthenticationRateLimiter;
}

type Challenge =
  | {
      readonly kind: "passkey-registration";
      readonly value: string;
      readonly sessionId: string;
      readonly requiresAuthentication: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "passkey-login";
      readonly value: string;
      readonly sessionId: string;
      readonly requiresAuthentication: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "password-registration";
      readonly sessionId: string;
      readonly requiresAuthentication: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "password-login";
      readonly sessionId: string;
      readonly serverLoginState: string;
      readonly expiresAt: number;
    };

export class IdentityService {
  readonly handlers: IdentityHandlerMap<IdentityGatewayContext>;
  readonly #scope: Scope;
  readonly #repository: IdentityRepository;
  readonly #origin: string;
  readonly #rpId: string;
  readonly #nodeId: string;
  readonly #loginName: string;
  readonly #opaqueServerSetup: string;
  readonly #opaqueIdentifiers: {
    readonly client: string;
    readonly server: string;
  };
  readonly #tickets: SessionTicketService;
  readonly #rateLimiter: AuthenticationRateLimiter;
  readonly #access: "user" | "admin";
  readonly #principal: "user" | "host-admin";
  readonly #principalId: string;
  readonly #challenges = new Map<string, Challenge>();

  constructor(options: IdentityServiceOptions) {
    this.#scope = options.scope.fork("identity");
    this.#repository = options.repository;
    this.#origin = options.origin;
    this.#rpId = options.rpId;
    this.#nodeId = options.nodeId;
    this.#loginName = options.loginName;
    this.#opaqueServerSetup = options.opaqueServerSetup;
    this.#opaqueIdentifiers = options.opaqueIdentifiers;
    this.#tickets = options.tickets;
    this.#rateLimiter = options.rateLimiter ?? new AuthenticationRateLimiter();
    this.#access = options.access ?? "user";
    this.#principal = options.principal ?? "user";
    this.#principalId = options.principalId ?? `user:${options.loginName}`;
    if (
      (this.#access === "user" && this.#principal !== "user") ||
      (this.#access === "admin" && this.#principal !== "host-admin")
    ) {
      throw new Error("Identity principal does not match its access domain");
    }
    this.#scope.defer(() => this.#challenges.clear());

    this.handlers = {
      "auth/status": (_input, context) => this.#status(context),
      "auth/register/options": (_input, context) =>
        this.#registrationOptions(context),
      "auth/register/verify": (input, context) =>
        this.#verifyRegistration(input, context),
      "auth/login/options": (_input, context) => this.#loginOptions(context),
      "auth/login/verify": (input, context) =>
        this.#verifyLogin(input, context),
      "auth/password/register/start": (input, context) =>
        this.#passwordRegistrationStart(input.registrationRequest, context),
      "auth/password/register/finish": (input, context) =>
        this.#passwordRegistrationFinish(input, context),
      "auth/password/login/start": (input, context) =>
        this.#passwordLoginStart(input.loginRequest, context),
      "auth/password/login/finish": (input, context) =>
        this.#passwordLoginFinish(input, context),
      "auth/recover": (input, context) => this.#recover(input, context),
      "auth/recovery/rotate": async (_input, context) => {
        this.#assertAuthenticated(context);
        return {
          version: 1,
          recoveryCodes: await this.#rotateRecoveryCodes(),
        };
      },
    };
  }

  async #status(context: IdentityGatewayContext) {
    const status = await this.#repository.status();
    return {
      version: 1 as const,
      initialized: status.passkeys > 0 || status.password,
      authenticated: context.access === this.#access,
      passkeyAvailable: status.passkeys > 0,
      passwordAvailable: status.password,
      temporary: context.access === this.#access && context.temporary,
    };
  }

  async #registrationOptions(context: IdentityGatewayContext) {
    const status = await this.#repository.status();
    const initialized = status.passkeys > 0 || status.password;
    if (initialized && context.access !== this.#access) {
      throw new GatewayV2Error(
        "AUTHENTICATION_REQUIRED",
        "Authenticate before adding another Passkey",
      );
    }
    const credentials = await this.#repository.passkeys();
    const options = await generateRegistrationOptions({
      rpName: "CodexEverywhere",
      rpID: this.#rpId,
      userName: this.#loginName,
      userDisplayName: this.#loginName,
      userID: createHash("sha256")
        .update(`ce-passkey-user-v2\0${this.#nodeId}`)
        .digest(),
      attestationType: "none",
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });
    const challengeId = this.#rememberChallenge({
      kind: "passkey-registration",
      value: options.challenge,
      sessionId: context.session.id,
      requiresAuthentication: initialized,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return {
      version: 1 as const,
      challengeId,
      options: jsonObject(options),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    };
  }

  async #verifyRegistration(
    input: Parameters<IdentityHandlerMap["auth/register/verify"]>[0],
    context: IdentityGatewayContext,
  ) {
    const challenge = this.#takeChallenge(
      input.challengeId,
      "passkey-registration",
      context,
    );
    const verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.value,
      expectedOrigin: this.#origin,
      expectedRPID: this.#rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) throw authenticationFailed();
    const credential = verification.registrationInfo.credential;
    const status = await this.#repository.status();
    const initial = status.passkeys === 0 && !status.password;
    const recoveryCodes = initial ? createRecoveryCodes() : [];
    await this.#repository.addPasskey({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      requireUninitialized: !challenge.requiresAuthentication,
      recoveryHashes: recoveryCodes.map(hashRecoveryCode),
    });
    await this.#rememberDeviceIfRequested(
      context,
      input.deviceName,
      input.rememberDevice,
    );
    return this.#authenticatedResult(
      context,
      input.rememberDevice,
      recoveryCodes,
    );
  }

  async #loginOptions(context: IdentityGatewayContext) {
    const credentials = await this.#repository.passkeys();
    if (credentials.length === 0) {
      throw new GatewayV2Error(
        "PASSKEY_UNAVAILABLE",
        "No Passkey is registered",
      );
    }
    const options = await generateAuthenticationOptions({
      rpID: this.#rpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.id,
      })),
      userVerification: "required",
    });
    const challengeId = this.#rememberChallenge({
      kind: "passkey-login",
      value: options.challenge,
      sessionId: context.session.id,
      requiresAuthentication: false,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return {
      version: 1 as const,
      challengeId,
      options: jsonObject(options),
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    };
  }

  async #verifyLogin(
    input: Parameters<IdentityHandlerMap["auth/login/verify"]>[0],
    context: IdentityGatewayContext,
  ) {
    const challenge = this.#takeChallenge(
      input.challengeId,
      "passkey-login",
      context,
    );
    const response = input.response as unknown as AuthenticationResponseJSON;
    const credential = (await this.#repository.passkeys()).find(
      (candidate) => candidate.id === response.id,
    );
    if (credential === undefined) throw authenticationFailed();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.value,
      expectedOrigin: this.#origin,
      expectedRPID: this.#rpId,
      credential: {
        id: credential.id,
        publicKey: Uint8Array.from(credential.publicKey),
        counter: credential.counter,
      },
      requireUserVerification: true,
    });
    if (!verification.verified) throw authenticationFailed();
    await this.#repository.updatePasskeyCounter(
      credential.id,
      verification.authenticationInfo.newCounter,
    );
    await this.#rememberDeviceIfRequested(
      context,
      input.deviceName,
      input.rememberDevice,
    );
    return this.#authenticatedResult(context, input.rememberDevice);
  }

  async #passwordRegistrationStart(
    registrationRequest: string,
    context: IdentityGatewayContext,
  ) {
    const status = await this.#repository.status();
    const initialized = status.passkeys > 0 || status.password;
    if (initialized && context.access !== this.#access) {
      throw new GatewayV2Error(
        "AUTHENTICATION_REQUIRED",
        "Authenticate before changing the CE password",
      );
    }
    await ready;
    const message = opaqueServer.createRegistrationResponse({
      serverSetup: this.#opaqueServerSetup,
      userIdentifier: this.#loginName,
      registrationRequest,
    }).registrationResponse;
    const challengeId = this.#rememberChallenge({
      kind: "password-registration",
      sessionId: context.session.id,
      requiresAuthentication: initialized,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return {
      version: 1 as const,
      challengeId,
      message,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    };
  }

  async #passwordRegistrationFinish(
    input: Parameters<IdentityHandlerMap["auth/password/register/finish"]>[0],
    context: IdentityGatewayContext,
  ) {
    const challenge = this.#takeChallenge(
      input.challengeId,
      "password-registration",
      context,
    );
    await this.#repository.savePassword({
      registrationRecord: input.registrationRecord,
      requireUninitialized: !challenge.requiresAuthentication,
    });
    const status = await this.#repository.status();
    const recoveryCodes =
      status.unusedRecoveryCodes === 0 ? await this.#rotateRecoveryCodes() : [];
    await this.#rememberDeviceIfRequested(
      context,
      input.deviceName,
      input.rememberDevice,
    );
    return this.#authenticatedResult(
      context,
      input.rememberDevice,
      recoveryCodes,
    );
  }

  async #passwordLoginStart(
    loginRequest: string,
    context: IdentityGatewayContext,
  ) {
    this.#rateLimiter.consume("password");
    await ready;
    const registrationRecord = await this.#repository.passwordRecord();
    if (registrationRecord === undefined) {
      throw new GatewayV2Error(
        "PASSWORD_UNAVAILABLE",
        "No CE password is registered",
      );
    }
    const result = opaqueServer.startLogin({
      serverSetup: this.#opaqueServerSetup,
      userIdentifier: this.#loginName,
      registrationRecord,
      startLoginRequest: loginRequest,
      identifiers: this.#opaqueIdentifiers,
    });
    const challengeId = this.#rememberChallenge({
      kind: "password-login",
      sessionId: context.session.id,
      serverLoginState: result.serverLoginState,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return {
      version: 1 as const,
      challengeId,
      message: result.loginResponse,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    };
  }

  async #passwordLoginFinish(
    input: Parameters<IdentityHandlerMap["auth/password/login/finish"]>[0],
    context: IdentityGatewayContext,
  ) {
    const challenge = this.#takeChallenge(
      input.challengeId,
      "password-login",
      context,
    );
    await ready;
    opaqueServer.finishLogin({
      serverLoginState: challenge.serverLoginState,
      finishLoginRequest: input.loginFinish,
      identifiers: this.#opaqueIdentifiers,
    });
    await this.#rememberDeviceIfRequested(
      context,
      input.deviceName,
      input.rememberDevice,
    );
    return this.#authenticatedResult(context, input.rememberDevice);
  }

  async #recover(
    input: Parameters<IdentityHandlerMap["auth/recover"]>[0],
    context: IdentityGatewayContext,
  ) {
    this.#rateLimiter.consume("recovery");
    const normalized = normalizeRecoveryCode(input.recoveryCode);
    const hash = (await this.#repository.recoveryHashes()).find((candidate) =>
      verifyRecoveryCode(normalized, candidate),
    );
    if (hash === undefined) throw authenticationFailed();
    const recoveryCodes = createRecoveryCodes();
    await this.#repository.consumeRecoveryAndReplace(
      hash,
      recoveryCodes.map(hashRecoveryCode),
    );
    await this.#rememberDeviceIfRequested(
      context,
      input.deviceName,
      input.rememberDevice,
    );
    return this.#authenticatedResult(
      context,
      input.rememberDevice,
      recoveryCodes,
    );
  }

  async #rotateRecoveryCodes(): Promise<string[]> {
    const codes = createRecoveryCodes();
    await this.#repository.replaceRecoveryCodes(codes.map(hashRecoveryCode));
    return codes;
  }

  async #rememberDeviceIfRequested(
    context: IdentityGatewayContext,
    name: string,
    remember: boolean,
  ): Promise<void> {
    if (!remember) return;
    const binding = requiredDevice(context.session.device);
    await this.#repository.rememberDevice({ ...binding, name });
  }

  #authenticatedResult(
    context: IdentityGatewayContext,
    rememberedDevice: boolean,
    recoveryCodes: readonly string[] = [],
  ) {
    context.session.authenticate({
      access: this.#access,
      principalId: this.#principalId,
      temporary: !rememberedDevice,
    });
    const device = requiredDevice(context.session.device);
    return {
      version: 1 as const,
      authenticated: true as const,
      principal: this.#principal,
      loginName: this.#loginName,
      resumeToken: this.#tickets.issue({
        deviceId: device.id,
        devicePublicKey: device.publicKey,
        principalId: this.#principalId,
        temporary: !rememberedDevice,
      }),
      rememberedDevice,
      ...(recoveryCodes.length === 0
        ? {}
        : { recoveryCodes: [...recoveryCodes] }),
    };
  }

  #rememberChallenge(challenge: Challenge): string {
    const id = randomUUID();
    this.#challenges.set(id, challenge);
    this.#scope.setTimeout(() => this.#challenges.delete(id), CHALLENGE_TTL_MS);
    return id;
  }

  #takeChallenge<Kind extends Challenge["kind"]>(
    id: string,
    kind: Kind,
    context: IdentityGatewayContext,
  ): Extract<Challenge, { kind: Kind }> {
    const challenge = this.#challenges.get(id);
    this.#challenges.delete(id);
    if (
      challenge === undefined ||
      challenge.kind !== kind ||
      challenge.sessionId !== context.session.id ||
      challenge.expiresAt <= Date.now() ||
      ("requiresAuthentication" in challenge &&
        challenge.requiresAuthentication &&
        context.access !== this.#access)
    ) {
      throw authenticationFailed();
    }
    return challenge as Extract<Challenge, { kind: Kind }>;
  }

  #assertAuthenticated(context: IdentityGatewayContext): void {
    if (context.access !== this.#access) {
      throw new GatewayV2Error(
        "AUTHENTICATION_REQUIRED",
        "Authenticate before rotating recovery codes",
      );
    }
  }
}

function jsonObject(
  value: unknown,
): Record<string, ReturnType<typeof jsonValueSchema.parse>> {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  const parsed = jsonValueSchema.parse(normalized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Authentication options are invalid");
  }
  return parsed as Record<string, ReturnType<typeof jsonValueSchema.parse>>;
}

function requiredDevice(
  binding: GatewayDeviceBinding | undefined,
): GatewayDeviceBinding {
  if (binding === undefined) {
    throw new GatewayV2Error(
      "DEVICE_BINDING_REQUIRED",
      "This transport has no device key that can be remembered",
    );
  }
  return binding;
}

function authenticationFailed(): GatewayV2Error {
  return new GatewayV2Error(
    "AUTHENTICATION_FAILED",
    "Authentication could not be verified",
  );
}

export function createRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const raw = randomBytes(10).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`;
  });
}

export function hashRecoveryCode(code: string): Uint8Array {
  const salt = randomBytes(16);
  return Buffer.concat([
    salt,
    scryptSync(normalizeRecoveryCode(code), salt, 32),
  ]);
}

function verifyRecoveryCode(code: string, stored: Uint8Array): boolean {
  if (stored.byteLength !== 48) return false;
  const salt = stored.slice(0, 16);
  const expected = stored.slice(16);
  return timingSafeEqual(scryptSync(code, salt, 32), expected);
}

function normalizeRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (normalized.length < 8 || normalized.length > 256) {
    throw authenticationFailed();
  }
  return normalized;
}
