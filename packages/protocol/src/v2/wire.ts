import { z } from "zod";
import {
  GATEWAY_API_VERSION,
  gatewayErrorSchema,
  identifierSchema,
  jsonValueSchema,
  uuidSchema,
  type GatewayErrorPayload,
  type JsonValue,
} from "./common.js";
import { GatewayV2Error } from "./errors.js";
import {
  gatewayMethodDefinitions,
  isGatewayMethodName,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
} from "./methods.js";

type OperationKeyField<MethodName extends GatewayMethodName> =
  (typeof gatewayMethodDefinitions)[MethodName]["kind"] extends "mutation"
    ? { readonly operationKey: string }
    : { readonly operationKey?: never };

export type GatewayRequestEnvelopeV2<
  MethodName extends GatewayMethodName = GatewayMethodName,
> = {
  readonly version: typeof GATEWAY_API_VERSION;
  readonly requestId: string;
  readonly method: MethodName;
  readonly input: InputOf<MethodName>;
} & OperationKeyField<MethodName>;

export type GatewayResponseEnvelopeV2<Result = JsonValue> =
  | {
      readonly version: typeof GATEWAY_API_VERSION;
      readonly requestId: string;
      readonly ok: true;
      readonly result: Result;
    }
  | {
      readonly version: typeof GATEWAY_API_VERSION;
      readonly requestId: string;
      readonly ok: false;
      readonly error: GatewayErrorPayload;
    };

export interface GatewayEventEnvelopeV2<Payload extends JsonValue = JsonValue> {
  readonly version: typeof GATEWAY_API_VERSION;
  readonly eventId: string;
  readonly cursor?: string;
  readonly type: string;
  readonly payload: Payload;
}

const requestBaseSchema = z
  .object({
    version: z.number().int(),
    requestId: uuidSchema,
    method: identifierSchema,
    input: z.unknown(),
    operationKey: uuidSchema.optional(),
  })
  .strict();

const responseBaseSchema = z.union([
  z
    .object({
      version: z.literal(GATEWAY_API_VERSION),
      requestId: uuidSchema,
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      version: z.literal(GATEWAY_API_VERSION),
      requestId: uuidSchema,
      ok: z.literal(false),
      error: gatewayErrorSchema,
    })
    .strict(),
]);

const eventEnvelopeSchema = z
  .object({
    version: z.literal(GATEWAY_API_VERSION),
    eventId: uuidSchema,
    cursor: z.string().min(1).max(2_048).optional(),
    type: identifierSchema,
    payload: jsonValueSchema,
  })
  .strict();

export function parseGatewayRequestEnvelopeV2(
  input: unknown,
): GatewayRequestEnvelopeV2 {
  const parsedJson = parseJsonIfNeeded(input, "gateway request");
  const base = requestBaseSchema.safeParse(parsedJson);
  if (!base.success) {
    const version = readNumericVersion(parsedJson);
    if (version !== undefined && version !== GATEWAY_API_VERSION) {
      throw versionMismatchError(version);
    }
    throw schemaError(
      "INVALID_REQUEST",
      "Invalid Gateway API request",
      base.error,
    );
  }
  if (base.data.version !== GATEWAY_API_VERSION) {
    throw versionMismatchError(base.data.version);
  }
  if (!isGatewayMethodName(base.data.method)) {
    throw new GatewayV2Error("METHOD_NOT_FOUND", "Unknown Gateway API method", {
      closeConnection: true,
    });
  }

  const definition = gatewayMethodDefinitions[base.data.method];
  const parsedInput = definition.input.safeParse(base.data.input);
  if (!parsedInput.success) {
    throw schemaError(
      "INVALID_INPUT",
      "Gateway API input did not match its schema",
      parsedInput.error,
    );
  }
  if (definition.kind === "mutation" && base.data.operationKey === undefined) {
    throw new GatewayV2Error(
      "OPERATION_KEY_REQUIRED",
      "Mutation requires a UUID operation key",
      { closeConnection: true },
    );
  }
  if (definition.kind === "query" && base.data.operationKey !== undefined) {
    throw new GatewayV2Error(
      "OPERATION_KEY_NOT_ALLOWED",
      "Query must not include an operation key",
      { closeConnection: true },
    );
  }

  return {
    version: GATEWAY_API_VERSION,
    requestId: base.data.requestId,
    method: base.data.method,
    input: parsedInput.data,
    ...(base.data.operationKey === undefined
      ? {}
      : { operationKey: base.data.operationKey }),
  } as GatewayRequestEnvelopeV2;
}

