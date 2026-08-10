import { describe, expect, it } from "vitest";

import {
  CONNECTION_KEEPALIVE_INTERVAL_MS,
  CONNECTION_RECOVERY_DELAYS_MS,
  ConnectionRetryWakeup,
  connectionRecoveryDelayMs,
  isRetryableConnectionFailure,
  reconnectWithUnlimitedAttempts,
  shouldVerifyAfterVisibilityChange,
} from "./connection-recovery.js";

describe("connection recovery policy", () => {
  it("caps each delay without exhausting the reconnect attempt budget", () => {
    expect(CONNECTION_RECOVERY_DELAYS_MS).toEqual([
      0, 500, 1_000, 2_000, 4_000, 8_000, 30_000,
    ]);
    expect(connectionRecoveryDelayMs(0)).toBe(0);
    expect(connectionRecoveryDelayMs(6)).toBe(30_000);
    expect(connectionRecoveryDelayMs(10_000)).toBe(30_000);
    expect(CONNECTION_KEEPALIVE_INTERVAL_MS).toBeLessThan(60_000);
  });

  it("keeps retrying after the former burst limit until the Host returns", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await reconnectWithUnlimitedAttempts({
      isCurrent: () => true,
      canAttempt: () => true,
      reconnect: () => {
        attempts += 1;
        if (attempts < 12) throw new Error("Host connection failed");
        return Promise.resolve("connected");
      },
      wait: (delayMs) => {
        delays.push(delayMs);
        return Promise.resolve();
      },
      isRetryable: isRetryableConnectionFailure,
    });

    expect(result).toBe("connected");
    expect(attempts).toBe(12);
    expect(delays.slice(-4)).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it("pauses an interactive reconnect in the background and resumes on wake", async () => {
    const wakeup = new ConnectionRetryWakeup();
    let visible = false;
    let attempts = 0;
    const pending = reconnectWithUnlimitedAttempts({
      isCurrent: () => true,
      canAttempt: () => visible,
      reconnect: () => {
        attempts += 1;
        return "connected";
      },
      isRetryable: isRetryableConnectionFailure,
      wait: (delayMs) => wakeup.wait(delayMs),
      waitForAttempt: () => wakeup.wait(30_000),
    });

    await Promise.resolve();
    expect(attempts).toBe(0);
    visible = true;
    wakeup.wake();
    await expect(pending).resolves.toBe("connected");
    expect(attempts).toBe(1);
  });

  it("waits for visibility after silent resumption becomes unavailable", async () => {
    let hidden = true;
    let silent = true;
    let attempts = 0;
    const result = await reconnectWithUnlimitedAttempts({
      isCurrent: () => true,
      canAttempt: () => !hidden || silent,
      reconnect: () => {
        attempts += 1;
        if (attempts === 1) {
          silent = false;
          throw new Error("REAUTH_REQUIRED");
        }
        return "interactive-auth-complete";
      },
      isRetryable: (error) =>
        error instanceof Error && error.message === "REAUTH_REQUIRED",
      wait: () => Promise.resolve(),
      waitForAttempt: () => {
        hidden = false;
        return Promise.resolve();
      },
    });

    expect(result).toBe("interactive-auth-complete");
    expect(attempts).toBe(2);
  });

  it("checks every transition back to a visible page", () => {
    expect(shouldVerifyAfterVisibilityChange(false)).toBe(true);
    expect(shouldVerifyAfterVisibilityChange(true)).toBe(false);
  });

  it("retries transport failures", () => {
    expect(isRetryableConnectionFailure(new Error("Cannot reach host"))).toBe(
      true,
    );
    expect(
      isRetryableConnectionFailure(new Error("Relay route timed out")),
    ).toBe(true);
    expect(
      isRetryableConnectionFailure(new Error("Host connection closed")),
    ).toBe(true);
  });

  it("does not retry authentication or device rejection", () => {
    expect(
      isRetryableConnectionFailure(
        new Error("Host did not accept this device"),
      ),
    ).toBe(false);
    expect(
      isRetryableConnectionFailure(
        new DOMException("User cancelled", "NotAllowedError"),
      ),
    ).toBe(false);
  });
});
