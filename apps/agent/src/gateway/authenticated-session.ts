import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type {
  EventEnvelope,
  RequestEnvelope,
} from "@codex-everywhere/protocol";

import { PasskeyRegistry } from "../host/passkeys.js";
import { PasswordRegistry, type OpaqueIdentifiers } from "../host/passwords.js";
import type { AuthenticationAttemptKind } from "../host/auth-security.js";
import type { GatewaySession } from "./direct-gateway.js";

export type AuthenticatedRequestResult =
  { handled: false } | { handled: true; value: unknown };

export class AuthenticatedGatewaySession implements GatewaySession {
  readonly #createInner: () => Promise<GatewaySession>;
  readonly #passkeys: PasskeyRegistry;
  readonly #passwords: PasswordRegistry | undefined;
  readonly #opaqueIdentifiers: OpaqueIdentifiers | undefined;
  readonly #newlyPaired: boolean;
  readonly #onAuthenticated: (() => Promise<void>) | undefined;
  readonly #consumeAuthAttempt:
    ((kind: AuthenticationAttemptKind) => void) | undefined;
  readonly #registerAuthenticatedSession:
    ((revoke: () => void) => () => void) | undefined;
  readonly #onCredentialsRecovered: (() => void) | undefined;
  readonly #handleAuthenticatedRequest:
    | ((
        request: RequestEnvelope,
        emitEvent: (event: EventEnvelope) => void,
      ) => Promise<AuthenticatedRequestResult>)
    | undefined;
  readonly #listeners = new Set<
    Parameters<NonNullable<GatewaySession["onEvent"]>>[0]
  >();
  #inner: GatewaySession | undefined;
  #unsubscribeInner: (() => void) | undefined;
  #innerPromise: Promise<GatewaySession> | undefined;
  #authenticated = false;
  #authenticationFinalized = false;
  #registrationChallenge: string | undefined;
  #registrationMode: "initial" | "recovery" | "add" | undefined;
  #authenticationChallenge: string | undefined;
  #recoveryAuthorized = false;
  #recoveryCode: string | undefined;
  #serverLoginState: string | undefined;
  #unregisterAuthenticatedSession: (() => void) | undefined;
  #revoked = false;

  constructor(options: {
    inner?: GatewaySession;
    createInner?: () => Promise<GatewaySession>;
    passkeys: PasskeyRegistry;
    passwords?: PasswordRegistry;
    opaqueIdentifiers?: OpaqueIdentifiers;
    newlyPaired: boolean;
    onAuthenticated?: () => Promise<void>;
    consumeAuthAttempt?: (kind: AuthenticationAttemptKind) => void;
    registerAuthenticatedSession?: (revoke: () => void) => () => void;
    onCredentialsRecovered?: () => void;
    handleAuthenticatedRequest?: (
      request: RequestEnvelope,
      emitEvent: (event: EventEnvelope) => void,
    ) => Promise<AuthenticatedRequestResult>;
  }) {
    if (!options.inner && !options.createInner)
      throw new Error(
        "Authenticated session requires an inner session factory",
      );
    this.#inner = options.inner;
    this.#createInner = options.createInner ?? (async () => options.inner!);
    this.#passkeys = options.passkeys;
    this.#passwords = options.passwords;
    this.#opaqueIdentifiers = options.opaqueIdentifiers;
    this.#newlyPaired = options.newlyPaired;
    this.#onAuthenticated = options.onAuthenticated;
    this.#consumeAuthAttempt = options.consumeAuthAttempt;
    this.#registerAuthenticatedSession = options.registerAuthenticatedSession;
    this.#onCredentialsRecovered = options.onCredentialsRecovered;
    this.#handleAuthenticatedRequest = options.handleAuthenticatedRequest;
  }

  onEvent(
    listener: Parameters<NonNullable<GatewaySession["onEvent"]>>[0],
  ): () => void {
    this.#listeners.add(listener);
    this.#subscribeInner();
    return () => this.#listeners.delete(listener);
  }

