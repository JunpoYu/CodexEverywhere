import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "./common.js";

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
