import { z } from "zod";
import {
  cursorSchema,
  identifierSchema,
  jsonObjectSchema,
  jsonValueSchema,
  pathSchema,
  shortTextSchema,
  timestampSchema,
} from "./common.js";

export const authenticationResultSchema = z
  .object({
    version: z.literal(1),
    authenticated: z.literal(true),
    principal: z.enum(["user", "host-admin"]),
    loginName: identifierSchema.optional(),
    resumeToken: z.string().min(1).max(2_048).optional(),
    rememberedDevice: z.boolean(),
    recoveryCodes: z.array(z.string().min(1).max(256)).max(32).optional(),
  })
  .strict();

export const workspaceSchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    path: pathSchema,
    label: shortTextSchema,
    isDefault: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const directoryEntrySchema = z
  .object({
    version: z.literal(1),
    name: shortTextSchema,
    path: pathSchema,
    kind: z.enum(["directory", "file"]),
    selectable: z.boolean(),
  })
  .strict();

export const threadStateSchema = z.enum([
  "idle",
  "running",
  "waiting-input",
  "failed",
]);

export const THREAD_TITLE_MAX_LENGTH = 1_024;

export const threadSummarySchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    workspaceId: identifierSchema,
    title: z.string().max(THREAD_TITLE_MAX_LENGTH),
    state: threadStateSchema,
    archived: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const timelineItemTypeSchema = z.enum([
  "message",
  "plan",
  "command",
  "file-change",
  "mcp",
  "subagent",
  "error",
  "generic",
]);

export const timelineItemSchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    turnId: identifierSchema.optional(),
    type: timelineItemTypeSchema,
    createdAt: timestampSchema.optional(),
    data: jsonObjectSchema,
  })
  .strict();

export const interactionKindSchema = z.enum([
  "approval",
  "user-question",
  "mcp-elicitation",
]);

export const interactionSchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    threadId: identifierSchema,
    turnId: identifierSchema.optional(),
    kind: interactionKindSchema,
    requestMethod: z.string().min(1).max(256),
    createdAt: timestampSchema,
    payload: jsonObjectSchema,
  })
  .strict();

export const interactionResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("approval"),
      decision: z.enum(["accept", "decline"]),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("user-input"),
      answers: z.record(
        z.string().min(1).max(256),
        z.array(z.string().max(16_384)).max(32),
      ),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("mcp-elicitation"),
      action: z.enum(["accept", "decline", "cancel"]),
      content: jsonValueSchema.optional(),
    })
    .strict(),
]);

export type InteractionResponse = z.output<typeof interactionResponseSchema>;

export const threadSettingsSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    model: z.string().min(1).max(256).optional(),
    effort: z.string().min(1).max(128).optional(),
    sandbox: z
      .enum(["read-only", "workspace-write", "danger-full-access"])
      .optional(),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  })
  .strict();

export const modelCatalogEntrySchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    model: z.string().min(1).max(256),
    displayName: z.string().min(1).max(1_024),
    description: z.string().max(8_192),
    isDefault: z.boolean(),
    defaultEffort: z.string().min(1).max(128),
    supportedEfforts: z
      .array(
        z
          .object({
            effort: z.string().min(1).max(128),
            description: z.string().max(4_096),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

export const threadSnapshotSchema = z
  .object({
    version: z.literal(1),
    thread: threadSummarySchema,
    state: threadStateSchema,
    items: z.array(timelineItemSchema),
    interactions: z.array(interactionSchema),
    historyCursor: cursorSchema.optional(),
    hasEarlierHistory: z.boolean(),
    settings: threadSettingsSchema,
  })
  .strict();

export const queueItemStatusSchema = z.enum([
  "pending",
  "paused",
  "delivering",
  "completed",
  "indeterminate",
]);

export const queueItemSchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    threadId: identifierSchema,
    text: z.string().min(1).max(1_000_000),
    status: queueItemStatusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revision: z.number().int().nonnegative(),
    indeterminateReason: z.string().max(2_048).optional(),
  })
  .strict();

export const preferencesSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    theme: z.enum(["system", "light", "dark"]),
    locale: z.string().min(1).max(64),
    defaultWorkspaceId: identifierSchema.optional(),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]),
  })
  .strict();

export const adminUserStatusSchema = z.enum([
  "enabled",
  "disabled",
  "removal_pending",
  "removing",
  "removed",
]);

export const adminUserSchema = z
  .object({
    version: z.literal(1),
    uid: z.number().int().nonnegative(),
    username: identifierSchema,
    home: pathSchema,
    shell: pathSchema,
    status: adminUserStatusSchema,
    agentOnline: z.boolean(),
    revision: z.number().int().nonnegative(),
    registeredAt: timestampSchema,
    updatedAt: timestampSchema,
    removeAfter: timestampSchema.optional(),
  })
  .strict();

export const adminAuditSchema = z
  .object({
    version: z.literal(1),
    id: identifierSchema,
    requestId: identifierSchema,
    actor: identifierSchema,
    action: identifierSchema,
    targetUsername: identifierSchema.optional(),
    result: z.enum(["succeeded", "failed"]),
    createdAt: timestampSchema,
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();
