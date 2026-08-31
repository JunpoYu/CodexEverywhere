import { z } from "zod";
import {
  identifierSchema,
  jsonObjectSchema,
  jsonValueSchema,
  shortTextSchema,
  type JsonValue,
} from "./common.js";
import {
  interactionSchema,
  queueItemSchema,
  threadStateSchema,
} from "./domain-schemas.js";

export const codexGenericEventPayloadSchema = z
  .object({
    version: z.literal(1),
    method: z.string().min(1).max(1_024),
    params: jsonValueSchema,
  })
  .strict();

export type CodexGenericEventPayload = z.output<
  typeof codexGenericEventPayloadSchema
>;

/** Preserves an app-server notification that this CE build does not know. */
export function codexGenericEvent(
  method: string,
  params: JsonValue,
): CodexGenericEventPayload {
  return codexGenericEventPayloadSchema.parse({ version: 1, method, params });
}

const versioned = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ version: z.literal(1), ...shape }).strict();

export const gatewayEventDefinitions = {
  "thread/state": versioned({
    threadId: identifierSchema,
    state: threadStateSchema,
    currentTurnId: identifierSchema.optional(),
  }),
  "codex/notification": versioned({
    threadId: identifierSchema,
    method: identifierSchema,
    params: jsonValueSchema,
  }),
  "codex/generic": versioned({
    threadId: identifierSchema.optional(),
    method: identifierSchema,
    params: jsonValueSchema,
  }),
  "interaction/created": versioned({ interaction: interactionSchema }),
  "interaction/resolved": versioned({
    threadId: identifierSchema,
    interactionId: identifierSchema,
  }),
  "interaction/failed": versioned({
    threadId: identifierSchema,
    interactionId: identifierSchema,
    reason: shortTextSchema,
  }),
  "thread/lease/failed": versioned({
    threadId: identifierSchema,
    reason: shortTextSchema,
  }),
  "thread/name/changed": versioned({ threadId: identifierSchema }),
  "queue/changed": versioned({ item: queueItemSchema }),
  "queue/removed": versioned({ itemId: identifierSchema }),
  "queue/delivery": versioned({
    itemId: identifierSchema,
    threadId: identifierSchema,
    state: z.enum(["delivering", "completed", "indeterminate", "paused"]),
  }),
  "setup/codex/install/progress": versioned({
    operationId: identifierSchema,
    phase: z.enum([
      "preparing",
      "installing",
      "verifying",
      "completed",
      "failed",
    ]),
  }),
  "setup/codex/login/completed": versioned({
    operationId: identifierSchema,
    success: z.boolean(),
    error: z.string().min(1).max(1_024).optional(),
  }),
} as const;

export type GatewayEventName = keyof typeof gatewayEventDefinitions;
export type GatewayEventPayload<Name extends GatewayEventName> = z.output<
  (typeof gatewayEventDefinitions)[Name]
>;

export function isGatewayEventName(value: string): value is GatewayEventName {
  return Object.hasOwn(gatewayEventDefinitions, value);
}

export function parseGatewayEventPayload<Name extends GatewayEventName>(
  type: Name,
  payload: unknown,
): GatewayEventPayload<Name> {
  return gatewayEventDefinitions[type].parse(
    payload,
  ) as GatewayEventPayload<Name>;
}

export function parseKnownGatewayEventPayload(
  type: string,
  payload: unknown,
): JsonValue {
  return (isGatewayEventName(type)
    ? gatewayEventDefinitions[type].parse(payload)
    : jsonValueSchema.parse(payload)) as unknown as JsonValue;
}
