import { describe, expect, it } from "vitest";

import { AuthenticationRateLimiter } from "./authentication-rate-limiter.js";

describe("AuthenticationRateLimiter", () => {
  it("keeps failures bounded across physical Gateway sessions", () => {
    const limiter = new AuthenticationRateLimiter({
      password: { limit: 2, windowMs: 1_000 },
    });
    limiter.consume("password", 1_000);
    limiter.consume("password", 1_001);
    expect(() => limiter.consume("password", 1_002)).toThrowError(
      expect.objectContaining({
        code: "AUTHENTICATION_RATE_LIMITED",
        retryable: true,
      }),
    );
    expect(() => limiter.consume("password", 2_001)).not.toThrow();
  });

  it("maintains separate password and recovery budgets", () => {
    const limiter = new AuthenticationRateLimiter({
      password: { limit: 1, windowMs: 10_000 },
      recovery: { limit: 1, windowMs: 10_000 },
    });
    limiter.consume("password", 1);
    limiter.consume("recovery", 1);
    expect(() => limiter.consume("password", 2)).toThrow();
    expect(() => limiter.consume("recovery", 2)).toThrow();
  });
});
