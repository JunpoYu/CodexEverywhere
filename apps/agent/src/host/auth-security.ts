export type AuthenticationAttemptKind = "password" | "recovery";

export class AuthenticationRateLimiter {
  readonly #attempts = new Map<AuthenticationAttemptKind, number[]>();

  consume(kind: AuthenticationAttemptKind, now = Date.now()): void {
    const policy =
      kind === "recovery"
        ? { limit: 10, windowMs: 5 * 60_000 }
        : { limit: 20, windowMs: 5 * 60_000 };
    const recent = (this.#attempts.get(kind) ?? []).filter(
      (attempt) => now - attempt < policy.windowMs,
    );
    if (recent.length >= policy.limit) {
      throw new Error(`Too many ${kind} attempts. Wait before trying again.`);
    }
    recent.push(now);
    this.#attempts.set(kind, recent);
  }
}

export class AuthenticatedSessionRegistry {
  readonly #revoke = new Set<() => void>();

  register(revoke: () => void): () => void {
    this.#revoke.add(revoke);
    return () => this.#revoke.delete(revoke);
  }

  revokeAll(): void {
    const sessions = [...this.#revoke];
    this.#revoke.clear();
    for (const revoke of sessions) revoke();
  }
}