export function parseGatewayResponseEnvelopeV2<
  MethodName extends GatewayMethodName,
>(
  input: unknown,
  method: MethodName,
  expectedRequestId?: string,
): GatewayResponseEnvelopeV2<OutputOf<MethodName>> {
  const parsedJson = parseJsonIfNeeded(input, "gateway response");
  const base = responseBaseSchema.safeParse(parsedJson);
  if (!base.success) {
    const version = readNumericVersion(parsedJson);
    if (version !== undefined && version !== GATEWAY_API_VERSION) {
      throw versionMismatchError(version);
    }
    throw schemaError(
      "INVALID_RESPONSE",
      "Invalid Gateway API response",
      base.error,
    );
  }
  if (
    expectedRequestId !== undefined &&
    base.data.requestId !== expectedRequestId
  ) {
    throw new GatewayV2Error(
      "RESPONSE_REQUEST_MISMATCH",
      "Gateway response request ID did not match",
      { closeConnection: true },
    );
  }
  if (!base.data.ok) return base.data;

  const result = gatewayMethodDefinitions[method].output.safeParse(
    base.data.result,
  );
  if (!result.success) {
    throw schemaError(
      "INVALID_RESPONSE_RESULT",
      "Gateway response result did not match its schema",
      result.error,
    );
  }
  return {
    version: GATEWAY_API_VERSION,
    requestId: base.data.requestId,
    ok: true,
    result: result.data,
  } as GatewayResponseEnvelopeV2<OutputOf<MethodName>>;
}

export function parseGatewayEventEnvelopeV2(
  input: unknown,
): GatewayEventEnvelopeV2 {
  const parsedJson = parseJsonIfNeeded(input, "gateway event");
  const result = eventEnvelopeSchema.safeParse(parsedJson);
  if (!result.success) {
    const version = readNumericVersion(parsedJson);
    if (version !== undefined && version !== GATEWAY_API_VERSION) {
      throw versionMismatchError(version);
    }
    throw schemaError(
      "INVALID_EVENT",
      "Invalid Gateway API event",
      result.error,
    );
  }
  return {
    version: GATEWAY_API_VERSION,
    eventId: result.data.eventId,
    type: result.data.type,
    payload: result.data.payload,
    ...(result.data.cursor === undefined ? {} : { cursor: result.data.cursor }),
  };
}

export function gatewaySuccessResponse<MethodName extends GatewayMethodName>(
  requestId: string,
  result: OutputOf<MethodName>,
): GatewayResponseEnvelopeV2<OutputOf<MethodName>> {
  return { version: GATEWAY_API_VERSION, requestId, ok: true, result };
}

export function gatewayErrorResponse(
  requestId: string,
  error: GatewayErrorPayload,
): GatewayResponseEnvelopeV2<never> {
  return { version: GATEWAY_API_VERSION, requestId, ok: false, error };
}

function parseJsonIfNeeded(input: unknown, description: string): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new GatewayV2Error("INVALID_JSON", `Invalid ${description} JSON`, {
      closeConnection: true,
    });
  }
}

function readNumericVersion(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const version = (input as Record<string, unknown>).version;
  return typeof version === "number" ? version : undefined;
}

function versionMismatchError(version: number): GatewayV2Error {
  return version < GATEWAY_API_VERSION
    ? new GatewayV2Error(
        "CLIENT_UPGRADE_REQUIRED",
        "This client must be upgraded for Gateway API v2",
        { closeConnection: true },
      )
    : new GatewayV2Error(
        "AGENT_UPGRADE_REQUIRED",
        "The host Agent must be upgraded for this client",
        { closeConnection: true },
      );
}

function schemaError(
  code: string,
  message: string,
  error: z.ZodError,
): GatewayV2Error {
  return new GatewayV2Error(code, message, {
    closeConnection: true,
    details: {
      issues: error.issues.slice(0, 32).map((issue) => ({
        path: issue.path.map((part) =>
          typeof part === "symbol" ? String(part) : part,
        ),
        code: issue.code,
      })),
    },
  });
}
