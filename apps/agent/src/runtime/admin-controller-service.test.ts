import type { RequestEnvelope } from "@codex-everywhere/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthenticatedGatewaySession } from "../gateway/authenticated-session.js";
import { AuthenticatedSessionRegistry } from "../host/auth-security.js";
import type { PasskeyRegistry } from "../host/passkeys.js";
import { AdminGatewaySession } from "./admin-controller-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("AdminGatewaySession authentication freshness", () => {
  it("rejects a dangerous request when a silent resume inherits an old login", async () => {
    const { resumed, createInner, request } =
      await authenticateAndResumeAdminSession(5 * 60_000 + 1);

    expect(createInner).not.toHaveBeenCalled();
    await expect(resumed.request(dangerousRequest())).rejects.toThrow(
      "requires a recent administrator login",
    );
    expect(createInner).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    await resumed.close();
  });

  it("allows a dangerous request when a silent resume inherits a recent login", async () => {
    const { resumed, createInner, request } =
      await authenticateAndResumeAdminSession(4 * 60_000);

    expect(createInner).not.toHaveBeenCalled();
    await expect(resumed.request(dangerousRequest())).resolves.toEqual({
      disabled: true,
    });
    expect(createInner).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "device:admin-browser",
        action: "admin/user/disable",
      }),
    );
    await resumed.close();
  });
});

async function authenticateAndResumeAdminSession(resumeAfterMs: number) {
  vi.useFakeTimers();
  const authenticatedAt = Date.parse("2026-08-10T00:00:00.000Z");
  vi.setSystemTime(authenticatedAt);
  const registry = new AuthenticatedSessionRegistry<{
    authenticatedAt: number;
  }>();
  const binding = {
    principal: "host-admin" as const,
    nodeId: "admin-node",
    userId: "admin:installation",
    deviceId: "admin-browser",
    devicePublicKey: "A".repeat(43),
    rememberedDevice: true,
  };
  const passkeys = {
    count: vi.fn(async () => 1),
    authenticationOptions: vi.fn(async () => ({ challenge: "login" })),
    verifyAuthentication: vi.fn(async () => undefined),
  } as unknown as PasskeyRegistry;
  const request = vi.fn(async () => ({ disabled: true }));

  const createSession = (resumeToken?: string) => {
    let sessionAuthenticatedAt: number | undefined;
    const createInner = vi.fn(async () => {
      if (sessionAuthenticatedAt === undefined)
        throw new Error("Administrator authentication timestamp is missing");
      return new AdminGatewaySession(
        { request },
        "device:admin-browser",
        sessionAuthenticatedAt,
      );
    });
    return {
      createInner,
      session: new AuthenticatedGatewaySession({
        createInner,
        passkeys,
        newlyPaired: false,
        ...(resumeToken ? { resumeToken } : {}),
        captureAuthenticationGeneration: () => registry.captureGeneration(),
        registerAuthenticatedSession: (generation, revoke) =>
          registry.register(generation, binding, revoke),
        resumeAuthenticatedSession: (token, revoke) => {
          const resumed = registry.resume(token, binding, revoke);
          if (resumed)
            sessionAuthenticatedAt = resumed.metadata.authenticatedAt;
          return resumed;
        },
        issueResumeTicket: (generation) => {
          sessionAuthenticatedAt = Date.now();
          return registry.issueResumeTicket(generation, binding, {
            authenticatedAt: sessionAuthenticatedAt,
          });
        },
      }),
    };
  };

  const authenticated = createSession();
  await authenticated.session.request(authenticationRequest("options"));
  const result = await authenticated.session.request(
    authenticationRequest("verify"),
  );
  const resumeToken = (result as { resumeToken?: unknown }).resumeToken;
  if (typeof resumeToken !== "string")
    throw new Error("Expected administrator authentication to issue a ticket");
  expect(authenticated.createInner).not.toHaveBeenCalled();
  await authenticated.session.close();

  vi.setSystemTime(authenticatedAt + resumeAfterMs);
  const resumed = createSession(resumeToken);
  expect(passkeys.authenticationOptions).toHaveBeenCalledOnce();
  return {
    resumed: resumed.session,
    createInner: resumed.createInner,
    request,
  };
}

function authenticationRequest(stage: "options" | "verify"): RequestEnvelope {
  return {
    version: 1,
    requestId: `admin-auth-${stage}`,
    idempotencyKey: `admin-auth-${stage}`,
    method: stage === "options" ? "auth/login/options" : "auth/login/verify",
    payload: stage === "options" ? {} : { response: { id: "passkey" } },
  };
}

function dangerousRequest(): RequestEnvelope {
  return {
    version: 1,
    requestId: "admin-request",
    idempotencyKey: "admin-mutation",
    method: "admin/user/disable",
    payload: { username: "alice", expectedRevision: 1 },
  };
}
