import {
  isGatewayRequestOutcomeUnknown,
  type GatewayClient,
} from "./gateway-client.js";

export type RecoverableGatewayMutationResult<T> = {
  client: GatewayClient;
  value: T;
};

export class GatewayMutationRecoveryPendingError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "GatewayMutationRecoveryPendingError";
  }
}

/**
 * Retry an outcome-unknown mutation only with its original idempotency key.
 * Reconnect is caller-owned because the page must also restore authentication
 * and subscriptions before another encrypted request can be sent.
 */
export async function requestRecoverableGatewayMutation<T>(options: {
  client: GatewayClient;
  method: string;
  payload: unknown;
  idempotencyKey: string;
  reconnect(client: GatewayClient): Promise<GatewayClient>;
  maxReconnects?: number;
}): Promise<RecoverableGatewayMutationResult<T>> {
  const maxReconnects = options.maxReconnects ?? 2;
  let current = options.client;
  for (let reconnects = 0; ; reconnects += 1) {
    try {
      return {
        client: current,
        value: await current.request<T>(options.method, options.payload, {
          idempotencyKey: options.idempotencyKey,
        }),
      };
    } catch (error) {
      if (
        !isGatewayRequestOutcomeUnknown(error) ||
        reconnects >= maxReconnects
      ) {
        throw error;
      }
      // A request deadline does not imply a dead Noise/WebSocket transport.
      // Retry with the same idempotency key on the current tunnel and reserve
      // reconnect for an observed close/error/send failure.
      if (!error.transportLost) continue;
      let next: GatewayClient;
      try {
        next = await options.reconnect(current);
      } catch (reconnectError) {
        throw new GatewayMutationRecoveryPendingError(
          "Host connection has not recovered; mutation outcome still pending",
          reconnectError,
        );
      }
      if (next.host.deviceId !== current.host.deviceId) {
        throw new GatewayMutationRecoveryPendingError(
          "Host reauthentication changed the idempotency scope; mutation outcome still pending",
          error,
        );
      }
      current = next;
    }
  }
}
