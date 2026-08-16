import type {
  GatewayAccess,
  GatewayRequestContext,
} from "@codex-everywhere/protocol/v2";

export interface GatewayDeviceBinding {
  readonly id: string;
  readonly name: string;
  readonly publicKey: Uint8Array;
}

export interface IdentityGatewaySession {
  readonly id: string;
  readonly device: GatewayDeviceBinding | undefined;
  authenticate(input: {
    readonly access: Extract<GatewayAccess, "user" | "admin">;
    readonly principalId: string;
    readonly temporary: boolean;
  }): void;
}

export interface IdentityGatewayContext extends GatewayRequestContext {
  readonly session: IdentityGatewaySession;
  readonly temporary: boolean;
}
