import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import {
  GATEWAY_CONTINUITY_ACK_METHOD,
  GATEWAY_CONTINUITY_ENABLE_METHOD,
  GATEWAY_CONTINUITY_OVERFLOW_EVENT,
  GATEWAY_SESSION_RELEASE_METHOD,
} from "@codex-everywhere/protocol";
import type {
  EventEnvelope,
  GatewayContinuityOverflowPayload,
  RequestEnvelope,
} from "@codex-everywhere/protocol";

import {
  PasskeyRegistry,
  type RecoveryAuthorization,
} from "../host/passkeys.js";
import { PasswordRegistry, type OpaqueIdentifiers } from "../host/passwords.js";
import type {
  AuthenticationAttemptKind,
  CredentialMutationRunner,
  CredentialMutationResult,
} from "../host/auth-security.js";
import type { GatewaySession } from "./direct-gateway.js";

export type AuthenticatedRequestResult =
  { handled: false } | { handled: true; value: unknown };

type PendingWebAuthnChallenge = {
  value: string;
  expiresAt: number;
  authGeneration?: number;
  recoveryAuthorization?: RecoveryAuthorization;
};

type PendingPasswordLogin = {
  value: string;
  expiresAt: number;
  authGeneration?: number;
};

type PendingRecoveryAuthorization = {
  value: RecoveryAuthorization;
  expiresAt: number;
};

type PendingAuthenticationState =
  "registration" | "authentication" | "recovery" | "password-login";

const AUTHENTICATION_STATE_TTL_MS = 5 * 60_000;
const AUTHENTICATED_SESSION_RECHECK_MS = 10_000;
const MAX_CONTINUITY_BUFFERED_EVENTS = 4_096;
const MAX_CONTINUITY_BUFFERED_EVENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_DISCONNECTED_SIDE_GRACE_MS = 24 * 60 * 60_000;

/**
 * Keeps one app-server client alive while a browser page moves between
 * physical Gateway transports. Resume tickets hold one reference and each
 * live transport holds another. Ordinary inner clients are released when the
 * last transport leaves; an inner with ephemeral state remains subscribed
 * until a resumed transport adopts it or every reference is gone.
 */
export class AuthenticatedGatewaySessionContinuity {
  readonly #createInner: () => Promise<GatewaySession>;
  readonly #listeners = new Set<(event: EventEnvelope) => void>();
  readonly #bufferedEvents: Array<{ event: EventEnvelope; bytes: number }> = [];
  #inner: GatewaySession | undefined;
  #innerPromise: Promise<GatewaySession> | undefined;
  #unsubscribeInner: (() => void) | undefined;
  #unsubscribeInnerClose: (() => void) | undefined;
  #sessionReferences = 0;
  #ticketReferences = 0;
  #bufferedEventBytes = 0;
  #overflowed = false;
  #acknowledgedDeliveryEnabled = false;
  #requiresDisconnectedExpiry = false;
  #activeHandleId = 0;
  #disconnectedExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  #expireDisconnectedTickets: (() => void) | undefined;
  #disconnectedGraceMs = DEFAULT_DISCONNECTED_SIDE_GRACE_MS;
  #disposed = false;

