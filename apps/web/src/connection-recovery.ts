import { isGatewayRequestOutcomeUnknown } from "./gateway-client.js";

export const CONNECTION_RECOVERY_DELAYS_MS = [
  0, 500, 1_000, 2_000, 4_000, 8_000, 30_000,
] as const;

// Keep application data flowing well inside common 60-second reverse-proxy
// idle timeouts. Browsers may suspend a background page; visibility recovery
// still verifies and reconnects immediately when the page resumes.
export const CONNECTION_KEEPALIVE_INTERVAL_MS = 25_000;
export const CONNECTION_KEEPALIVE_TIMEOUT_MS = 15_000;

export function connectionRecoveryDelayMs(attempt: number): number {
  const index = Math.min(
    Math.max(0, Math.trunc(attempt)),
    CONNECTION_RECOVERY_DELAYS_MS.length - 1,
  );
  return CONNECTION_RECOVERY_DELAYS_MS[index] ?? 30_000;
}

export async function reconnectWithUnlimitedAttempts<T>(options: {
  isCurrent(): boolean;
  canAttempt(): boolean;
  reconnect(): T | PromiseLike<T>;
  isRetryable(error: unknown): boolean;
  wait?(delayMs: number): Promise<void>;
  waitForAttempt?(): Promise<void>;
  onBeforeAttempt?(attempt: number, delayMs: number): void;
}): Promise<T | undefined> {
  const wait =
    options.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));
  for (let attempt = 0; ; attempt += 1) {
    if (!options.isCurrent()) return undefined;
    if (!options.canAttempt()) {
      if (!options.waitForAttempt) return undefined;
      await options.waitForAttempt();
      attempt -= 1;
      continue;
    }
    const delayMs = connectionRecoveryDelayMs(attempt);
    options.onBeforeAttempt?.(attempt, delayMs);
    if (delayMs > 0) await wait(delayMs);
    if (!options.isCurrent()) return undefined;
    if (!options.canAttempt()) {
      if (!options.waitForAttempt) return undefined;
      await options.waitForAttempt();
      attempt -= 1;
      continue;
    }
    try {
      return await options.reconnect();
    } catch (error) {
      if (!options.isRetryable(error)) throw error;
    }
  }
}

export class ConnectionRetryWakeup {
  #pending = false;
  #wake: (() => void) | undefined;

  wake(): void {
    if (this.#wake) {
      this.#wake();
      return;
    }
    this.#pending = true;
  }

  wait(delayMs: number): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const timeout = globalThis.setTimeout(() => finish(), delayMs);
      const finish = () => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timeout);
        if (this.#wake === finish) this.#wake = undefined;
        resolve();
      };
      this.#wake = finish;
    });
  }
}

export function shouldVerifyAfterVisibilityChange(hidden: boolean): boolean {
  return !hidden;
}

export function isRetryableConnectionFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return false;
  const message = error instanceof Error ? error.message : String(error);
  return /cannot reach host|connection (?:timed out|closed|failed|is unavailable)|relay route (?:timed out|was rejected)|encrypted handshake timed out|closed the connection during handshake|networkerror|websocket/iu.test(
    message,
  );
}

/** A request deadline is not evidence that the encrypted transport died. */
export function shouldRecoverAfterHealthCheckFailure(error: unknown): boolean {
  if (isGatewayRequestOutcomeUnknown(error)) return error.transportLost;
  // host/ping has no application-level failure mode. A normal Host rejection
  // can mean that an authenticated session was revoked while its WebSocket was
  // intentionally left open, so preserve the previous recovery behavior for
  // every definitive error.
  return true;
}
