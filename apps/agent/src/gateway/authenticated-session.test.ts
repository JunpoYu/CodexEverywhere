import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EventEnvelope,
  RequestEnvelope,
} from "@codex-everywhere/protocol";

import type { PasskeyRegistry } from "../host/passkeys.js";
import type { PasswordRegistry } from "../host/passwords.js";
import { AuthenticatedSessionRegistry } from "../host/auth-security.js";
import {
  AuthenticatedGatewaySession,
  AuthenticatedGatewaySessionContinuity,
} from "./authenticated-session.js";

afterEach(() => vi.useRealTimers());

describe("AuthenticatedGatewaySession", () => {
  it("does not retain an ordinary app-server client for the lifetime of a page ticket", async () => {
    const close = vi.fn(async () => undefined);
    const continuity = new AuthenticatedGatewaySessionContinuity(
      async () => ({ request: async () => "unused" }),
      {
        request: async () => "ordinary",
        shouldRetainAcrossReconnect: () => false,
        close,
      },
    );
    continuity.retainTicket();
    const transport = continuity.open();

    await transport.close?.();
    expect(close).toHaveBeenCalledOnce();

    continuity.releaseTicket();
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases an ordinary inner that resolves after its transport closed", async () => {
    let resolveInner:
      | ((inner: {
          request: () => Promise<string>;
          shouldRetainAcrossReconnect: () => boolean;
          close: () => Promise<void>;
        }) => void)
      | undefined;
    const close = vi.fn(async () => undefined);
    const innerPending = new Promise<{
      request: () => Promise<string>;
      shouldRetainAcrossReconnect: () => boolean;
      close: () => Promise<void>;
    }>((resolve) => {
      resolveInner = resolve;
    });
    const continuity = new AuthenticatedGatewaySessionContinuity(
      () => innerPending,
    );
    continuity.retainTicket();
    const transport = continuity.open();
    const request = transport.request(envelope("workspace/list", {}));
    await transport.close?.();

    resolveInner?.({
      request: async () => "late",
      shouldRetainAcrossReconnect: () => false,
      close,
    });
    await expect(request).resolves.toBe("late");
    expect(close).toHaveBeenCalledOnce();
    continuity.releaseTicket();
  });

  it("replays continuity events until the browser acknowledges them", async () => {
    let emit: ((event: EventEnvelope) => void) | undefined;
    const continuity = new AuthenticatedGatewaySessionContinuity(async () => ({
      request: async () => "ok",
      onEvent: (listener: (event: EventEnvelope) => void) => {
        emit = listener;
        return () => undefined;
      },
      shouldRetainAcrossReconnect: () => true,
    }));
    continuity.retainTicket();
    const first = continuity.open();
    const firstEvents: string[] = [];
    first.onEvent?.((event) => firstEvents.push(event.eventId));
    await first.request(envelope("workspace/list", {}));
    emit?.({
      version: 1,
      eventId: "event-1",
      cursor: "1",
      type: "turn/started",
      payload: { threadId: "side-1" },
    });
    expect(firstEvents).toEqual(["event-1"]);

    const second = continuity.open();
    const replayed: string[] = [];
    second.onEvent?.((event) => replayed.push(event.eventId));
    expect(replayed).toEqual(["event-1"]);
    expect(continuity.acknowledgeEvent("event-1")).toBe(true);

    const third = continuity.open();
    const afterAck: string[] = [];
    third.onEvent?.((event) => afterAck.push(event.eventId));
    expect(afterAck).toEqual([]);
    await first.close?.();
    await second.close?.();
    await third.close?.();
    continuity.releaseTicket();
  });

  it("emits a versioned gap instead of silently dropping buffered events", async () => {
    let emit: ((event: EventEnvelope) => void) | undefined;
    const continuity = new AuthenticatedGatewaySessionContinuity(async () => ({
      request: async () => "ok",
      onEvent: (listener: (event: EventEnvelope) => void) => {
        emit = listener;
        return () => undefined;
      },
      shouldRetainAcrossReconnect: () => true,
    }));
    continuity.retainTicket();
    const transport = continuity.open();
    const events: EventEnvelope[] = [];
    transport.onEvent?.((event) => events.push(event));
    await transport.request(envelope("workspace/list", {}));
    for (let index = 0; index <= 4_096; index += 1) {
      emit?.({
        version: 1,
        eventId: `event-${index}`,
        cursor: String(index),
        type: "item/agentMessage/delta",
        payload: { threadId: "side-1", delta: "x" },
      });
    }
    expect(events.at(-1)).toMatchObject({
      type: "gateway/session/continuity-overflow",
      payload: { version: 1, reason: "buffer-limit", threadId: "side-1" },
    });
    await transport.close?.();
    continuity.releaseTicket();
  });

  it("opens app-server live validation only for an ephemeral fork replay", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const binding = sessionBinding();
    const ticket = registry.issueResumeTicket(
      registry.captureGeneration(),
      binding,
    )!;
    const validateDurableResult = vi.fn(async () => undefined);
    const createInner = vi.fn(async () => ({
      request: async () => "unused",
      validateDurableResult,
    }));
    const session = new AuthenticatedGatewaySession({
      createInner,
      passkeys: { count: vi.fn(async () => 1) } as unknown as PasskeyRegistry,
      newlyPaired: false,
      resumeToken: ticket,
      resumeAuthenticatedSession: (token, revoke) =>
        registry.resume(token, binding, revoke),
    });

    await session.validateDurableResult(
      envelope("turn/start", { threadId: "thread-1" }),
      { turn: { id: "turn-1" } },
    );
    expect(createInner).not.toHaveBeenCalled();

    const forkRequest = envelope("thread/fork", {
      threadId: "thread-1",
      ephemeral: true,
    });
    const forkResult = { thread: { id: "side-1", ephemeral: true } };
    await session.validateDurableResult(forkRequest, forkResult);
    expect(createInner).toHaveBeenCalledOnce();
    expect(validateDurableResult).toHaveBeenCalledWith(forkRequest, forkResult);
  });

  it("gates Codex requests until a newly paired device registers a Passkey", async () => {
    const request = vi.fn(async () => "codex-result");
    const createInner = vi.fn(async () => ({ request }));
    const passkeys = {
      count: vi.fn(async () => 0),
      registrationOptions: vi.fn(async () => ({ challenge: "challenge-1" })),
      verifyRegistration: vi.fn(async () => ({
        recoveryCodes: ["RECOVERY-CODE"],
      })),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner,
      passkeys,
      newlyPaired: true,
    });

    await expect(
      session.request(envelope("workspace/list", {})),
    ).rejects.toThrow("Passkey authentication required");
    expect(createInner).not.toHaveBeenCalled();
    await expect(
      session.request(envelope("auth/register/options", {})),
    ).resolves.toEqual({ challenge: "challenge-1" });
    await expect(
      session.request(envelope("auth/register/verify", { response: {} })),
    ).resolves.toEqual({
      authenticated: true,
      recoveryCodes: ["RECOVERY-CODE"],
    });
    expect(passkeys.verifyRegistration).toHaveBeenCalledWith(
      {},
      "challenge-1",
      {
        replaceExisting: false,
        issueRecoveryCodes: true,
        requireNoExistingPasskey: true,
      },
    );
    expect(createInner).not.toHaveBeenCalled();
    await expect(session.request(envelope("workspace/list", {}))).resolves.toBe(
      "codex-result",
    );
    expect(createInner).toHaveBeenCalledOnce();
  });

  it("rejects an expired registration challenge without verifying it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
      const verifyRegistration = vi.fn(async () => ({ recoveryCodes: [] }));
      const passkeys = {
        count: vi.fn(async () => 0),
        registrationOptions: vi.fn(async () => ({ challenge: "challenge-1" })),
        verifyRegistration,
      } as unknown as PasskeyRegistry;
      const session = new AuthenticatedGatewaySession({
        createInner: async () => ({ request: async () => "ok" }),
        passkeys,
        newlyPaired: true,
      });

      await session.request(envelope("auth/register/options", {}));
      vi.advanceTimersByTime(5 * 60_000);

      await expect(
        session.request(envelope("auth/register/verify", { response: {} })),
      ).rejects.toThrow("Passkey registration challenge has expired");
      expect(verifyRegistration).not.toHaveBeenCalled();
      await expect(
        session.request(envelope("auth/register/verify", { response: {} })),
      ).rejects.toThrow("challenge is missing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an expired authentication challenge without verifying it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
      const verifyAuthentication = vi.fn(async () => undefined);
      const passkeys = {
        count: vi.fn(async () => 1),
        authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
        verifyAuthentication,
      } as unknown as PasskeyRegistry;
      const session = new AuthenticatedGatewaySession({
        createInner: async () => ({ request: async () => "ok" }),
        passkeys,
        newlyPaired: false,
      });

      await session.request(envelope("auth/login/options", {}));
      vi.advanceTimersByTime(5 * 60_000);

      await expect(
        session.request(
          envelope("auth/login/verify", { response: { id: "passkey" } }),
        ),
      ).rejects.toThrow("Passkey authentication challenge has expired");
      expect(verifyAuthentication).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles setup requests without creating a Codex session", async () => {
    const createInner = vi.fn(async () => ({ request: async () => "codex" }));
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner,
      passkeys,
      newlyPaired: false,
      handleAuthenticatedRequest: async (request) =>
        request.method === "setup/status"
          ? { handled: true, value: { codexInstalled: false } }
          : { handled: false },
    });
    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await expect(
      session.request(envelope("setup/status", {})),
    ).resolves.toEqual({ codexInstalled: false });
    expect(createInner).not.toHaveBeenCalled();
  });

  it("retries a failed lazy Codex session without reauthenticating", async () => {
    const request = vi.fn(async () => "codex-result");
    const createInner = vi
      .fn<() => Promise<{ request: typeof request }>>()
      .mockRejectedValueOnce(new Error("app-server unavailable"))
      .mockResolvedValue({ request });
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner,
      passkeys,
      newlyPaired: false,
    });

    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await expect(session.request(envelope("thread/list", {}))).rejects.toThrow(
      "app-server unavailable",
    );
    await expect(session.request(envelope("thread/list", {}))).resolves.toBe(
      "codex-result",
    );
    expect(createInner).toHaveBeenCalledTimes(2);
    expect(passkeys.authenticationOptions).toHaveBeenCalledOnce();
    expect(passkeys.verifyAuthentication).toHaveBeenCalledOnce();
  });

  it("replaces a lazy Codex session after its transport closes", async () => {
    let closeFirst: (() => void) | undefined;
    const cleanupFirst = vi.fn(async () => undefined);
    const firstRequest = vi.fn(async () => "first");
    const secondRequest = vi.fn(async () => "second");
    const createInner = vi
      .fn()
      .mockResolvedValueOnce({
        request: firstRequest,
        onClose: (listener: () => void) => {
          closeFirst = listener;
          return () => {
            closeFirst = undefined;
          };
        },
        close: cleanupFirst,
      })
      .mockResolvedValueOnce({ request: secondRequest });
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner,
      passkeys,
      newlyPaired: false,
    });

    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await expect(session.request(envelope("thread/list", {}))).resolves.toBe(
      "first",
    );
    closeFirst?.();
    await vi.waitFor(() => expect(cleanupFirst).toHaveBeenCalledOnce());
    await expect(session.request(envelope("thread/list", {}))).resolves.toBe(
      "second",
    );
    expect(createInner).toHaveBeenCalledTimes(2);
  });

  it("answers an authenticated health check without creating a Codex session", async () => {
    const createInner = vi.fn(async () => ({ request: async () => "codex" }));
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner,
      passkeys,
      newlyPaired: false,
    });

    await expect(session.request(envelope("host/ping", {}))).rejects.toThrow(
      "Passkey authentication required",
    );
    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await expect(session.request(envelope("host/ping", {}))).resolves.toEqual(
      expect.objectContaining({ version: 1, ok: true }),
    );
    expect(createInner).not.toHaveBeenCalled();
  });

  it("forwards setup progress only after authentication", async () => {
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner: async () => ({ request: async () => "codex" }),
      passkeys,
      newlyPaired: false,
      handleAuthenticatedRequest: async (request, emitEvent) => {
        if (request.method !== "setup/codex/install") return { handled: false };
        emitEvent({
          version: 1,
          eventId: "progress-1",
          cursor: "setup:1",
          type: "setup/codex/install/progress",
          payload: {
            version: 1,
            operationId: "install-1",
            phase: "installing",
          },
        });
        return { handled: true, value: { installed: true } };
      },
    });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));

    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await session.request(envelope("setup/codex/install", {}));

    expect(events).toEqual(["setup/codex/install/progress"]);
  });

  it("enrolls a remembered device only after Passkey verification", async () => {
    const onAuthenticated = vi.fn(async () => undefined);
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner: async () => ({ request: async () => "ok" }),
      passkeys,
      newlyPaired: false,
      onAuthenticated,
    });
    await session.request(
      envelope("auth/login/options", { discoverable: true }),
    );
    expect(onAuthenticated).not.toHaveBeenCalled();
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(passkeys.authenticationOptions).toHaveBeenCalledWith(true);
  });

  it("uses a one-time recovery code before replacing Passkeys", async () => {
    const onCredentialsRecovered = vi.fn();
    const verifyRegistration = vi.fn(async () => ({
      recoveryCodes: ["NEW-CODE"],
    }));
    const passkeys = {
      count: vi.fn(async () => 1),
      authorizeRecovery: vi.fn(async () => ({
        kind: "recovery-code" as const,
        code: "OLD-CODE",
      })),
      registrationOptions: vi.fn(async () => ({ challenge: "replacement" })),
      verifyRegistration,
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok" },
      passkeys,
      newlyPaired: false,
      onCredentialsRecovered,
    });
    await session.request(envelope("auth/recover", { code: "OLD-CODE" }));
    await session.request(envelope("auth/register/options", {}));
    await expect(
      session.request(envelope("auth/register/options", {})),
    ).rejects.toThrow("Passkey registration is not allowed");
    await session.request(
      envelope("auth/register/verify", { response: { id: "new" } }),
    );
    expect(verifyRegistration).toHaveBeenCalledWith(
      { id: "new" },
      "replacement",
      {
        replaceExisting: true,
        issueRecoveryCodes: true,
        recoveryAuthorization: {
          kind: "recovery-code",
          code: "OLD-CODE",
        },
      },
    );
    expect(onCredentialsRecovered).toHaveBeenCalledOnce();
  });

  it("expires and consumes an unauthenticated recovery authorization", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
    const registrationOptions = vi.fn(async () => ({
      challenge: "replacement",
    }));
    const passkeys = {
      count: vi.fn(async () => 1),
      authorizeRecovery: vi.fn(async () => ({
        kind: "recovery-code" as const,
        code: "OLD-CODE",
      })),
      registrationOptions,
    } as unknown as PasskeyRegistry;
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok" },
      passkeys,
      newlyPaired: false,
    });

    await session.request(envelope("auth/recover", { code: "OLD-CODE" }));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(
      session.request(envelope("auth/register/options", {})),
    ).rejects.toThrow("Recovery authorization has expired");
    await expect(
      session.request(envelope("auth/register/options", {})),
    ).rejects.toThrow("Passkey registration is not allowed");
    expect(registrationOptions).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears pending unauthenticated authentication state on close", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok", close },
      passkeys: {
        count: vi.fn(async () => 1),
        authorizeRecovery: vi.fn(async () => ({
          kind: "recovery-code" as const,
          code: "OLD-CODE",
        })),
      } as unknown as PasskeyRegistry,
      passwords: {
        startLogin: vi.fn(async () => ({
          serverLoginState: "server-state",
          loginResponse: "login-response",
        })),
      } as unknown as PasswordRegistry,
      opaqueIdentifiers: { client: "unix:1003", server: "host-key" },
      newlyPaired: false,
    });

    await session.request(envelope("auth/recover", { code: "OLD-CODE" }));
    await session.request(
      envelope("auth/password/login/start", {
        startLoginRequest: "client-start",
      }),
    );
    expect(vi.getTimerCount()).toBe(1);

    await session.close();

    expect(vi.getTimerCount()).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not restore a recovery authorization that resolves after close", async () => {
    vi.useFakeTimers();
    const authorization = deferred<{
      kind: "recovery-code";
      code: string;
    }>();
    const authorizeRecovery = vi.fn(() => authorization.promise);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok" },
      passkeys: {
        count: vi.fn(async () => 1),
        authorizeRecovery,
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
    });

    const recovering = session.request(
      envelope("auth/recover", { code: "OLD-CODE" }),
    );
    expect(authorizeRecovery).toHaveBeenCalledOnce();
    await session.close();
    authorization.resolve({ kind: "recovery-code", code: "OLD-CODE" });

    await expect(recovering).rejects.toThrow("invalidated");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restore an authentication challenge that resolves after close", async () => {
    vi.useFakeTimers();
    const options = deferred<{ challenge: string }>();
    const authenticationOptions = vi.fn(() => options.promise);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok" },
      passkeys: {
        count: vi.fn(async () => 1),
        authenticationOptions,
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
    });

    const starting = session.request(envelope("auth/login/options", {}));
    expect(authenticationOptions).toHaveBeenCalledOnce();
    await session.close();
    options.resolve({ challenge: "late-login" });

    await expect(starting).rejects.toThrow("invalidated");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restore a registration challenge that resolves after revoke", async () => {
    vi.useFakeTimers();
    const options = deferred<{ challenge: string }>();
    let revoke: (() => void) | undefined;
    const registrationOptions = vi.fn(() => options.promise);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok" },
      passkeys: {
        count: vi.fn(async () => 1),
        authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
        verifyAuthentication: vi.fn(async () => undefined),
        registrationOptions,
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
      captureAuthenticationGeneration: () => 0,
      registerAuthenticatedSession: (_generation, callback) => {
        revoke = callback;
        return () => undefined;
      },
    });
    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );

    const starting = session.request(envelope("auth/register/options", {}));
    expect(registrationOptions).toHaveBeenCalledOnce();
    revoke?.();
    options.resolve({ challenge: "late-registration" });

    await expect(starting).rejects.toThrow("invalidated");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restore OPAQUE login state that resolves after close", async () => {
    vi.useFakeTimers();
    const started = deferred<{
      serverLoginState: string;
      loginResponse: string;
    }>();
    const startLogin = vi.fn(() => started.promise);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok" },
      passkeys: {
        count: vi.fn(async () => 1),
      } as unknown as PasskeyRegistry,
      passwords: { startLogin } as unknown as PasswordRegistry,
      opaqueIdentifiers: { client: "unix:1003", server: "host-key" },
      newlyPaired: false,
    });

    const starting = session.request(
      envelope("auth/password/login/start", {
        startLoginRequest: "client-start",
      }),
    );
    expect(startLogin).toHaveBeenCalledOnce();
    await session.close();
    started.resolve({
      serverLoginState: "late-server-state",
      loginResponse: "late-login-response",
    });

    await expect(starting).rejects.toThrow("invalidated");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops an authenticated session when recovery revokes it", async () => {
    vi.useFakeTimers();
    let revoke: (() => void) | undefined;
    const close = vi.fn(async () => undefined);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok", close },
      passkeys: {
        count: vi.fn(async () => 1),
        authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
        verifyAuthentication: vi.fn(async () => undefined),
        registrationOptions: vi.fn(async () => ({ challenge: "add" })),
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
      captureAuthenticationGeneration: () => 0,
      registerAuthenticatedSession: (_generation, callback) => {
        revoke = callback;
        return () => undefined;
      },
    });
    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await session.request(envelope("auth/register/options", {}));
    expect(vi.getTimerCount()).toBe(1);
    revoke?.();
    await expect(
      session.request(envelope("workspace/list", {})),
    ).rejects.toThrow("session was revoked");
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an OPAQUE password only after server finalization", async () => {
    const onAuthenticated = vi.fn(async () => undefined);
    const passwords = {
      hasPassword: vi.fn(async () => true),
      startLogin: vi.fn(async () => ({
        serverLoginState: "server-state",
        loginResponse: "login-response",
      })),
      finishLogin: vi.fn(async () => "session-key"),
    } as unknown as PasswordRegistry;
    const session = new AuthenticatedGatewaySession({
      createInner: async () => ({ request: async () => "codex" }),
      passkeys: { count: async () => 1 } as unknown as PasskeyRegistry,
      passwords,
      opaqueIdentifiers: { client: "unix:1003", server: "host-key" },
      newlyPaired: false,
      onAuthenticated,
    });
    await expect(
      session.request(
        envelope("auth/password/login/start", {
          startLoginRequest: "client-start",
        }),
      ),
    ).resolves.toEqual({ loginResponse: "login-response" });
    expect(onAuthenticated).not.toHaveBeenCalled();
    await expect(
      session.request(
        envelope("auth/password/login/finish", {
          finishLoginRequest: "client-finish",
        }),
      ),
    ).resolves.toEqual({ authenticated: true });
    expect(passwords.finishLogin).toHaveBeenCalledWith(
      "server-state",
      "client-finish",
      { client: "unix:1003", server: "host-key" },
    );
    expect(onAuthenticated).toHaveBeenCalledOnce();
    await expect(
      session.request(
        envelope("auth/password/login/finish", {
          finishLoginRequest: "client-finish-again",
        }),
      ),
    ).rejects.toThrow("Password login state is missing");
    expect(passwords.finishLogin).toHaveBeenCalledOnce();
  });

  it("expires and consumes OPAQUE server login state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
    const finishLogin = vi.fn(async () => "session-key");
    const passwords = {
      startLogin: vi.fn(async () => ({
        serverLoginState: "server-state",
        loginResponse: "login-response",
      })),
      finishLogin,
    } as unknown as PasswordRegistry;
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "codex" },
      passkeys: { count: async () => 1 } as unknown as PasskeyRegistry,
      passwords,
      opaqueIdentifiers: { client: "unix:1003", server: "host-key" },
      newlyPaired: false,
    });

    await session.request(
      envelope("auth/password/login/start", {
        startLoginRequest: "client-start",
      }),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    await expect(
      session.request(
        envelope("auth/password/login/finish", {
          finishLoginRequest: "client-finish",
        }),
      ),
    ).rejects.toThrow("Password login state has expired");
    await expect(
      session.request(
        envelope("auth/password/login/finish", {
          finishLoginRequest: "client-finish-again",
        }),
      ),
    ).rejects.toThrow("Password login state is missing");
    expect(finishLogin).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("issues a page ticket once and resumes directly into an authenticated session", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const binding = sessionBinding();
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const options = {
      passkeys,
      newlyPaired: false,
      captureAuthenticationGeneration: () => registry.captureGeneration(),
      registerAuthenticatedSession: (generation: number, revoke: () => void) =>
        registry.register(generation, binding, revoke),
      resumeAuthenticatedSession: (token: string, revoke: () => void) =>
        registry.resume(token, binding, revoke),
      issueResumeTicket: (generation: number) =>
        registry.issueResumeTicket(generation, binding),
    };
    const authenticated = new AuthenticatedGatewaySession({
      ...options,
      inner: { request: async () => "first" },
    });
    await authenticated.request(envelope("auth/login/options", {}));
    const result = await authenticated.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    expect(result).toMatchObject({
      authenticated: true,
      resumeToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    const resumeToken = (result as { resumeToken: string }).resumeToken;
    await expect(
      authenticated.request(envelope("auth/status", {})),
    ).resolves.not.toHaveProperty("resumeToken");

    const resumed = new AuthenticatedGatewaySession({
      ...options,
      resumeToken,
      inner: { request: async () => "resumed" },
    });
    await expect(resumed.request(envelope("workspace/list", {}))).resolves.toBe(
      "resumed",
    );
    expect(passkeys.authenticationOptions).toHaveBeenCalledOnce();

    await registry.revokeAll();
    await expect(
      resumed.request(envelope("workspace/list", {})),
    ).rejects.toThrow("session was revoked");
  });

  it("hands the live app-server subscription to a silently resumed transport", async () => {
    let innerListener: ((event: EventEnvelope) => void) | undefined;
    const closeInner = vi.fn(async () => undefined);
    const connectInner = vi.fn(async () => ({
      request: async () => "shared",
      onEvent: (listener: (event: EventEnvelope) => void) => {
        innerListener = listener;
        return () => {
          innerListener = undefined;
        };
      },
      shouldRetainAcrossReconnect: () => true,
      close: closeInner,
    }));
    const registry =
      new AuthenticatedSessionRegistry<AuthenticatedGatewaySessionContinuity>({
        onResumeTicketDeleted: (continuity) => continuity.releaseTicket(),
      });
    const binding = sessionBinding();
    const passkeys = {
      count: vi.fn(async () => 1),
      authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
      verifyAuthentication: vi.fn(async () => undefined),
    } as unknown as PasskeyRegistry;
    const sessionOptions = {
      passkeys,
      newlyPaired: false,
      captureAuthenticationGeneration: () => registry.captureGeneration(),
      registerAuthenticatedSession: (generation: number, revoke: () => void) =>
        registry.register(generation, binding, revoke),
      resumeAuthenticatedSession: (token: string, revoke: () => void) => {
        const resumed = registry.resume(token, binding, revoke);
        return resumed
          ? { ...resumed, continuity: resumed.metadata }
          : undefined;
      },
      issueResumeTicket: (
        generation: number,
        continuity: AuthenticatedGatewaySessionContinuity,
      ) => {
        continuity.retainTicket();
        const token = registry.issueResumeTicket(
          generation,
          binding,
          continuity,
        );
        if (!token) continuity.releaseTicket();
        return token;
      },
      releaseResumeTickets: (
        continuity: AuthenticatedGatewaySessionContinuity,
      ) => registry.releaseResumeTickets(continuity),
    };
    const first = new AuthenticatedGatewaySession({
      ...sessionOptions,
      createInner: connectInner,
    });
    await first.request(envelope("auth/login/options", {}));
    const authenticated = (await first.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    )) as { resumeToken: string };
    await expect(first.request(envelope("workspace/list", {}))).resolves.toBe(
      "shared",
    );
    const staleTransportEvents: string[] = [];
    first.onEvent((event) => staleTransportEvents.push(event.type));

    expect(closeInner).not.toHaveBeenCalled();
    const resumed = new AuthenticatedGatewaySession({
      ...sessionOptions,
      resumeToken: authenticated.resumeToken,
      createInner: async () => {
        throw new Error("resumed transport must reuse the original client");
      },
    });
    // The valid resume has already displaced the old half-open transport, but
    // the new encrypted handshake has not installed its listener yet.
    innerListener?.({
      version: 1,
      eventId: "side-gap-delta",
      cursor: "1",
      type: "item/agentMessage/delta",
      payload: { threadId: "side-thread", delta: "during reconnect" },
    });
    expect(staleTransportEvents).toEqual([]);
    const events: string[] = [];
    resumed.onEvent((event) => events.push(event.type));
    innerListener?.({
      version: 1,
      eventId: "side-completed",
      cursor: "2",
      type: "turn/completed",
      payload: { threadId: "side-thread" },
    });

    await expect(resumed.request(envelope("workspace/list", {}))).resolves.toBe(
      "shared",
    );
    expect(connectInner).toHaveBeenCalledOnce();
    expect(events).toEqual(["item/agentMessage/delta", "turn/completed"]);
    await expect(first.request(envelope("workspace/list", {}))).rejects.toThrow(
      "superseded",
    );
    await first.close();

    await expect(
      resumed.request(envelope("auth/session/release", {})),
    ).resolves.toEqual({ released: 1 });
    expect(closeInner).not.toHaveBeenCalled();
    await resumed.close();
    expect(closeInner).toHaveBeenCalledOnce();
    expect(
      registry.resume(authenticated.resumeToken, binding, vi.fn()),
    ).toBeUndefined();
  });

  it("rejects an invalid resume ticket before invoking WebAuthn", () => {
    const authenticationOptions = vi.fn(async () => ({ challenge: "login" }));
    expect(
      () =>
        new AuthenticatedGatewaySession({
          inner: { request: async () => "never" },
          passkeys: {
            count: vi.fn(async () => 1),
            authenticationOptions,
          } as unknown as PasskeyRegistry,
          newlyPaired: false,
          resumeToken: "A".repeat(43),
          resumeAuthenticatedSession: () => undefined,
        }),
    ).toThrow("REAUTH_REQUIRED");
    expect(authenticationOptions).not.toHaveBeenCalled();
  });

  it("stops remembered-session events after background trust revocation without a client RPC", async () => {
    vi.useFakeTimers();
    const registry = new AuthenticatedSessionRegistry();
    const binding = { ...sessionBinding(), rememberedDevice: true };
    const ticket = registry.issueResumeTicket(
      registry.captureGeneration(),
      binding,
    )!;
    let innerListener: ((event: EventEnvelope) => void) | undefined;
    const unsubscribe = vi.fn(() => {
      innerListener = undefined;
    });
    const close = vi.fn(async () => undefined);
    let revoked = false;
    const session = new AuthenticatedGatewaySession({
      inner: {
        request: async () => "ok",
        onEvent: (listener) => {
          innerListener = listener;
          return unsubscribe;
        },
        close,
      },
      passkeys: { count: vi.fn(async () => 1) } as unknown as PasskeyRegistry,
      newlyPaired: false,
      resumeToken: ticket,
      resumeAuthenticatedSession: (token, revoke) =>
        registry.resume(token, binding, revoke),
      assertAuthenticatedSessionCurrent: async () => {
        if (!revoked) return;
        await registry.revokeDevice(binding);
        throw new Error("Device was revoked");
      },
      authenticationRecheckMs: 100,
    });
    const events: string[] = [];
    session.onEvent((event) => events.push(event.type));
    innerListener?.({
      version: 1,
      eventId: "before",
      cursor: "1",
      type: "turn/started",
      payload: {},
    });

    revoked = true;
    await vi.advanceTimersByTimeAsync(100);
    innerListener?.({
      version: 1,
      eventId: "after",
      cursor: "2",
      type: "turn/completed",
      payload: {},
    });

    expect(events).toEqual(["turn/started"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not authenticate an old challenge across credential recovery", async () => {
    const registry = new AuthenticatedSessionRegistry();
    let releaseVerification: (() => void) | undefined;
    const verificationPending = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    let verificationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      verificationStarted = resolve;
    });
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "never" },
      passkeys: {
        count: vi.fn(async () => 1),
        authenticationOptions: vi.fn(async () => ({ challenge: "old" })),
        verifyAuthentication: vi.fn(async () => {
          verificationStarted?.();
          await verificationPending;
        }),
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
      captureAuthenticationGeneration: () => registry.captureGeneration(),
      registerAuthenticatedSession: (generation, revoke) =>
        registry.register(generation, sessionBinding(), revoke),
      issueResumeTicket: (generation) =>
        registry.issueResumeTicket(generation, sessionBinding()),
    });
    await session.request(envelope("auth/login/options", {}));
    const verifying = session.request(
      envelope("auth/login/verify", { response: { id: "old-passkey" } }),
    );
    await started;
    await registry.revokeAll();
    releaseVerification?.();

    await expect(verifying).rejects.toThrow("invalidated");
    await expect(
      session.request(envelope("workspace/list", {})),
    ).rejects.toThrow("session was revoked");
  });

  it("rolls back remembered-device enrollment if recovery wins the race", async () => {
    const registry = new AuthenticatedSessionRegistry();
    let releaseEnrollment: (() => void) | undefined;
    const enrollmentPending = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    let enrollmentStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      enrollmentStarted = resolve;
    });
    const rollback = vi.fn(async () => undefined);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "never" },
      passkeys: {
        count: vi.fn(async () => 1),
        authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
        verifyAuthentication: vi.fn(async () => undefined),
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
      captureAuthenticationGeneration: () => registry.captureGeneration(),
      registerAuthenticatedSession: (generation, revoke) =>
        registry.register(generation, sessionBinding(), revoke),
      issueResumeTicket: (generation) =>
        registry.issueResumeTicket(generation, sessionBinding()),
      runCredentialMutation: (expected, operation, options) =>
        registry.runCredentialMutation(expected, operation, options),
      onAuthenticated: async () => {
        enrollmentStarted?.();
        await enrollmentPending;
        return rollback;
      },
    });
    await session.request(envelope("auth/login/options", {}));
    const verifying = session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    await started;
    const recovery = registry.revokeAll();
    releaseEnrollment?.();
    await recovery;

    await expect(verifying).rejects.toThrow("invalidated");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it.each(["add-passkey", "rotate-recovery-code", "set-password"] as const)(
    "blocks an old authenticated %s mutation after recovery commits",
    async (kind) => {
      const registry = new AuthenticatedSessionRegistry();
      const binding = sessionBinding();
      const generation = registry.captureGeneration();
      const ticket = registry.issueResumeTicket(generation, binding)!;
      const verifyRegistration = vi.fn(async () => ({ recoveryCodes: [] }));
      const rotateRecoveryCodes = vi.fn(async () => ["ROTATED"]);
      const saveRegistrationRecord = vi.fn(async () => undefined);
      const session = new AuthenticatedGatewaySession({
        inner: { request: async () => "never" },
        passkeys: {
          count: vi.fn(async () => 1),
          registrationOptions: vi.fn(async () => ({ challenge: "add" })),
          verifyRegistration,
          rotateRecoveryCodes,
        } as unknown as PasskeyRegistry,
        passwords: {
          hasPassword: vi.fn(async () => true),
          createRegistrationResponse: vi.fn(async () => "registration"),
          saveRegistrationRecord,
        } as unknown as PasswordRegistry,
        newlyPaired: false,
        resumeToken: ticket,
        resumeAuthenticatedSession: (token, revoke) =>
          registry.resume(token, binding, revoke),
        runCredentialMutation: (expected, operation, options) =>
          registry.runCredentialMutation(expected, operation, options),
      });
      if (kind === "add-passkey")
        await session.request(envelope("auth/register/options", {}));
      if (kind === "set-password")
        await session.request(
          envelope("auth/password/register/start", {
            registrationRequest: "start",
          }),
        );

      let releaseRecovery: (() => void) | undefined;
      const recoveryPending = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      let markRecoveryStarted: (() => void) | undefined;
      const recoveryStarted = new Promise<void>((resolve) => {
        markRecoveryStarted = resolve;
      });
      const recovery = registry.runCredentialMutation(
        generation,
        async () => {
          markRecoveryStarted?.();
          await recoveryPending;
        },
        { revokeAllAfter: true },
      );
      await recoveryStarted;
      const mutation =
        kind === "add-passkey"
          ? session.request(
              envelope("auth/register/verify", {
                response: { id: "new-passkey" },
              }),
            )
          : kind === "rotate-recovery-code"
            ? session.request(envelope("auth/recovery/rotate", {}))
            : session.request(
                envelope("auth/password/register/finish", {
                  registrationRecord: "record",
                }),
              );
      releaseRecovery?.();
      await recovery;

      await expect(mutation).rejects.toThrow(/invalidated|revoked/iu);
      expect(verifyRegistration).not.toHaveBeenCalled();
      expect(rotateRecoveryCodes).not.toHaveBeenCalled();
      expect(saveRegistrationRecord).not.toHaveBeenCalled();
    },
  );
});

function envelope(method: string, payload: unknown): RequestEnvelope {
  return {
    version: 1,
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    method,
    payload,
  };
}

function sessionBinding() {
  return {
    principal: "user" as const,
    nodeId: "node-1",
    userId: "unix:1003",
    deviceId: "browser-1",
    devicePublicKey: "A".repeat(43),
    rememberedDevice: false,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
