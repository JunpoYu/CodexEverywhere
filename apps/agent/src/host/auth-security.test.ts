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
  it("revokes every active Web session after credential recovery", () => {
    const registry = new AuthenticatedSessionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register(first);
    registry.register(second);
    registry.revokeAll();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    registry.revokeAll();
    expect(first).toHaveBeenCalledOnce();
  });
});
