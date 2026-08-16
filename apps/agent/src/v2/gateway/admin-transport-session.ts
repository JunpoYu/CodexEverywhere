import { GATEWAY_API_VERSION } from "@codex-everywhere/protocol/v2";
import type {
  GatewayRouteResult,
  GatewayV2Router,
} from "@codex-everywhere/protocol/v2";

import {
  AdminGatewaySession,
  adminGatewayContext,
  type AdminGatewayContext,
} from "./admin-gateway-session.js";
import type { GatewayV2Session } from "./transport-contract.js";

export class AdminTransportSession implements GatewayV2Session {
  readonly gatewayApiVersion = GATEWAY_API_VERSION;
  readonly #session: AdminGatewaySession;
  readonly #router: GatewayV2Router<AdminGatewayContext>;

  constructor(input: {
    readonly session: AdminGatewaySession;
    readonly router: GatewayV2Router<AdminGatewayContext>;
  }) {
    this.#session = input.session;
    this.#router = input.router;
  }

  route(request: unknown): Promise<GatewayRouteResult> {
    return this.#router.route(
      request,
      adminGatewayContext({ session: this.#session }),
    );
  }

  close(): Promise<void> {
    return this.#session.close();
  }
}
