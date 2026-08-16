import { GATEWAY_API_VERSION } from "@codex-everywhere/protocol/v2";
import type {
  GatewayEventEnvelopeV2,
  GatewayRouteResult,
  GatewayV2Router,
} from "@codex-everywhere/protocol/v2";

import {
  AgentGatewaySession,
  agentGatewayContext,
  type AgentGatewayContext,
} from "./agent-gateway-session.js";
import type { GatewayV2Session } from "./transport-contract.js";

/** Adapts one Noise connection to the typed Gateway router. */
export class AgentTransportSession implements GatewayV2Session {
  readonly gatewayApiVersion = GATEWAY_API_VERSION;
  readonly #session: AgentGatewaySession;
  readonly #router: GatewayV2Router<AgentGatewayContext>;
  readonly #capabilities: ReadonlySet<string>;

  constructor(options: {
    readonly session: AgentGatewaySession;
    readonly router: GatewayV2Router<AgentGatewayContext>;
    readonly capabilities?: ReadonlySet<string>;
  }) {
    this.#session = options.session;
    this.#router = options.router;
    this.#capabilities = options.capabilities ?? new Set();
  }

  route(request: unknown): Promise<GatewayRouteResult> {
    return this.#router.route(
      request,
      agentGatewayContext({
        session: this.#session,
        capabilities: this.#capabilities,
      }),
    );
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return this.#session.onEvent(listener);
  }

  close(): Promise<void> {
    return this.#session.close();
  }
}