  async request(request: RequestEnvelope): Promise<unknown> {
    if (this.#revoked)
      throw new Error("This authenticated session was revoked; reconnect");
    const payload = asRecord(request.payload);
    switch (request.method) {
      case "auth/status": {
        const hasPasskey = (await this.#passkeys.count()) > 0;
        return {
          authenticated: this.#authenticated,
          registrationRequired: !hasPasskey && this.#newlyPaired,
          passwordEnabled: await this.#passwords?.hasPassword(),
        };
      }
      case "auth/register/options": {
        if (
          !this.#authenticated &&
          !this.#recoveryAuthorized &&
          (!this.#newlyPaired || (await this.#passkeys.count()) > 0)
        )
          throw new Error(
            "Passkey registration is not allowed in this session",
          );
        const options = await this.#passkeys.registrationOptions();
        this.#registrationChallenge = options.challenge;
        this.#registrationMode = this.#recoveryAuthorized
          ? "recovery"
          : this.#authenticated
            ? "add"
            : "initial";
        return options;
      }
      case "auth/register/verify": {
        if (!this.#registrationChallenge)
          throw new Error("Passkey registration challenge is missing");
        const challenge = this.#registrationChallenge;
        const mode = this.#registrationMode;
        this.#registrationChallenge = undefined;
        this.#registrationMode = undefined;
        if (!mode) throw new Error("Passkey registration mode is missing");
        const result = await this.#passkeys.verifyRegistration(
          payload.response as RegistrationResponseJSON,
          challenge,
          {
            replaceExisting: mode === "recovery",
            issueRecoveryCodes: mode !== "add",
            ...(mode === "recovery" && this.#recoveryCode
              ? { recoveryCode: this.#recoveryCode }
              : {}),
          },
        );
        if (mode === "recovery") this.#onCredentialsRecovered?.();
        this.#recoveryAuthorized = false;
        this.#recoveryCode = undefined;
        if (!this.#authenticated) await this.#finishAuthentication();
        return { authenticated: true, ...result };
      }
      case "auth/recover": {
        if (this.#authenticated)
          throw new Error("Recovery requires a new unauthenticated session");
        this.#consumeAuthAttempt?.("recovery");
        if (typeof payload.code !== "string")
          throw new Error("Recovery code is required");
        await this.#passkeys.verifyRecoveryCode(payload.code);
        this.#recoveryAuthorized = true;
        this.#recoveryCode = payload.code;
        return { registrationRequired: true };
      }
      case "auth/recovery/rotate": {
        if (!this.#authenticated)
          throw new Error("Authentication required to rotate recovery codes");
        return {
          recoveryCodes: await this.#passkeys.rotateRecoveryCodes(),
        };
      }
      case "auth/login/options": {
        const options = await this.#passkeys.authenticationOptions(
          payload.discoverable === true,
        );
        this.#authenticationChallenge = options.challenge;
        return options;
      }
      case "auth/login/verify": {
        if (!this.#authenticationChallenge)
          throw new Error("Passkey authentication challenge is missing");
        const challenge = this.#authenticationChallenge;
        this.#authenticationChallenge = undefined;
        await this.#passkeys.verifyAuthentication(
          payload.response as AuthenticationResponseJSON,
          challenge,
        );
        await this.#finishAuthentication();
        return { authenticated: true };
      }
      case "auth/password/register/start": {
        if (!this.#authenticated)
          throw new Error("Authentication required to set a password");
        if (typeof payload.registrationRequest !== "string")
          throw new Error("Password registration request is required");
        return {
          registrationResponse:
            await this.#requiredPasswords().createRegistrationResponse(
              payload.registrationRequest,
            ),
        };
      }
      case "auth/password/register/finish": {
        if (!this.#authenticated)
          throw new Error("Authentication required to set a password");
        if (typeof payload.registrationRecord !== "string")
          throw new Error("Password registration record is required");
        await this.#requiredPasswords().saveRegistrationRecord(
          payload.registrationRecord,
        );
        return { passwordEnabled: true };
      }
      case "auth/password/login/start": {
        this.#consumeAuthAttempt?.("password");
        if (typeof payload.startLoginRequest !== "string")
          throw new Error("Password login request is required");
        const started = await this.#requiredPasswords().startLogin(
          payload.startLoginRequest,
          this.#requiredOpaqueIdentifiers(),
        );
        this.#serverLoginState = started.serverLoginState;
        return { loginResponse: started.loginResponse };
      }
      case "auth/password/login/finish": {
        if (!this.#serverLoginState)
          throw new Error("Password login state is missing");
        if (typeof payload.finishLoginRequest !== "string")
          throw new Error("Password login finalization is required");
        const state = this.#serverLoginState;
        this.#serverLoginState = undefined;
        await this.#requiredPasswords().finishLogin(
          state,
          payload.finishLoginRequest,
          this.#requiredOpaqueIdentifiers(),
        );
        await this.#finishAuthentication();
        return { authenticated: true };
      }
      default:
        if (!this.#authenticated)
          throw new Error("Passkey authentication required");
        if (this.#handleAuthenticatedRequest) {
          const result = await this.#handleAuthenticatedRequest(
            request,
            (event) => this.#emit(event),
          );
          if (result.handled) return result.value;
        }
        return (await this.#ensureInner()).request(request);
    }
  }

  async close(): Promise<void> {
    this.#unregisterAuthenticatedSession?.();
    this.#unsubscribeInner?.();
    await this.#inner?.close?.();
  }

  async #finishAuthentication(): Promise<void> {
    if (this.#authenticationFinalized) return;
    await this.#onAuthenticated?.();
    this.#authenticated = true;
    this.#authenticationFinalized = true;
    this.#unregisterAuthenticatedSession = this.#registerAuthenticatedSession?.(
      () => this.#revoke(),
    );
    this.#subscribeInner();
  }

  #revoke(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#authenticated = false;
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    void this.#inner?.close?.();
  }

  #ensureInner(): Promise<GatewaySession> {
    if (this.#inner) return Promise.resolve(this.#inner);
    this.#innerPromise ??= this.#createInner().then((inner) => {
      this.#inner = inner;
      this.#subscribeInner();
      return inner;
    });
    return this.#innerPromise;
  }

  #subscribeInner(): void {
    if (!this.#authenticated || !this.#inner || this.#unsubscribeInner) return;
    this.#unsubscribeInner = this.#inner.onEvent?.((event) => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  #emit(event: EventEnvelope): void {
    if (!this.#authenticated || this.#revoked) return;
    for (const listener of this.#listeners) listener(event);
  }

  #requiredPasswords(): PasswordRegistry {
    if (!this.#passwords) throw new Error("Password login is not configured");
    return this.#passwords;
  }

  #requiredOpaqueIdentifiers(): OpaqueIdentifiers {
    if (!this.#opaqueIdentifiers)
      throw new Error("Password login identifiers are not configured");
    return this.#opaqueIdentifiers;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error("Request payload must be an object");
  return value as Record<string, unknown>;
}
