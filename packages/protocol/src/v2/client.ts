import { GATEWAY_API_VERSION, uuidSchema } from "./common.js";
import {
  GatewayRemoteError,
  GatewayV2Error,
  MutationOutcomeUnknownError,
} from "./errors.js";
import {
  gatewayMethodDefinitions,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "./methods.js";
import {
  parseGatewayResponseEnvelopeV2,
  type GatewayRequestEnvelopeV2,
} from "./wire.js";

export interface GatewayV2Transport {
  exchange(
    request: unknown,
    options: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface GatewayV2ClientOptions {
  readonly createRequestId?: () => string;
}

/** Transport-independent, schema-validating client used by Direct and Relay. */
export class GatewayV2Client {
  readonly #transport: GatewayV2Transport;
  readonly #createRequestId: () => string;

  constructor(
    transport: GatewayV2Transport,
    options: GatewayV2ClientOptions = {},
  ) {
    this.#transport = transport;
    this.#createRequestId =
      options.createRequestId ?? (() => globalThis.crypto.randomUUID());
  }

  async request<MethodName extends GatewayMethodName>(
    method: MethodName,
    input: InputOf<MethodName>,
    options: RequestOptionsOf<MethodName>,
  ): Promise<OutputOf<MethodName>> {
    const definition = gatewayMethodDefinitions[method];
    const parsedInput = definition.input.safeParse(input);
    if (!parsedInput.success) {
      throw new GatewayV2Error(
        "INVALID_CLIENT_INPUT",
        "Gateway request input did not match its schema",
      );
    }
    const requestId = this.#createRequestId();
    if (!uuidSchema.safeParse(requestId).success) {
      throw new GatewayV2Error(
        "INVALID_REQUEST_ID",
        "Gateway request ID factory must return a UUID",
      );
    }

    const operationKey =
      "operationKey" in options ? options.operationKey : undefined;
    if (definition.kind === "mutation") {
      if (!uuidSchema.safeParse(operationKey).success) {
        throw new GatewayV2Error(
          "INVALID_OPERATION_KEY",
          "Mutation operation key must be a UUID",
        );
      }
    } else if (operationKey !== undefined) {
      throw new GatewayV2Error(
        "OPERATION_KEY_NOT_ALLOWED",
        "Query must not include an operation key",
      );
    }

    const envelope = {
      version: GATEWAY_API_VERSION,
      requestId,
      method,
      input: parsedInput.data,
      ...(operationKey === undefined ? {} : { operationKey }),
    } as GatewayRequestEnvelopeV2<MethodName>;

    let rawResponse: unknown;
    try {
      rawResponse = await this.#transport.exchange(envelope, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (definition.kind === "mutation") {
        throw new MutationOutcomeUnknownError(method, operationKey!, {
          cause: error,
        });
      }
      throw error;
    }

    const response = parseGatewayResponseEnvelopeV2(
      rawResponse,
      method,
      requestId,
    );
    if (!response.ok) throw new GatewayRemoteError(response.error);
    return response.result;
  }
}
