import { z } from "zod";

export const GATEWAY_API_VERSION = 2 as const;
export const PAYLOAD_VERSION = 1 as const;

export const uuidSchema = z.string().uuid();
export const identifierSchema = z.string().min(1).max(512);
export const shortTextSchema = z.string().min(1).max(1_024);
export const pathSchema = z.string().min(1).max(16_384);
export const timestampSchema = z.string().datetime({ offset: true });
export const cursorSchema = z.string().min(1).max(2_048);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const versionedEmptySchema = z
  .object({ version: z.literal(PAYLOAD_VERSION) })
  .strict();

export const pageInputFields = {
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
} as const;

export const pageResultFields = {
  nextCursor: cursorSchema.optional(),
  hasMore: z.boolean(),
} as const;

export const gatewayErrorSchema = z
  .object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_048),
    retryable: z.boolean().optional(),
    details: z
      .object({
        issues: z
          .array(
            z
              .object({
                path: z.array(z.union([z.string(), z.number().int()])),
                code: z.string().min(1).max(128),
              })
              .strict(),
          )
          .max(32)
          .optional(),
        requiredCapability: identifierSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GatewayErrorPayload = z.output<typeof gatewayErrorSchema>;

export const mutationStatusSchema = z.discriminatedUnion("status", [
  z.object({ version: z.literal(1), status: z.literal("missing") }).strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal("pending"),
      method: identifierSchema,
      startedAt: timestampSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal("completed"),
      method: identifierSchema,
      completedAt: timestampSchema,
      result: jsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal("indeterminate"),
      method: identifierSchema,
      updatedAt: timestampSchema,
      reason: z.string().min(1).max(1_024).optional(),
    })
    .strict(),
]);

export type MutationStatus = z.output<typeof mutationStatusSchema>;
