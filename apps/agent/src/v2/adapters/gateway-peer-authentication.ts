import type { GatewayAuthenticationPayload } from "@codex-everywhere/protocol";

import type {
  GatewayDeviceRegistry,
  GatewayTransportAuthenticationContext,
  GatewayTrustedDevice,
} from "../gateway/transport-contract.js";

export type GatewayPeerAuthenticationResult =
  | { readonly accepted: false }
  | {
      readonly accepted: true;
      readonly device: GatewayTrustedDevice;
      readonly context: GatewayTransportAuthenticationContext;
    };

/** Resolves Noise-authenticated device identity without creating a session. */
export async function authenticateGatewayPeer(
  authentication: GatewayAuthenticationPayload,
  peer: {
    readonly deviceId: string;
    readonly publicKey: Uint8Array;
  },
  registry: GatewayDeviceRegistry,
): Promise<GatewayPeerAuthenticationResult> {
  if (authentication.mode === "pair") {
    const device = await registry.consumePairing({
      pairingId: authentication.pairingId,
      secret: authentication.secret,
      deviceId: peer.deviceId,
      deviceName: authentication.deviceName,
      publicKey: peer.publicKey,
    });
    return {
      accepted: true,
      device,
      context: { authenticationMode: authentication.mode },
    };
  }

  if (authentication.mode === "connect") {
    try {
      const device = await registry.verify(peer.deviceId, peer.publicKey);
      return {
        accepted: true,
        device,
        context: { authenticationMode: authentication.mode },
      };
    } catch (error) {
      if (deviceTrustErrorCode(error) === undefined) throw error;
      return { accepted: false };
    }
  }

  let matchedDevice: GatewayTrustedDevice | undefined;
  try {
    matchedDevice = await registry.match(peer.deviceId, peer.publicKey);
  } catch (error) {
    if (
      authentication.mode !== "resume" ||
      deviceTrustErrorCode(error) !== "KEY_MISMATCH"
    ) {
      throw error;
    }
  }
  if (
    authentication.mode === "resume" &&
    matchedDevice?.revokedAt !== undefined
  ) {
    return { accepted: false };
  }

  return {
    accepted: true,
    device: matchedDevice ?? {
      id: peer.deviceId,
      name:
        authentication.mode === "login"
          ? authentication.deviceName
          : "Resumed Web session",
      publicKey: peer.publicKey,
      createdAt: new Date().toISOString(),
    },
    context: {
      authenticationMode: authentication.mode,
      ...(authentication.mode === "resume"
        ? { resumeToken: authentication.resumeToken }
        : {}),
    },
  };
}

function deviceTrustErrorCode(
  error: unknown,
): "NOT_TRUSTED" | "REVOKED" | "KEY_MISMATCH" | undefined {
  if (!isRecord(error)) return undefined;
  const code = error.code;
  return code === "NOT_TRUSTED" || code === "REVOKED" || code === "KEY_MISMATCH"
    ? code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
