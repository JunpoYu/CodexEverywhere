import { GATEWAY_API_VERSION, uuidSchema } from "./common.js";
import { GatewayV2Error } from "./errors.js";
import {
  gatewayMethodDefinitions,
  gatewayMethodNames,
  type GatewayAccess,
  type GatewayIdempotency,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
} from "./methods.js";
import {
  gatewayErrorResponse,
  gatewaySuccessResponse,
  parseGatewayRequestEnvelopeV2,
  type GatewayRequestEnvelopeV2,
  type GatewayResponseEnvelopeV2,
} from "./wire.js";

export interface GatewayRequestContext {
  readonly access: GatewayAccess;
  readonly principalId: string;
  readonly capabilities: ReadonlySet<string>;
  readonly signal: AbortSignal;
  /** Revalidates revocable transport/session credentials before dispatch. */
  readonly assertCurrent?: () => void | Promise<void>;
}

export type GatewayHandler<
  MethodName extends GatewayMethodName,
  Context extends GatewayRequestContext,
> = (
  input: InputOf<MethodName>,
  context: Context,
) => OutputOf<MethodName> | Promise<OutputOf<MethodName>>;

export interface MutationInvocation {
  readonly method: GatewayMethodName;
  readonly operationKey: string;
  readonly idempotency: Exclude<GatewayIdempotency, "none">;
  readonly principalId: string;
  readonly requestId: string;
  /** Already schema-validated input. Middleware must never log this value. */
  readonly input: unknown;
}

export interface GatewayMutationMiddleware {
  run<Result>(
    invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result>;
}

export interface GatewayRouteResult {
  readonly response: GatewayResponseEnvelopeV2<unknown>;
  readonly closeConnection: boolean;
}

type AnyGatewayHandler<Context extends GatewayRequestContext> = (
  input: never,
  context: Context,
) => unknown | Promise<unknown>;

/** Validates the complete v2 boundary before dispatching a registered handler. */
export class GatewayV2Router<Context extends GatewayRequestContext> {
  readonly #handlers = new Map<GatewayMethodName, AnyGatewayHandler<Context>>();
  readonly #mutationMiddleware: GatewayMutationMiddleware;
  #supportedAccess = new Set<GatewayAccess>(["pre-auth", "user", "admin"]);
  #sealed = false;

  constructor(mutationMiddleware: GatewayMutationMiddleware) {
    this.#mutationMiddleware = mutationMiddleware;
  }

  register<MethodName extends GatewayMethodName>(
    method: MethodName,
    handler: GatewayHandler<MethodName, Context>,
  ): this {
    if (this.#sealed) throw new Error("Gateway router is sealed");
    if (this.#handlers.has(method)) {
      throw new Error(`Gateway handler already registered: ${method}`);
    }
    this.#handlers.set(method, handler as AnyGatewayHandler<Context>);
    return this;
  }

  seal(
    options: {
      readonly access?: ReadonlySet<GatewayAccess>;
    } = {},
  ): this {
    this.#supportedAccess = new Set(
      options.access ?? (["pre-auth", "user", "admin"] as const),
    );
    const missing = gatewayMethodNames.filter(
      (method) =>
        this.#supportedAccess.has(gatewayMethodDefinitions[method].access) &&
        !this.#handlers.has(method),
    );
    if (missing.length > 0) {
      throw new Error(`Missing Gateway handlers: ${missing.join(", ")}`);
    }
    this.#sealed = true;
    return this;
  }

  async route(input: unknown, context: Context): Promise<GatewayRouteResult> {
    let requestId = extractRequestId(input) ?? createUuid();
    try {
      if (!this.#sealed) throw new Error("Gateway router is not sealed");
      const request = parseGatewayRequestEnvelopeV2(input);
      requestId = request.requestId;
      await context.assertCurrent?.();
      const definition = gatewayMethodDefinitions[request.method];
      if (!this.#supportedAccess.has(definition.access)) {
        throw new GatewayV2Error(
          "ACCESS_DENIED",
          "This Gateway endpoint does not serve the requested access domain",
          { closeConnection: true },
        );
      }
      authorize(definition.access, definition.capability, context);
      const handler = this.#handlers.get(request.method);
      if (handler === undefined)
        throw new Error("Sealed router lost a handler");

      const execute = async (): Promise<unknown> => {
        const result = await handler(request.input as never, context);
        const validated = definition.output.safeParse(result);
        if (!validated.success) {
          throw new GatewayV2Error(
            "INTERNAL_PROTOCOL_ERROR",
            "Gateway handler returned an invalid result",
          );
        }
        return validated.data;
      };

      const result =
        definition.kind === "mutation"
          ? await this.#mutationMiddleware.run(
              {
                method: request.method,
                operationKey: requireOperationKey(request),
                idempotency: requireMutationIdempotency(definition.idempotency),
                principalId: context.principalId,
                requestId,
                input: request.input,
              },
              execute,
            )
          : await execute();

      return {
        response: gatewaySuccessResponse(requestId, result as never),
        closeConnection: false,
      };
    } catch (error) {
      const gatewayError =
        error instanceof GatewayV2Error
          ? error
          : new GatewayV2Error(
              "INTERNAL_ERROR",
              "Gateway request could not be completed",
            );
      return {
        response: gatewayErrorResponse(requestId, gatewayError.toPayload()),
        closeConnection: gatewayError.closeConnection,
      };
    }
  }
}

function createUuid(): string {
  return globalThis.crypto.randomUUID();
}

export const passthroughMutationMiddleware: GatewayMutationMiddleware = {
  async run<Result>(
    _invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    return execute();
  },
};

function authorize(
  requiredAccess: GatewayAccess,
  capability: string | undefined,
  context: GatewayRequestContext,
): void {
  if (
    (requiredAccess === "user" && context.access !== "user") ||
    (requiredAccess === "admin" && context.access !== "admin")
  ) {
    throw new GatewayV2Error(
      "ACCESS_DENIED",
      "The authenticated principal cannot call this method",
      { closeConnection: true },
    );
  }
  if (capability !== undefined && !context.capabilities.has(capability)) {
    throw new GatewayV2Error(
      "CAPABILITY_REQUIRED",
      "The client did not negotiate a required capability",
      {
        closeConnection: true,
        details: { requiredCapability: capability },
      },
    );
  }
}

function requireOperationKey(request: GatewayRequestEnvelopeV2): string {
  if (!("operationKey" in request) || request.operationKey === undefined) {
    throw new GatewayV2Error(
      "OPERATION_KEY_REQUIRED",
      "Mutation requires a UUID operation key",
      { closeConnection: true },
    );
  }
  return request.operationKey;
}

function requireMutationIdempotency(
  idempotency: GatewayIdempotency,
): Exclude<GatewayIdempotency, "none"> {
  if (idempotency === "none") {
    throw new GatewayV2Error(
      "INTERNAL_PROTOCOL_ERROR",
      "Mutation method has invalid idempotency metadata",
    );
  }
  return idempotency;
}

function extractRequestId(input: unknown): string | undefined {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const requestId = (value as Record<string, unknown>).requestId;
  return uuidSchema.safeParse(requestId).success
    ? (requestId as string)
    : undefined;
}

export function unsupportedGatewayV2Response(
  requestId: string,
): GatewayResponseEnvelopeV2<never> {
  return {
    version: GATEWAY_API_VERSION,
    requestId,
    ok: false,
    error: {
      code: "AGENT_UPGRADE_REQUIRED",
      message: "The host Agent does not support Gateway API v2",
    },
  };
}
