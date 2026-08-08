import { describe, expect, it, vi } from "vitest";

import type { RequestEnvelope } from "@codex-everywhere/protocol";

import type { PasskeyRegistry } from "../host/passkeys.js";
import type { PasswordRegistry } from "../host/passwords.js";
import { AuthenticatedGatewaySession } from "./authenticated-session.js";

describe("AuthenticatedGatewaySession", () => {
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
    expect(createInner).not.toHaveBeenCalled();
    await expect(session.request(envelope("workspace/list", {}))).resolves.toBe(
      "codex-result",
    );
    expect(createInner).toHaveBeenCalledOnce();
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

  it("stops an authenticated session when recovery revokes it", async () => {
    let revoke: (() => void) | undefined;
    const close = vi.fn(async () => undefined);
    const session = new AuthenticatedGatewaySession({
      inner: { request: async () => "ok", close },
      passkeys: {
        count: vi.fn(async () => 1),
        authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
        verifyAuthentication: vi.fn(async () => undefined),
      } as unknown as PasskeyRegistry,
      newlyPaired: false,
      registerAuthenticatedSession: (callback) => {
        revoke = callback;
        return () => undefined;
      },
    });
    await session.request(envelope("auth/login/options", {}));
    await session.request(
      envelope("auth/login/verify", { response: { id: "passkey" } }),
    );
    revoke?.();
    await expect(
      session.request(envelope("workspace/list", {})),
    ).rejects.toThrow("session was revoked");
    expect(close).toHaveBeenCalledOnce();
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
  });
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
