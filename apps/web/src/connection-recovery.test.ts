import { describe, expect, it } from "vitest";

import {
  CONNECTION_RECOVERY_DELAYS_MS,
  isRetryableConnectionFailure,
  shouldVerifyAfterVisibilityChange,
} from "./connection-recovery.js";

describe("connection recovery policy", () => {
  it("uses bounded exponential backoff", () => {
    expect(CONNECTION_RECOVERY_DELAYS_MS).toEqual([
      0, 500, 1_000, 2_000, 4_000, 8_000,
    ]);
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
