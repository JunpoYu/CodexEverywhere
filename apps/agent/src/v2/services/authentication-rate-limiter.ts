import { GatewayV2Error } from "@codex-everywhere/protocol/v2";

export type AuthenticationAttemptKind = "password" | "recovery";

export interface AuthenticationRateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

const DEFAULT_POLICIES: Readonly<
  Record<AuthenticationAttemptKind, AuthenticationRateLimitPolicy>
> = {
  password: { limit: 20, windowMs: 5 * 60_000 },
  recovery: { limit: 10, windowMs: 5 * 60_000 },
};

/** Per-identity-root limiter shared by every physical Gateway connection. */
export class AuthenticationRateLimiter {
  readonly #attempts = new Map<AuthenticationAttemptKind, number[]>();
  readonly #policies: Readonly<
    Record<AuthenticationAttemptKind, AuthenticationRateLimitPolicy>
  >;

  constructor(
    policies: Partial<
      Record<AuthenticationAttemptKind, AuthenticationRateLimitPolicy>
    > = {},
  ) {
    this.#policies = {
      password: validatePolicy(policies.password ?? DEFAULT_POLICIES.password),
      recovery: validatePolicy(policies.recovery ?? DEFAULT_POLICIES.recovery),
    };
  }

  consume(kind: AuthenticationAttemptKind, now = Date.now()): void {
    const policy = this.#policies[kind];
    const recent = (this.#attempts.get(kind) ?? []).filter(
      (attempt) => now - attempt < policy.windowMs,
    );
    if (recent.length >= policy.limit) {
      throw new GatewayV2Error(
        "AUTHENTICATION_RATE_LIMITED",
        "Too many authentication attempts; wait before trying again",
        { retryable: true },
      );
    }
    recent.push(now);
    this.#attempts.set(kind, recent);
  }
}

function validatePolicy(
  policy: AuthenticationRateLimitPolicy,
): AuthenticationRateLimitPolicy {
  if (
    !Number.isSafeInteger(policy.limit) ||
    policy.limit < 1 ||
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1
  ) {
    throw new Error("Authentication rate-limit policy is invalid");
  }
  return { ...policy };
}
