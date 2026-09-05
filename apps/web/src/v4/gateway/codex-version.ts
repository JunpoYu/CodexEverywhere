import {
  GatewayRemoteError,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import { queryOptions, type GatewayPort } from "./gateway-port.js";

/** Reads the switch state when supported and falls back across alpha.14. */
export async function readCodexVersion(
  gateway: GatewayPort,
  signal?: AbortSignal,
): Promise<OutputOf<"setup/codex/version">> {
  try {
    return await gateway.request(
      "setup/codex/version",
      { version: 1, includeRuntimeSwitchState: true },
      queryOptions(signal),
    );
  } catch (error) {
    if (
      !(error instanceof GatewayRemoteError) ||
      error.code !== "INVALID_INPUT"
    ) {
      throw error;
    }
    return gateway.request(
      "setup/codex/version",
      { version: 1 },
      queryOptions(signal),
    );
  }
}
