import { describe, expect, it, vi } from "vitest";
import { GatewayV2Error } from "./errors.js";
import {
  GATEWAY_CAPABILITIES_V2,
  gatewayMethodNames,
  type GatewayMethodName,
} from "./methods.js";
import {
  GatewayV2Router,
  type GatewayMutationMiddleware,
  type GatewayRequestContext,
  type MutationInvocation,
} from "./router.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const operationKey = "22222222-2222-4222-8222-222222222222";

describe("GatewayV2Router", () => {
  it("refuses to seal an incomplete handler registry", () => {
    const router = new GatewayV2Router(testMutationMiddleware());
    router.register("host/ping", () => hostPingResult());
    expect(() => router.seal()).toThrow("Missing Gateway handlers");
  });

  it("seals an access-scoped router without unrelated admin handlers", async () => {
    const router = new GatewayV2Router(testMutationMiddleware());
    for (const method of gatewayMethodNames) {
      if (method.startsWith("admin/")) continue;
      router.register(method, (() => defaultResult(method)) as never);
    }
    router.seal({ access: new Set(["pre-auth", "user"]) });

    const denied = await router.route(
      request("admin/host/status", { version: 1 }),
      context("admin"),
    );
    expect(denied).toMatchObject({
      closeConnection: true,
      response: { ok: false, error: { code: "ACCESS_DENIED" } },
    });
  });

  it("authorizes and validates before calling a handler", async () => {
    const handler = vi.fn(() => ({ version: 1, workspaces: [] }) as const);
    const router = createRouter(testMutationMiddleware(), {
      "workspace/list": handler,
    });

    const denied = await router.route(
      request("workspace/list", { version: 1 }),
      context("pre-auth"),
    );
    expect(denied).toMatchObject({
      closeConnection: true,
      response: { ok: false, error: { code: "ACCESS_DENIED" } },
    });
    expect(handler).not.toHaveBeenCalled();

    const accepted = await router.route(
      request("workspace/list", { version: 1 }),
      context("user"),
    );
    expect(accepted).toMatchObject({
      closeConnection: false,
      response: { ok: true, result: { version: 1, workspaces: [] } },
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("revalidates revocable session credentials before dispatch", async () => {
    const handler = vi.fn(() => hostPingResult());
    const router = createRouter(testMutationMiddleware(), {
      "host/ping": handler,
    });
    const result = await router.route(request("host/ping", { version: 1 }), {
      ...context("user"),
      assertCurrent: () => {
        throw new GatewayV2Error("REAUTH_REQUIRED", "Device was revoked", {
          closeConnection: true,
        });
      },
    });

    expect(result).toMatchObject({
      closeConnection: true,
      response: { ok: false, error: { code: "REAUTH_REQUIRED" } },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs mutation metadata through the unified middleware", async () => {
    const invocations: MutationInvocation[] = [];
    const middleware = testMutationMiddleware(invocations);
    const router = createRouter(middleware, {
      "queue/remove": () => ({ version: 1, removed: true }),
    });

    const result = await router.route(
      request("queue/remove", { version: 1, itemId: "item-1" }, operationKey),
      context("user"),
    );

    expect(result.response).toMatchObject({ ok: true });
    expect(invocations).toEqual([
      {
        method: "queue/remove",
        operationKey,
        idempotency: "durable",
        principalId: "user:test",
        requestId,
        input: { version: 1, itemId: "item-1" },
      },
    ]);
  });

  it("enforces negotiated capabilities", async () => {
    const router = createRouter(testMutationMiddleware());
    const denied = await router.route(
      request(
        "thread/tui/handoff",
        { version: 1, threadId: "thread-1" },
        operationKey,
      ),
      context("user"),
    );
    expect(denied).toMatchObject({
      closeConnection: true,
      response: {
        ok: false,
        error: {
          code: "CAPABILITY_REQUIRED",
          details: { requiredCapability: GATEWAY_CAPABILITIES_V2.tuiHandoff },
        },
      },
    });
  });

  it("does not expose thrown handler messages", async () => {
    const router = createRouter(testMutationMiddleware(), {
      "host/ping": () => {
        throw new Error("secret handler detail");
      },
    });
    const result = await router.route(
      request("host/ping", { version: 1 }),
      context("pre-auth"),
    );
    expect(result.response).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR" },
    });
    expect(JSON.stringify(result.response)).not.toContain(
      "secret handler detail",
    );
  });

  it("closes on malformed requests", async () => {
    const router = createRouter(testMutationMiddleware());
    const result = await router.route(
      { version: 2, requestId, method: "host/ping", input: {} },
      context("pre-auth"),
    );
    expect(result).toMatchObject({
      closeConnection: true,
      response: { ok: false, error: { code: "INVALID_INPUT" } },
    });
  });
});

function createRouter(
  middleware: GatewayMutationMiddleware,
  overrides: Partial<
    Record<GatewayMethodName, (input: unknown) => unknown>
  > = {},
): GatewayV2Router<GatewayRequestContext> {
  const router = new GatewayV2Router<GatewayRequestContext>(middleware);
  for (const method of gatewayMethodNames) {
    const handler = overrides[method] ?? (() => defaultResult(method));
    router.register(method, handler as never);
  }
  return router.seal();
}

function defaultResult(method: GatewayMethodName): unknown {
  if (method === "host/ping") return hostPingResult();
  return { version: 1 };
}

function hostPingResult() {
  return {
    version: 1,
    hostId: "host-1",
    serverTime: "2026-08-16T00:00:00.000Z",
    gatewayApiVersion: 2,
  } as const;
}

function request(
  method: GatewayMethodName,
  input: unknown,
  key?: string,
): unknown {
  return {
    version: 2,
    requestId,
    method,
    input,
    ...(key === undefined ? {} : { operationKey: key }),
  };
}

function context(
  access: GatewayRequestContext["access"],
): GatewayRequestContext {
  return {
    access,
    principalId: `${access}:test`,
    capabilities: new Set(),
    signal: new AbortController().signal,
  };
}

function testMutationMiddleware(
  invocations: MutationInvocation[] = [],
): GatewayMutationMiddleware {
  return {
    async run<Result>(
      invocation: MutationInvocation,
      execute: () => Promise<Result>,
    ) {
      invocations.push(invocation);
      return execute();
    },
  };
}
