import { GatewayRemoteError } from "@codex-everywhere/protocol/v2";
import { describe, expect, it, vi } from "vitest";

import type { GatewayPort } from "./gateway-port.js";
import { readCodexVersion } from "./codex-version.js";

describe("Codex version compatibility", () => {
  it("retries without the alpha.15 switch-state input against an older Agent", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRemoteError({
          code: "INVALID_INPUT",
          message: "Gateway request input did not match its schema",
        }),
      )
      .mockResolvedValueOnce({
        version: 1,
        installed: true,
        installedVersion: "0.151.0",
        relation: "current",
      });
    const gateway = { request } as unknown as GatewayPort;

    await expect(readCodexVersion(gateway)).resolves.toMatchObject({
      installedVersion: "0.151.0",
    });
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      { version: 1, includeRuntimeSwitchState: true },
      { version: 1 },
    ]);
  });
});