  constructor(
    createInner: () => Promise<GatewaySession>,
    initialInner?: GatewaySession,
  ) {
    this.#createInner = createInner;
    if (initialInner) {
      this.#inner = initialInner;
      this.#unsubscribeInnerClose = initialInner.onClose?.(() => {
        if (initialInner.shouldRetainAcrossReconnect?.() === true) {
          this.#requiresDisconnectedExpiry = true;
          this.#signalContinuityGap("inner-closed");
        }
        this.#discardInner(initialInner);
      });
    }
  }

  open(): GatewaySession {
    if (this.#disposed)
      throw new Error("Authenticated page session continuity was released");
    this.#sessionReferences += 1;
    this.#cancelDisconnectedExpiry();
    const handleId = ++this.#activeHandleId;
    // A valid silent resume is an ownership transfer. Stop forwarding to the
    // previous physical transport immediately, even if its half-open socket
    // has not emitted close yet; events now enter the continuity buffer until
    // the new transport installs its listener after the handshake reply.
    this.#listeners.clear();
    let released = false;
    const assertCurrent = (): void => {
      if (released || handleId !== this.#activeHandleId)
        throw new Error("Authenticated Gateway transport was superseded");
    };
    return {
      request: (request) => {
        assertCurrent();
        return this.#ensureInner().then((inner) => inner.request(request));
      },
      validateDurableResult: (request, result) => {
        assertCurrent();
        return this.#ensureInner().then((inner) =>
          inner.validateDurableResult?.(request, result),
        );
      },
      onEvent: (listener) => {
        if (released || handleId !== this.#activeHandleId)
          return () => undefined;
        this.#listeners.add(listener);
        this.#subscribeInner();
        if (this.#bufferedEvents.length > 0) {
          const buffered = this.#acknowledgedDeliveryEnabled
            ? this.#bufferedEvents
            : this.#bufferedEvents.splice(0);
          if (!this.#acknowledgedDeliveryEnabled) this.#bufferedEventBytes = 0;
          for (const { event } of buffered) listener(event);
        }
        return () => this.#listeners.delete(listener);
      },
      close: async () => {
        if (released) return;
        released = true;
        this.#sessionReferences -= 1;
        await this.#releaseInnerUnlessContinuityIsRequired();
        this.#scheduleDisconnectedExpiryIfRequired();
        await this.#disposeIfUnreferenced();
      },
    };
  }

  retainTicket(): void {
    if (this.#disposed)
      throw new Error("Authenticated page session continuity was released");
    this.#ticketReferences += 1;
  }

  releaseTicket(): void {
    if (this.#ticketReferences === 0) return;
    this.#ticketReferences -= 1;
    void this.#disposeIfUnreferenced();
  }

  configureDisconnectedExpiry(
    expireTickets: () => void,
    graceMs = DEFAULT_DISCONNECTED_SIDE_GRACE_MS,
  ): void {
    if (!Number.isSafeInteger(graceMs) || graceMs <= 0)
      throw new Error("Disconnected Side grace period must be positive");
    this.#expireDisconnectedTickets = expireTickets;
    this.#disconnectedGraceMs = graceMs;
    this.#scheduleDisconnectedExpiryIfRequired();
  }

  enableAcknowledgedDelivery(): void {
    this.#acknowledgedDeliveryEnabled = true;
  }

  async #ensureInner(): Promise<GatewaySession> {
    if (this.#disposed)
      throw new Error("Authenticated page session continuity was released");
    if (this.#inner) return this.#inner;
    if (!this.#innerPromise) {
      const pending = this.#createInner()
        .then(async (inner) => {
          if (this.#disposed) {
            await inner.close?.();
            throw new Error(
              "Authenticated page session continuity was released",
            );
          }
          this.#inner = inner;
          this.#unsubscribeInnerClose = inner.onClose?.(() => {
            if (inner.shouldRetainAcrossReconnect?.() === true) {
              this.#requiresDisconnectedExpiry = true;
              this.#signalContinuityGap("inner-closed");
            }
            this.#discardInner(inner);
          });
          this.#subscribeInner();
          // The transport may have closed while createInner() was pending.
          // Re-run the lifetime decision after installation so an ordinary
          // app-server client cannot be retained by a ticket alone.
          await this.#releaseInnerUnlessContinuityIsRequired();
          return inner;
        })
        .catch((error: unknown) => {
          if (this.#innerPromise === pending) this.#innerPromise = undefined;
          throw error;
        });
      this.#innerPromise = pending;
    }
    return this.#innerPromise;
  }

  #subscribeInner(): void {
    if (!this.#inner || this.#unsubscribeInner || this.#listeners.size === 0)
      return;
    this.#unsubscribeInner = this.#inner.onEvent?.((event) => {
      if (this.#overflowed) return;
      if (this.#inner?.shouldRetainAcrossReconnect?.() !== true) {
        for (const listener of this.#listeners) listener(event);
        return;
      }
      this.#requiresDisconnectedExpiry = true;
      if (!this.#acknowledgedDeliveryEnabled) {
        if (this.#listeners.size > 0) {
          for (const listener of this.#listeners) listener(event);
          return;
        }
        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        this.#bufferedEvents.push({ event, bytes });
        this.#bufferedEventBytes += bytes;
        while (
          this.#bufferedEvents.length > MAX_CONTINUITY_BUFFERED_EVENTS ||
          this.#bufferedEventBytes > MAX_CONTINUITY_BUFFERED_EVENT_BYTES
        ) {
          const removed = this.#bufferedEvents.shift();
          if (!removed) break;
          this.#bufferedEventBytes -= removed.bytes;
        }
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (
        this.#bufferedEvents.length + 1 > MAX_CONTINUITY_BUFFERED_EVENTS ||
        this.#bufferedEventBytes + bytes > MAX_CONTINUITY_BUFFERED_EVENT_BYTES
      ) {
        const payload = asRecord(event.payload);
        this.#signalContinuityGap(
          "buffer-limit",
          event.cursor,
          typeof payload.threadId === "string" ? payload.threadId : undefined,
        );
        return;
      }
      this.#bufferedEvents.push({ event, bytes });
      this.#bufferedEventBytes += bytes;
      for (const listener of this.#listeners) listener(event);
    });
  }

  #signalContinuityGap(
    reason: GatewayContinuityOverflowPayload["reason"],
    cursor = this.#bufferedEvents.at(-1)?.event.cursor ?? "0",
    threadId = continuityThreadId(this.#bufferedEvents),
  ): void {
    if (this.#overflowed) return;
    const payload: GatewayContinuityOverflowPayload = {
      version: 1,
      reason,
      ...(threadId ? { threadId } : {}),
    };
    const gap: EventEnvelope = {
      version: 1,
      eventId: randomUUID(),
      cursor,
      type: GATEWAY_CONTINUITY_OVERFLOW_EVENT,
      payload,
    };
    const bytes = Buffer.byteLength(JSON.stringify(gap), "utf8");
    this.#bufferedEvents.length = 0;
    this.#bufferedEvents.push({ event: gap, bytes });
    this.#bufferedEventBytes = bytes;
    this.#overflowed = this.#acknowledgedDeliveryEnabled;
    for (const listener of this.#listeners) listener(gap);
  }

  acknowledgeEvent(eventId: string): boolean {
    if (!this.#acknowledgedDeliveryEnabled) return false;
    const index = this.#bufferedEvents.findIndex(
      ({ event }) => event.eventId === eventId,
    );
    if (index < 0) return false;
    const acknowledged = this.#bufferedEvents.splice(0, index + 1);
    for (const entry of acknowledged) this.#bufferedEventBytes -= entry.bytes;
    if (
      acknowledged.some(
        ({ event }) => event.type === GATEWAY_CONTINUITY_OVERFLOW_EVENT,
      )
    ) {
      this.#overflowed = false;
    }
    return true;
  }

  #discardInner(inner: GatewaySession): void {
    if (this.#inner !== inner) return;
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    this.#unsubscribeInnerClose?.();
    this.#unsubscribeInnerClose = undefined;
    this.#inner = undefined;
    this.#innerPromise = undefined;
    try {
      void Promise.resolve(inner.close?.()).catch(() => undefined);
    } catch {
      // The transport is already closed. Cleanup is best effort.
    }
  }

  async #disposeIfUnreferenced(): Promise<void> {
    if (
      this.#disposed ||
      this.#sessionReferences !== 0 ||
      this.#ticketReferences !== 0
    ) {
      return;
    }
    this.#disposed = true;
    this.#cancelDisconnectedExpiry();
    this.#listeners.clear();
    this.#bufferedEvents.length = 0;
    this.#bufferedEventBytes = 0;
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    this.#unsubscribeInnerClose?.();
    this.#unsubscribeInnerClose = undefined;
    const inner = this.#inner;
    this.#inner = undefined;
    const pending = this.#innerPromise;
    this.#innerPromise = undefined;
    if (inner) await inner.close?.();
    else if (pending) {
      try {
        await (await pending).close?.();
      } catch {
        // A failed or concurrently closed app-server connection is already
        // released; continuity disposal must remain idempotent.
      }
    }
  }

  async #releaseInnerUnlessContinuityIsRequired(): Promise<void> {
    if (
      this.#disposed ||
      this.#sessionReferences !== 0 ||
      this.#ticketReferences === 0 ||
      !this.#inner ||
      this.#inner.shouldRetainAcrossReconnect?.() === true
    ) {
      return;
    }
    const inner = this.#inner;
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    this.#unsubscribeInnerClose?.();
    this.#unsubscribeInnerClose = undefined;
    this.#inner = undefined;
    this.#innerPromise = undefined;
    this.#bufferedEvents.length = 0;
    this.#bufferedEventBytes = 0;
    await inner.close?.();
  }

  #scheduleDisconnectedExpiryIfRequired(): void {
    if (this.#inner?.shouldRetainAcrossReconnect?.() === true)
      this.#requiresDisconnectedExpiry = true;
    if (
      this.#disposed ||
      this.#disconnectedExpiryTimer ||
      this.#sessionReferences !== 0 ||
      this.#ticketReferences === 0 ||
      !this.#expireDisconnectedTickets ||
      !this.#requiresDisconnectedExpiry
    ) {
      return;
    }
    this.#disconnectedExpiryTimer = setTimeout(() => {
      this.#disconnectedExpiryTimer = undefined;
      if (
        this.#disposed ||
        this.#sessionReferences !== 0 ||
        this.#ticketReferences === 0
      ) {
        return;
      }
      this.#expireDisconnectedTickets?.();
    }, this.#disconnectedGraceMs);
    this.#disconnectedExpiryTimer.unref?.();
  }

  #cancelDisconnectedExpiry(): void {
    if (!this.#disconnectedExpiryTimer) return;
    clearTimeout(this.#disconnectedExpiryTimer);
    this.#disconnectedExpiryTimer = undefined;
  }
}

export class AuthenticatedGatewaySession implements GatewaySession {
  readonly #createInner: () => Promise<GatewaySession>;
  readonly #passkeys: PasskeyRegistry;
  readonly #passwords: PasswordRegistry | undefined;
  readonly #opaqueIdentifiers: OpaqueIdentifiers | undefined;
  readonly #newlyPaired: boolean;
  readonly #onAuthenticated:
    (() => Promise<(() => Promise<void> | void) | void>) | undefined;
  readonly #consumeAuthAttempt:
    ((kind: AuthenticationAttemptKind) => void) | undefined;
  readonly #captureAuthenticationGeneration: (() => number) | undefined;
  readonly #registerAuthenticatedSession:
    | ((
        expectedGeneration: number,
        revoke: () => void,
      ) => (() => void) | undefined)
    | undefined;
  readonly #issueResumeTicket:
    | ((
        expectedGeneration: number,
        continuity: AuthenticatedGatewaySessionContinuity,
      ) => string | undefined)
    | undefined;
  readonly #releaseResumeTickets:
    ((continuity: AuthenticatedGatewaySessionContinuity) => number) | undefined;
  readonly #runCredentialMutation: CredentialMutationRunner | undefined;
  readonly #onCredentialsRecovered: (() => Promise<void> | void) | undefined;
  readonly #assertAuthenticatedSessionCurrent:
    (() => Promise<void>) | undefined;
  readonly #authenticatedSessionRecheckMs: number;
  readonly #handleAuthenticatedRequest:
    | ((
        request: RequestEnvelope,
        emitEvent: (event: EventEnvelope) => void,
      ) => Promise<AuthenticatedRequestResult>)
    | undefined;
  readonly #continuity: AuthenticatedGatewaySessionContinuity;
  readonly #listeners = new Set<
    Parameters<NonNullable<GatewaySession["onEvent"]>>[0]
  >();
  #inner: GatewaySession | undefined;
  #unsubscribeInner: (() => void) | undefined;
  #unsubscribeInnerClose: (() => void) | undefined;
  #innerPromise: Promise<GatewaySession> | undefined;
  #authenticated = false;
  #authenticationFinalized = false;
  #registrationChallenge: PendingWebAuthnChallenge | undefined;
  #registrationMode: "initial" | "recovery" | "add" | undefined;
  #authenticationChallenge: PendingWebAuthnChallenge | undefined;
  #recoveryAuthorization: PendingRecoveryAuthorization | undefined;
  #serverLoginState: PendingPasswordLogin | undefined;
  #authenticationStateExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #expiredAuthenticationStates = new Set<PendingAuthenticationState>();
  #unregisterAuthenticatedSession: (() => void) | undefined;
  #authenticatedGeneration: number | undefined;
  #revoked = false;
  #authenticationRecheckTimer: ReturnType<typeof setInterval> | undefined;
  #authenticationRecheckInFlight = false;

  constructor(options: {
    inner?: GatewaySession;
    createInner?: () => Promise<GatewaySession>;
    passkeys: PasskeyRegistry;
    passwords?: PasswordRegistry;
    opaqueIdentifiers?: OpaqueIdentifiers;
    newlyPaired: boolean;
    onAuthenticated?: () => Promise<(() => Promise<void> | void) | void>;
    consumeAuthAttempt?: (kind: AuthenticationAttemptKind) => void;
    captureAuthenticationGeneration?: () => number;
    registerAuthenticatedSession?: (
      expectedGeneration: number,
      revoke: () => void,
    ) => (() => void) | undefined;
    resumeToken?: string;
    resumeAuthenticatedSession?: (
      token: string,
      revoke: () => void,
    ) =>
      | {
          unregister: () => void;
          generation: number;
          continuity?: AuthenticatedGatewaySessionContinuity;
        }
      | undefined;
    issueResumeTicket?: (
      expectedGeneration: number,
      continuity: AuthenticatedGatewaySessionContinuity,
    ) => string | undefined;
    releaseResumeTickets?: (
      continuity: AuthenticatedGatewaySessionContinuity,
    ) => number;
    disconnectedSideGraceMs?: number;
    runCredentialMutation?: CredentialMutationRunner;
    onCredentialsRecovered?: () => Promise<void> | void;
    assertAuthenticatedSessionCurrent?: () => Promise<void>;
    authenticationRecheckMs?: number;
    handleAuthenticatedRequest?: (
      request: RequestEnvelope,
      emitEvent: (event: EventEnvelope) => void,
    ) => Promise<AuthenticatedRequestResult>;
  }) {
    if (!options.inner && !options.createInner)
      throw new Error(
        "Authenticated session requires an inner session factory",
      );
    this.#createInner = options.createInner ?? (async () => options.inner!);
    this.#passkeys = options.passkeys;
    this.#passwords = options.passwords;
    this.#opaqueIdentifiers = options.opaqueIdentifiers;
    this.#newlyPaired = options.newlyPaired;
    this.#onAuthenticated = options.onAuthenticated;
    this.#consumeAuthAttempt = options.consumeAuthAttempt;
    this.#captureAuthenticationGeneration =
      options.captureAuthenticationGeneration;
    this.#registerAuthenticatedSession = options.registerAuthenticatedSession;
    this.#issueResumeTicket = options.issueResumeTicket;
    this.#releaseResumeTickets = options.releaseResumeTickets;
    this.#runCredentialMutation = options.runCredentialMutation;
    this.#onCredentialsRecovered = options.onCredentialsRecovered;
    this.#assertAuthenticatedSessionCurrent =
      options.assertAuthenticatedSessionCurrent;
    this.#authenticatedSessionRecheckMs =
      options.authenticationRecheckMs ?? AUTHENTICATED_SESSION_RECHECK_MS;
    if (
      !Number.isSafeInteger(this.#authenticatedSessionRecheckMs) ||
      this.#authenticatedSessionRecheckMs <= 0
    ) {
      throw new Error(
        "Authenticated session recheck interval must be positive",
      );
    }
    this.#handleAuthenticatedRequest = options.handleAuthenticatedRequest;
    let resumed:
      | {
          unregister: () => void;
          generation: number;
          continuity?: AuthenticatedGatewaySessionContinuity;
        }
      | undefined;
    if (options.resumeToken !== undefined) {
      resumed = options.resumeAuthenticatedSession?.(options.resumeToken, () =>
        this.#revoke(),
      );
      if (!resumed) {
        throw new Error("REAUTH_REQUIRED: session resume ticket is invalid");
      }
      this.#authenticated = true;
      this.#authenticationFinalized = true;
      this.#unregisterAuthenticatedSession = resumed.unregister;
      this.#authenticatedGeneration = resumed.generation;
      this.#startAuthenticationRecheck();
    }
    this.#continuity =
      resumed?.continuity ??
      new AuthenticatedGatewaySessionContinuity(
        this.#createInner,
        options.inner,
      );
    if (options.releaseResumeTickets) {
      this.#continuity.configureDisconnectedExpiry(
        () => options.releaseResumeTickets?.(this.#continuity),
        options.disconnectedSideGraceMs,
      );
    }
    this.#inner = this.#continuity.open();
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
    if (this.#authenticated && this.#assertAuthenticatedSessionCurrent) {
      await this.#assertAuthenticatedSessionCurrent();
    }
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
      case GATEWAY_SESSION_RELEASE_METHOD: {
        if (!this.#authenticated)
          throw new Error("Passkey authentication required");
        if (payload.version !== 1)
          throw new Error("Unsupported page-session release version");
        return {
          version: 1,
          released: this.#releaseResumeTickets?.(this.#continuity) ?? 0,
        };
      }
      case GATEWAY_CONTINUITY_ACK_METHOD: {
        if (!this.#authenticated)
          throw new Error("Passkey authentication required");
        if (
          payload.version !== 1 ||
          typeof payload.eventId !== "string" ||
          payload.eventId.length === 0 ||
          payload.eventId.length > 256
        ) {
          throw new Error("Invalid continuity event acknowledgement");
        }
        return {
          version: 1,
          acknowledged: this.#continuity.acknowledgeEvent(payload.eventId),
        };
      }
      case GATEWAY_CONTINUITY_ENABLE_METHOD: {
        if (!this.#authenticated)
          throw new Error("Passkey authentication required");
        if (payload.version !== 1)
          throw new Error("Unsupported continuity acknowledgement version");
        this.#continuity.enableAcknowledgedDelivery();
        return { version: 1, enabled: true };
      }
      case "auth/register/options": {
        const recoveryAuthorization = !this.#authenticated
          ? this.#takeRecoveryAuthorization()
          : undefined;
        let hasExistingPasskey = false;
        if (
          !this.#authenticated &&
          !recoveryAuthorization &&
          !this.#newlyPaired
        ) {
          hasExistingPasskey = true;
        } else if (
          !this.#authenticated &&
          !recoveryAuthorization &&
          this.#newlyPaired
        ) {
          hasExistingPasskey = (await this.#passkeys.count()) > 0;
          this.#assertSessionOpen();
        }
        if (
          !this.#authenticated &&
          !recoveryAuthorization &&
          hasExistingPasskey
        )
          throw new Error(
            "Passkey registration is not allowed in this session",
          );
        const authGeneration = this.#authenticated
          ? this.#authenticatedGeneration
          : this.#captureAuthenticationGeneration?.();
        const options = await this.#passkeys.registrationOptions();
        this.#assertSessionOpen();
        if (recoveryAuthorization) {
          assertAuthenticationStateFresh(
            recoveryAuthorization,
            "Recovery authorization",
          );
        }
        this.#setRegistrationChallenge(
          pendingChallenge(
            options.challenge,
            authGeneration,
            recoveryAuthorization?.value,
            recoveryAuthorization?.expiresAt,
          ),
          recoveryAuthorization
            ? "recovery"
            : this.#authenticated
              ? "add"
              : "initial",
        );
        return options;
      }
      case "auth/register/verify": {
        const challenge = this.#takeRegistrationChallenge();
        const mode = this.#registrationMode;
        this.#registrationMode = undefined;
        if (!mode) throw new Error("Passkey registration mode is missing");
        assertAuthenticationStateFresh(challenge, "Passkey registration");
        let authenticationGeneration = challenge.authGeneration;
        const mutation = await this.#mutateCredentials(
          authenticationGeneration,
          () =>
            this.#passkeys.verifyRegistration(
              payload.response as RegistrationResponseJSON,
              challenge.value,
              {
                replaceExisting: mode === "recovery",
                issueRecoveryCodes: mode !== "add",
                ...(mode === "initial"
                  ? { requireNoExistingPasskey: true }
                  : {}),
                ...(mode === "recovery" && challenge.recoveryAuthorization
                  ? {
                      recoveryAuthorization: challenge.recoveryAuthorization,
                    }
                  : {}),
              },
            ),
          { revokeAllAfter: mode === "recovery" },
        );
        const result = mutation.result;
        if (mode === "recovery") {
          authenticationGeneration = mutation.generation;
        }
        const resumeToken = !this.#authenticated
          ? await this.#finishAuthentication(authenticationGeneration)
          : undefined;
        return {
          ...result,
          ...this.#authenticatedResult(resumeToken),
        };
      }
      case "auth/recover": {
        if (this.#authenticated)
          throw new Error("Recovery requires a new unauthenticated session");
        this.#consumeAuthAttempt?.("recovery");
        if (typeof payload.code !== "string")
          throw new Error("Recovery code is required");
        const authorization = await this.#passkeys.authorizeRecovery(
          payload.code,
        );
        this.#assertSessionOpen();
        this.#setRecoveryAuthorization(authorization);
        return { registrationRequired: true };
      }
      case "auth/recovery/rotate": {
        if (!this.#authenticated)
          throw new Error("Authentication required to rotate recovery codes");
        const mutation = await this.#mutateCredentials(
          this.#authenticatedGeneration,
          () => this.#passkeys.rotateRecoveryCodes(),
        );
        return { recoveryCodes: mutation.result };
      }
      case "auth/login/options": {
        const authGeneration = this.#captureAuthenticationGeneration?.();
        const options = await this.#passkeys.authenticationOptions(
          payload.discoverable === true,
        );
        this.#assertSessionOpen();
        this.#setAuthenticationChallenge(
          pendingChallenge(options.challenge, authGeneration),
        );
        return options;
      }
      case "auth/login/verify": {
        const challenge = this.#takeAuthenticationChallenge();
        assertAuthenticationStateFresh(challenge, "Passkey authentication");
        await this.#passkeys.verifyAuthentication(
          payload.response as AuthenticationResponseJSON,
          challenge.value,
        );
        const resumeToken = await this.#finishAuthentication(
          challenge.authGeneration,
        );
        return this.#authenticatedResult(resumeToken);
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
        await this.#mutateCredentials(this.#authenticatedGeneration, () =>
          this.#requiredPasswords().saveRegistrationRecord(
            payload.registrationRecord as string,
          ),
        );
        return { passwordEnabled: true };
      }
      case "auth/password/login/start": {
        this.#consumeAuthAttempt?.("password");
        if (typeof payload.startLoginRequest !== "string")
          throw new Error("Password login request is required");
        const authGeneration = this.#captureAuthenticationGeneration?.();
        const started = await this.#requiredPasswords().startLogin(
          payload.startLoginRequest,
          this.#requiredOpaqueIdentifiers(),
        );
        this.#assertSessionOpen();
        this.#setPasswordLoginState({
          value: started.serverLoginState,
          expiresAt: Date.now() + AUTHENTICATION_STATE_TTL_MS,
          ...(authGeneration !== undefined ? { authGeneration } : {}),
        });
        return { loginResponse: started.loginResponse };
      }
      case "auth/password/login/finish": {
        const state = this.#takePasswordLoginState();
        if (typeof payload.finishLoginRequest !== "string")
          throw new Error("Password login finalization is required");
        assertAuthenticationStateFresh(state, "Password login state");
        await this.#requiredPasswords().finishLogin(
          state.value,
          payload.finishLoginRequest,
          this.#requiredOpaqueIdentifiers(),
        );
        const resumeToken = await this.#finishAuthentication(
          state.authGeneration,
        );
        return this.#authenticatedResult(resumeToken);
      }
      case "host/ping":
        if (!this.#authenticated)
          throw new Error("Passkey authentication required");
        return { version: 1, ok: true, serverTime: Date.now() };
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

  async validateDurableResult(
    request: RequestEnvelope,
    result: unknown,
  ): Promise<void> {
    if (this.#revoked || !this.#authenticated)
      throw new Error("Passkey authentication required");
    const payload = asRecord(request.payload);
    if (request.method !== "thread/fork" || payload.ephemeral !== true) return;
    await (await this.#ensureInner()).validateDurableResult?.(request, result);
  }

  async close(): Promise<void> {
    this.#unregisterAuthenticatedSession?.();
    this.#unregisterAuthenticatedSession = undefined;
    this.#revoked = true;
    this.#authenticated = false;
    this.#authenticatedGeneration = undefined;
    this.#clearPendingAuthenticationStates();
    this.#stopAuthenticationRecheck();
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    this.#unsubscribeInnerClose?.();
    this.#unsubscribeInnerClose = undefined;
    await this.#inner?.close?.();
  }

  async #finishAuthentication(
    expectedGeneration: number | undefined,
  ): Promise<string | undefined> {
    if (this.#authenticationFinalized) return undefined;
    if (this.#revoked)
      throw new Error("Authentication was invalidated; reconnect");
    let rollbackAuthenticatedSideEffect: (() => Promise<void> | void) | void =
      undefined;
    try {
      if (this.#registerAuthenticatedSession) {
        if (expectedGeneration === undefined)
          throw new Error("Authentication generation is missing");
        this.#unregisterAuthenticatedSession =
          this.#registerAuthenticatedSession(expectedGeneration, () =>
            this.#revoke(),
          );
        if (!this.#unregisterAuthenticatedSession)
          throw new Error("Authentication was invalidated; reconnect");
      }
      if (this.#onAuthenticated) {
        rollbackAuthenticatedSideEffect = (
          await this.#mutateCredentials(expectedGeneration, () =>
            this.#onAuthenticated!(),
          )
        ).result;
      }
      if (this.#revoked)
        throw new Error("Authentication was invalidated; reconnect");
      let resumeToken: string | undefined;
      if (this.#issueResumeTicket) {
        if (expectedGeneration === undefined)
          throw new Error("Authentication generation is missing");
        resumeToken = this.#issueResumeTicket(
          expectedGeneration,
          this.#continuity,
        );
        if (!resumeToken)
          throw new Error("Authentication was invalidated; reconnect");
      }
      this.#authenticated = true;
      this.#authenticationFinalized = true;
      this.#authenticatedGeneration = expectedGeneration;
      this.#clearPendingAuthenticationStates();
      this.#startAuthenticationRecheck();
      this.#subscribeInner();
      return resumeToken;
    } catch (error) {
      this.#unregisterAuthenticatedSession?.();
      this.#unregisterAuthenticatedSession = undefined;
      try {
        await rollbackAuthenticatedSideEffect?.();
      } finally {
        this.#revoke();
      }
      throw error;
    }
  }

  #revoke(): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.#authenticated = false;
    this.#authenticatedGeneration = undefined;
    this.#clearPendingAuthenticationStates();
    this.#stopAuthenticationRecheck();
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    this.#unsubscribeInnerClose?.();
    this.#unsubscribeInnerClose = undefined;
    void this.#inner?.close?.();
  }

  #startAuthenticationRecheck(): void {
    if (
      !this.#assertAuthenticatedSessionCurrent ||
      this.#authenticationRecheckTimer ||
      this.#revoked
    ) {
      return;
    }
    this.#authenticationRecheckTimer = setInterval(() => {
      if (this.#authenticationRecheckInFlight || this.#revoked) return;
      this.#authenticationRecheckInFlight = true;
      void this.#assertAuthenticatedSessionCurrent!()
        .catch(() => {
          // Definitive revocation is applied by the registry-backed callback.
          // Transient state-store failures fail the current check closed but do
          // not destroy a reusable page ticket; the next interval retries.
        })
        .finally(() => {
          this.#authenticationRecheckInFlight = false;
        });
    }, this.#authenticatedSessionRecheckMs);
    this.#authenticationRecheckTimer.unref?.();
  }

  #stopAuthenticationRecheck(): void {
    if (this.#authenticationRecheckTimer)
      clearInterval(this.#authenticationRecheckTimer);
    this.#authenticationRecheckTimer = undefined;
    this.#authenticationRecheckInFlight = false;
  }

  #assertSessionOpen(): void {
    if (this.#revoked)
      throw new Error("Authentication was invalidated; reconnect");
  }

  #setRegistrationChallenge(
    challenge: PendingWebAuthnChallenge,
    mode: "initial" | "recovery" | "add",
  ): void {
    this.#registrationChallenge = challenge;
    this.#registrationMode = mode;
    this.#expiredAuthenticationStates.delete("registration");
    this.#rescheduleAuthenticationStateExpiry();
  }

  #takeRegistrationChallenge(): PendingWebAuthnChallenge {
    const challenge = this.#registrationChallenge;
    this.#registrationChallenge = undefined;
    const expired = this.#expiredAuthenticationStates.delete("registration");
    this.#rescheduleAuthenticationStateExpiry();
    if (challenge) return challenge;
    if (expired) throw new Error("Passkey registration challenge has expired");
    throw new Error("Passkey registration challenge is missing");
  }

  #setAuthenticationChallenge(challenge: PendingWebAuthnChallenge): void {
    this.#authenticationChallenge = challenge;
    this.#expiredAuthenticationStates.delete("authentication");
    this.#rescheduleAuthenticationStateExpiry();
  }

  #takeAuthenticationChallenge(): PendingWebAuthnChallenge {
    const challenge = this.#authenticationChallenge;
    this.#authenticationChallenge = undefined;
    const expired = this.#expiredAuthenticationStates.delete("authentication");
    this.#rescheduleAuthenticationStateExpiry();
    if (challenge) return challenge;
    if (expired)
      throw new Error("Passkey authentication challenge has expired");
    throw new Error("Passkey authentication challenge is missing");
  }

  #setRecoveryAuthorization(authorization: RecoveryAuthorization): void {
    this.#recoveryAuthorization = {
      value: authorization,
      expiresAt: Date.now() + AUTHENTICATION_STATE_TTL_MS,
    };
    this.#expiredAuthenticationStates.delete("recovery");
    this.#rescheduleAuthenticationStateExpiry();
  }

  #takeRecoveryAuthorization(): PendingRecoveryAuthorization | undefined {
    const authorization = this.#recoveryAuthorization;
    this.#recoveryAuthorization = undefined;
    const expired = this.#expiredAuthenticationStates.delete("recovery");
    this.#rescheduleAuthenticationStateExpiry();
    if (authorization) {
      assertAuthenticationStateFresh(authorization, "Recovery authorization");
      return authorization;
    }
    if (expired) throw new Error("Recovery authorization has expired");
    return undefined;
  }

  #setPasswordLoginState(state: PendingPasswordLogin): void {
    this.#serverLoginState = state;
    this.#expiredAuthenticationStates.delete("password-login");
    this.#rescheduleAuthenticationStateExpiry();
  }

  #takePasswordLoginState(): PendingPasswordLogin {
    const state = this.#serverLoginState;
    this.#serverLoginState = undefined;
    const expired = this.#expiredAuthenticationStates.delete("password-login");
    this.#rescheduleAuthenticationStateExpiry();
    if (state) return state;
    if (expired) throw new Error("Password login state has expired");
    throw new Error("Password login state is missing");
  }

  #rescheduleAuthenticationStateExpiry(): void {
    if (this.#authenticationStateExpiryTimer) {
      clearTimeout(this.#authenticationStateExpiryTimer);
      this.#authenticationStateExpiryTimer = undefined;
    }
    const expirations = [
      this.#registrationChallenge?.expiresAt,
      this.#authenticationChallenge?.expiresAt,
      this.#recoveryAuthorization?.expiresAt,
      this.#serverLoginState?.expiresAt,
    ].filter((value): value is number => value !== undefined);
    if (expirations.length === 0) return;
    const expiresAt = Math.min(...expirations);
    this.#authenticationStateExpiryTimer = setTimeout(
      () => {
        this.#authenticationStateExpiryTimer = undefined;
        this.#expireAuthenticationStates();
        this.#rescheduleAuthenticationStateExpiry();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    this.#authenticationStateExpiryTimer.unref?.();
  }

  #expireAuthenticationStates(): void {
    const now = Date.now();
    if (
      this.#registrationChallenge &&
      now >= this.#registrationChallenge.expiresAt
    ) {
      this.#registrationChallenge = undefined;
      this.#registrationMode = undefined;
      this.#expiredAuthenticationStates.add("registration");
    }
    if (
      this.#authenticationChallenge &&
      now >= this.#authenticationChallenge.expiresAt
    ) {
      this.#authenticationChallenge = undefined;
      this.#expiredAuthenticationStates.add("authentication");
    }
    if (
      this.#recoveryAuthorization &&
      now >= this.#recoveryAuthorization.expiresAt
    ) {
      this.#recoveryAuthorization = undefined;
      this.#expiredAuthenticationStates.add("recovery");
    }
    if (this.#serverLoginState && now >= this.#serverLoginState.expiresAt) {
      this.#serverLoginState = undefined;
      this.#expiredAuthenticationStates.add("password-login");
    }
  }

  #clearPendingAuthenticationStates(): void {
    if (this.#authenticationStateExpiryTimer)
      clearTimeout(this.#authenticationStateExpiryTimer);
    this.#authenticationStateExpiryTimer = undefined;
    this.#registrationChallenge = undefined;
    this.#registrationMode = undefined;
    this.#authenticationChallenge = undefined;
    this.#recoveryAuthorization = undefined;
    this.#serverLoginState = undefined;
    this.#expiredAuthenticationStates.clear();
  }

  #ensureInner(): Promise<GatewaySession> {
    if (this.#inner) return Promise.resolve(this.#inner);
    if (!this.#innerPromise) {
      const pending = this.#createInner()
        .then((inner) => {
          this.#inner = inner;
          this.#unsubscribeInnerClose = inner.onClose?.(() =>
            this.#discardInner(inner),
          );
          this.#subscribeInner();
          return inner;
        })
        .catch((error: unknown) => {
          // app-server availability is independent from Host authentication.
          // A failed cold start must not poison this authenticated browser
          // session forever; a later request may reconnect after recovery.
          if (this.#innerPromise === pending) this.#innerPromise = undefined;
          throw error;
        });
      this.#innerPromise = pending;
    }
    return this.#innerPromise;
  }

  #discardInner(inner: GatewaySession): void {
    if (this.#inner !== inner) return;
    this.#unsubscribeInner?.();
    this.#unsubscribeInner = undefined;
    this.#unsubscribeInnerClose?.();
    this.#unsubscribeInnerClose = undefined;
    this.#inner = undefined;
    this.#innerPromise = undefined;
    try {
      void Promise.resolve(inner.close?.()).catch(() => undefined);
    } catch {
      // The transport is already closed. Cleanup is best effort and must not
      // turn its close notification into an unhandled exception.
    }
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

  #authenticatedResult(resumeToken?: string): {
    authenticated: true;
    resumeToken?: string;
  } {
    return {
      authenticated: true,
      ...(resumeToken ? { resumeToken } : {}),
    };
  }

  async #mutateCredentials<T>(
    expectedGeneration: number | undefined,
    operation: () => Promise<T>,
    options: { revokeAllAfter?: boolean } = {},
  ): Promise<CredentialMutationResult<T>> {
    if (this.#runCredentialMutation) {
      if (expectedGeneration === undefined)
        throw new Error("Authentication generation is missing");
      return this.#runCredentialMutation(
        expectedGeneration,
        async () => {
          if (this.#revoked)
            throw new Error("Authentication was invalidated; reconnect");
          return operation();
        },
        options,
      );
    }
    const result = await operation();
    if (options.revokeAllAfter) await this.#onCredentialsRecovered?.();
    return {
      result,
      generation: options.revokeAllAfter
        ? (this.#captureAuthenticationGeneration?.() ?? expectedGeneration ?? 0)
        : (expectedGeneration ?? 0),
    };
  }

  #requiredOpaqueIdentifiers(): OpaqueIdentifiers {
    if (!this.#opaqueIdentifiers)
      throw new Error("Password login identifiers are not configured");
    return this.#opaqueIdentifiers;
  }
}

function continuityThreadId(
  entries: ReadonlyArray<{ event: EventEnvelope }>,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const value = entries[index]?.event.payload;
    if (!value || typeof value !== "object") continue;
    const threadId = (value as Record<string, unknown>).threadId;
    if (typeof threadId === "string") return threadId;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error("Request payload must be an object");
  return value as Record<string, unknown>;
}

function pendingChallenge(
  value: string,
  authGeneration?: number,
  recoveryAuthorization?: RecoveryAuthorization,
  authorizationExpiresAt?: number,
): PendingWebAuthnChallenge {
  return {
    value,
    expiresAt: Math.min(
      Date.now() + AUTHENTICATION_STATE_TTL_MS,
      authorizationExpiresAt ?? Number.POSITIVE_INFINITY,
    ),
    ...(authGeneration !== undefined ? { authGeneration } : {}),
    ...(recoveryAuthorization ? { recoveryAuthorization } : {}),
  };
}

function assertAuthenticationStateFresh(
  state: { expiresAt: number },
  label: string,
): void {
  if (Date.now() >= state.expiresAt) {
    throw new Error(`${label} has expired`);
  }
}
