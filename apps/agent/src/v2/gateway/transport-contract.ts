import type {
  GATEWAY_API_VERSION,
  GatewayEventEnvelopeV2,
  GatewayRouteResult,
} from "@codex-everywhere/protocol/v2";

/** Transport-facing device identity; business services never own Noise state. */
export interface GatewayTrustedDevice {
  readonly id: string;
  readonly name: string;
  readonly publicKey: Uint8Array;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface GatewayDeviceRegistry {
  consumePairing(input: {
    readonly pairingId: string;
    readonly secret: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly publicKey: Uint8Array;
  }): Promise<GatewayTrustedDevice>;
  verify(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<GatewayTrustedDevice>;
  match(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<GatewayTrustedDevice | undefined>;
  rememberAuthenticated?(input: {
    readonly deviceId: string;
    readonly deviceName: string;
    readonly publicKey: Uint8Array;
  }): Promise<{
    readonly device: GatewayTrustedDevice;
    readonly rollback?: () => Promise<void>;
  }>;
}

/** Minimal seam implemented by one scoped Agent/Admin Gateway session. */
export interface GatewayV2Session {
  readonly gatewayApiVersion: typeof GATEWAY_API_VERSION;
  route(request: unknown): Promise<GatewayRouteResult>;
  onEvent?(listener: (event: GatewayEventEnvelopeV2) => void): () => void;
  close?(): Promise<void> | void;
}
