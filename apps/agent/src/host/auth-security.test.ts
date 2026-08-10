import { describe, expect, it, vi } from "vitest";

import {
  AuthenticatedSessionRegistry,
  AuthenticationRateLimiter,
} from "./auth-security.js";

describe("AuthenticationRateLimiter", () => {
  it("keeps recovery limits across gateway connections", () => {
    const limiter = new AuthenticationRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.consume("recovery", 1_000 + attempt);
    }
    expect(() => limiter.consume("recovery", 2_000)).toThrow(
      "Too many recovery attempts",
    );
    expect(() => limiter.consume("recovery", 5 * 60_000 + 2_000)).not.toThrow();
  });
});

describe("AuthenticatedSessionRegistry", () => {
  it("revokes every active Web session after credential recovery", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const binding = sessionBinding();
    const generation = registry.captureGeneration();
    registry.register(generation, binding, first);
    registry.register(generation, binding, second);
    await registry.revokeAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    await registry.revokeAll();
    expect(first).toHaveBeenCalledOnce();
  });

  it("binds reusable resume tickets and atomically registers resumed sessions", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const binding = sessionBinding();
    const ticket = registry.issueResumeTicket(
      registry.captureGeneration(),
      binding,
    )!;
    const first = vi.fn();
    const second = vi.fn();

    expect(Buffer.from(ticket, "base64url")).toHaveLength(32);
    expect(registry.resume(ticket, binding, first)).toBeDefined();
    expect(registry.resume(ticket, binding, second)).toBeDefined();

    await registry.revokeAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(registry.resume(ticket, binding, vi.fn())).toBeUndefined();
  });

  it("rejects a resume ticket outside its complete Noise identity binding", () => {
    const registry = new AuthenticatedSessionRegistry();
    const binding = sessionBinding();
    const ticket = registry.issueResumeTicket(
      registry.captureGeneration(),
      binding,
    )!;
    const mismatches = [
      { ...binding, principal: "host-admin" as const },
      { ...binding, nodeId: "node-2" },
      { ...binding, userId: "unix:1004" },
      { ...binding, deviceId: "browser-2" },
      { ...binding, devicePublicKey: "B".repeat(43) },
    ];
    for (const mismatch of mismatches) {
      expect(registry.resume(ticket, mismatch, vi.fn())).toBeUndefined();
    }
    expect(registry.resume(ticket, binding, vi.fn())).toBeDefined();
  });

  it("keeps independent page tickets for one device and enforces a hard cap", () => {
    const registry = new AuthenticatedSessionRegistry({ maxResumeTickets: 2 });
    const firstBinding = sessionBinding();
    const generation = registry.captureGeneration();
    const first = registry.issueResumeTicket(generation, firstBinding)!;
    const secondPage = registry.issueResumeTicket(generation, firstBinding)!;
    expect(registry.resume(first, firstBinding, vi.fn())).toBeDefined();
    expect(registry.resume(secondPage, firstBinding, vi.fn())).toBeDefined();

    const secondBinding = { ...firstBinding, deviceId: "browser-2" };
    const newest = registry.issueResumeTicket(generation, secondBinding)!;
    expect(registry.resume(first, firstBinding, vi.fn())).toBeUndefined();
    expect(registry.resume(secondPage, firstBinding, vi.fn())).toBeDefined();
    expect(registry.resume(newest, secondBinding, vi.fn())).toBeDefined();
  });

  it("rejects stale registration and ticket issuance after recovery", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const staleGeneration = registry.captureGeneration();
    await registry.revokeAll();

    expect(
      registry.register(staleGeneration, sessionBinding(), vi.fn()),
    ).toBeUndefined();
    expect(
      registry.issueResumeTicket(staleGeneration, sessionBinding()),
    ).toBeUndefined();
  });

  it("refreshes a resumed page in the global eviction order", () => {
    const registry = new AuthenticatedSessionRegistry({ maxResumeTickets: 2 });
    const generation = registry.captureGeneration();
    const firstBinding = sessionBinding();
    const secondBinding = { ...firstBinding, deviceId: "browser-2" };
    const thirdBinding = { ...firstBinding, deviceId: "browser-3" };
    const first = registry.issueResumeTicket(generation, firstBinding)!;
    const second = registry.issueResumeTicket(generation, secondBinding)!;

    expect(registry.resume(first, firstBinding, vi.fn())).toBeDefined();
    const third = registry.issueResumeTicket(generation, thirdBinding)!;

    expect(registry.resume(first, firstBinding, vi.fn())).toBeDefined();
    expect(registry.resume(second, secondBinding, vi.fn())).toBeUndefined();
    expect(registry.resume(third, thirdBinding, vi.fn())).toBeDefined();
  });

  it("bounds the number of independent page tickets for one device", () => {
    const registry = new AuthenticatedSessionRegistry({
      maxResumeTickets: 100,
    });
    const binding = sessionBinding();
    const generation = registry.captureGeneration();
    const tickets = Array.from({ length: 17 }, () =>
      registry.issueResumeTicket(generation, binding),
    ) as string[];

    expect(registry.resume(tickets[0]!, binding, vi.fn())).toBeUndefined();
    expect(registry.resume(tickets[1]!, binding, vi.fn())).toBeDefined();
    expect(registry.resume(tickets[16]!, binding, vi.fn())).toBeDefined();
  });

  it("revokes only remembered continuations for a revoked device identity", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const remembered = sessionBinding();
    const temporary = { ...remembered, rememberedDevice: false };
    const generation = registry.captureGeneration();
    const rememberedTicket = registry.issueResumeTicket(
      generation,
      remembered,
    )!;
    const temporaryTicket = registry.issueResumeTicket(generation, temporary)!;
    const rememberedSessionRevoked = vi.fn();
    const temporarySessionRevoked = vi.fn();
    registry.register(generation, remembered, rememberedSessionRevoked);
    registry.register(generation, temporary, temporarySessionRevoked);

    await registry.revokeDevice(remembered);

    expect(rememberedSessionRevoked).toHaveBeenCalledOnce();
    expect(temporarySessionRevoked).not.toHaveBeenCalled();
    expect(
      registry.resume(rememberedTicket, remembered, vi.fn()),
    ).toBeUndefined();
    expect(registry.resume(temporaryTicket, temporary, vi.fn())).toBeDefined();
  });

  it("serializes credential mutation before recovery and revokes its session afterward", async () => {
    const registry = new AuthenticatedSessionRegistry();
    const binding = sessionBinding();
    const generation = registry.captureGeneration();
    const revoked = vi.fn();
    registry.register(generation, binding, revoked);
    const order: string[] = [];
    let releaseMutation: (() => void) | undefined;
    const mutationPending = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let markMutationStarted: (() => void) | undefined;
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = registry.runCredentialMutation(generation, async () => {
      order.push("mutation");
      markMutationStarted?.();
      await mutationPending;
    });
    await mutationStarted;
    const recovery = registry.runCredentialMutation(
      generation,
      async () => {
        order.push("recovery");
      },
      { revokeAllAfter: true },
    );
    releaseMutation?.();

    await mutation;
    await recovery;
    expect(order).toEqual(["mutation", "recovery"]);
    expect(revoked).toHaveBeenCalledOnce();
  });
});

function sessionBinding() {
  return {
    principal: "user" as const,
    nodeId: "node-1",
    userId: "unix:1003",
    deviceId: "browser-1",
    devicePublicKey: "A".repeat(43),
    rememberedDevice: true,
  };
}
