import { z, type ZodType } from "zod";
import {
  GATEWAY_API_VERSION,
  identifierSchema,
  jsonObjectSchema,
  jsonValueSchema,
  mutationStatusSchema,
  pageInputFields,
  pageResultFields,
  pathSchema,
  shortTextSchema,
  timestampSchema,
  uuidSchema,
  versionedEmptySchema,
} from "./common.js";
import {
  adminAuditSchema,
  adminUserSchema,
  authenticationResultSchema,
  directoryEntrySchema,
  interactionSchema,
  preferencesSchema,
  queueItemSchema,
  threadSettingsSchema,
  threadSnapshotSchema,
  threadSummarySchema,
  timelineItemSchema,
  workspaceSchema,
} from "./domain-schemas.js";

export type GatewayAccess = "pre-auth" | "user" | "admin";
export type GatewayMethodKind = "query" | "mutation";
export type GatewayIdempotency = "none" | "ephemeral" | "durable";

export interface GatewayMethodDefinition<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType = ZodType,
> {
  readonly access: GatewayAccess;
  readonly kind: GatewayMethodKind;
  readonly idempotency: GatewayIdempotency;
  readonly capability?: string;
  readonly input: InputSchema;
  readonly output: OutputSchema;
}

interface QueryDefinition<
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
> extends GatewayMethodDefinition<InputSchema, OutputSchema> {
  readonly kind: "query";
  readonly idempotency: "none";
}

interface MutationDefinition<
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  Idempotency extends Exclude<GatewayIdempotency, "none">,
> extends GatewayMethodDefinition<InputSchema, OutputSchema> {
  readonly kind: "mutation";
  readonly idempotency: Idempotency;
}

export interface Method<Input, Output> {
  readonly input: Input;
  readonly output: Output;
  readonly kind: "query" | "mutation";
  readonly idempotency: GatewayIdempotency;
}

export interface DurableMutation<Input, Output> extends Method<Input, Output> {
  readonly kind: "mutation";
  readonly idempotency: "durable";
}

export const GATEWAY_CAPABILITIES_V2 = {
  queueSteer: "queue-steer-v1",
  tuiHandoff: "tui-handoff-v1",
} as const;

const query = <InputSchema extends ZodType, OutputSchema extends ZodType>(
  access: GatewayAccess,
  input: InputSchema,
  output: OutputSchema,
  capability?: string,
): QueryDefinition<InputSchema, OutputSchema> => ({
  access,
  kind: "query",
  idempotency: "none",
  ...(capability === undefined ? {} : { capability }),
  input,
  output,
});

const mutation = <
  InputSchema extends ZodType,
  OutputSchema extends ZodType,
  Idempotency extends Exclude<GatewayIdempotency, "none">,
>(
  access: GatewayAccess,
  idempotency: Idempotency,
  input: InputSchema,
  output: OutputSchema,
  capability?: string,
): MutationDefinition<InputSchema, OutputSchema, Idempotency> => ({
  access,
  kind: "mutation",
  idempotency,
  ...(capability === undefined ? {} : { capability }),
  input,
  output,
});

const versionedResult = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ version: z.literal(1), ...shape }).strict();

const authenticationChallengeSchema = versionedResult({
  challengeId: identifierSchema,
  options: jsonObjectSchema,
  expiresAt: timestampSchema,
});

const passwordChallengeSchema = versionedResult({
  challengeId: identifierSchema,
  message: z.string().min(1).max(65_536),
  expiresAt: timestampSchema,
});

const booleanResult = <Field extends string>(field: Field) =>
  versionedResult({
    [field]: z.literal(true),
  } as Record<Field, z.ZodLiteral<true>>);

const operationAcceptedSchema = versionedResult({
  operationId: identifierSchema,
  accepted: z.literal(true),
});

const threadIdInputSchema = versionedResult({ threadId: identifierSchema });
const queueItemIdInputSchema = versionedResult({ itemId: identifierSchema });
const adminMutationBase = {
  username: identifierSchema,
  expectedRevision: z.number().int().nonnegative(),
} as const;

export const gatewayMethodDefinitions = {
  "host/ping": query(
    "pre-auth",
    versionedEmptySchema,
    versionedResult({
      hostId: identifierSchema,
      serverTime: timestampSchema,
      gatewayApiVersion: z.literal(GATEWAY_API_VERSION),
    }),
  ),
  "auth/status": query(
    "pre-auth",
    versionedEmptySchema,
    versionedResult({
      initialized: z.boolean(),
      authenticated: z.boolean(),
      passkeyAvailable: z.boolean(),
      passwordAvailable: z.boolean(),
      temporary: z.boolean(),
    }),
  ),
  "auth/register/options": mutation(
    "pre-auth",
    "ephemeral",
    versionedResult({ deviceName: shortTextSchema }),
    authenticationChallengeSchema,
  ),
  "auth/register/verify": mutation(
    "pre-auth",
    "durable",
    versionedResult({
      challengeId: identifierSchema,
      deviceName: shortTextSchema,
      response: jsonObjectSchema,
      rememberDevice: z.boolean(),
    }),
    authenticationResultSchema,
  ),
  "auth/login/options": mutation(
    "pre-auth",
    "ephemeral",
    versionedResult({ deviceName: shortTextSchema }),
    authenticationChallengeSchema,
  ),
  "auth/login/verify": mutation(
    "pre-auth",
    "ephemeral",
    versionedResult({
      challengeId: identifierSchema,
      response: jsonObjectSchema,
      deviceName: shortTextSchema,
      rememberDevice: z.boolean(),
    }),
    authenticationResultSchema,
  ),
  "auth/password/register/start": mutation(
    "pre-auth",
    "ephemeral",
    versionedResult({ registrationRequest: z.string().min(1).max(65_536) }),
    passwordChallengeSchema,
  ),
  "auth/password/register/finish": mutation(
    "pre-auth",
    "durable",
    versionedResult({
      challengeId: identifierSchema,
      registrationRecord: z.string().min(1).max(65_536),
      deviceName: shortTextSchema,
      rememberDevice: z.boolean(),
    }),
    authenticationResultSchema,
  ),
  "auth/password/login/start": mutation(
    "pre-auth",
    "ephemeral",
    versionedResult({ loginRequest: z.string().min(1).max(65_536) }),
    passwordChallengeSchema,
  ),
  "auth/password/login/finish": mutation(
    "pre-auth",
    "ephemeral",
    versionedResult({
      challengeId: identifierSchema,
      loginFinish: z.string().min(1).max(65_536),
      deviceName: shortTextSchema,
      rememberDevice: z.boolean(),
    }),
    authenticationResultSchema,
  ),
  "auth/recover": mutation(
    "pre-auth",
    "durable",
    versionedResult({
      recoveryCode: z.string().min(1).max(256),
      deviceName: shortTextSchema,
      rememberDevice: z.boolean(),
    }),
    authenticationResultSchema,
  ),
  "auth/recovery/rotate": mutation(
    "user",
    "durable",
    versionedEmptySchema,
    versionedResult({
      recoveryCodes: z.array(z.string().min(1).max(256)).min(1).max(32),
    }),
  ),
  "setup/status": query(
    "user",
    versionedEmptySchema,
    versionedResult({
      networkConfigured: z.boolean(),
      networkMode: z.enum(["direct", "proxy"]).optional(),
      codexInstalled: z.boolean(),
      codexVersion: z.string().max(256).optional(),
      codexAuthenticated: z.boolean(),
      appServerHealthy: z.boolean(),
      ready: z.boolean(),
    }),
  ),
  "setup/network/configure": mutation(
    "user",
    "durable",
    versionedResult({
      mode: z.enum(["direct", "proxy"]),
      httpProxy: z.string().url().max(4_096).optional(),
      httpsProxy: z.string().url().max(4_096).optional(),
      noProxy: z.string().max(16_384).optional(),
    }),
    versionedResult({
      configured: z.literal(true),
      mode: z.enum(["direct", "proxy"]),
    }),
  ),
  "setup/codex/install": mutation(
    "user",
    "durable",
    versionedResult({ versionConstraint: z.string().max(256).optional() }),
    operationAcceptedSchema,
  ),
  "setup/codex/version": query(
    "user",
    versionedEmptySchema,
    versionedResult({
      installed: z.boolean(),
      installedVersion: z.string().max(256).optional(),
      latestVersion: z.string().max(256).optional(),
      relation: z.enum(["older", "current", "newer", "unknown"]),
    }),
  ),
  "setup/codex/login/start": mutation(
    "user",
    "ephemeral",
    versionedEmptySchema,
    versionedResult({
      operationId: identifierSchema,
      verificationUri: z.string().url().max(4_096),
      userCode: z.string().min(1).max(256),
      expiresAt: timestampSchema,
      intervalSeconds: z.number().int().positive().max(300),
    }),
  ),
  "setup/codex/login/cancel": mutation(
    "user",
    "ephemeral",
    versionedResult({ operationId: identifierSchema }),
    booleanResult("cancelled"),
  ),
  "setup/codex/logout": mutation(
    "user",
    "durable",
    versionedEmptySchema,
    booleanResult("loggedOut"),
  ),
  "setup/app-server/restart": mutation(
    "user",
    "ephemeral",
    versionedEmptySchema,
    booleanResult("restarted"),
  ),
  "workspace/list": query(
    "user",
    versionedEmptySchema,
    versionedResult({ workspaces: z.array(workspaceSchema) }),
  ),
  "workspace/browse": query(
    "user",
    versionedResult({ path: pathSchema.optional() }),
    versionedResult({
      path: pathSchema,
      parent: pathSchema.optional(),
      entries: z.array(directoryEntrySchema).max(2_000),
    }),
  ),
  "workspace/add": mutation(
    "user",
    "durable",
    versionedResult({ path: pathSchema, label: shortTextSchema.optional() }),
    versionedResult({ workspace: workspaceSchema }),
  ),
  "workspace/remove": mutation(
    "user",
    "durable",
    versionedResult({
      workspaceId: identifierSchema,
      expectedRevision: z.number().int().nonnegative(),
    }),
    booleanResult("removed"),
  ),
  "workspace/default/read": query(
    "user",
    versionedEmptySchema,
    versionedResult({ workspaceId: identifierSchema.optional() }),
  ),
  "workspace/default/update": mutation(
    "user",
    "durable",
    versionedResult({ workspaceId: identifierSchema }),
    versionedResult({ workspaceId: identifierSchema }),
  ),
  "thread/list": query(
    "user",
    versionedResult({
      workspaceId: identifierSchema.optional(),
      archived: z.boolean().default(false),
      ...pageInputFields,
    }),
    versionedResult({
      threads: z.array(threadSummarySchema),
      ...pageResultFields,
    }),
  ),
  "thread/open": query(
    "user",
    versionedResult({
      threadId: identifierSchema,
      historyCursor: z.string().min(1).max(2_048).optional(),
      historyLimit: z.number().int().min(1).max(200).default(50),
    }),
    threadSnapshotSchema,
  ),
  "thread/history": query(
    "user",
    versionedResult({ threadId: identifierSchema, ...pageInputFields }),
    versionedResult({
      items: z.array(timelineItemSchema),
      ...pageResultFields,
    }),
  ),
  "thread/start": mutation(
    "user",
    "durable",
    versionedResult({
      workspaceId: identifierSchema,
      prompt: z.string().min(1).max(1_000_000),
      settings: threadSettingsSchema.partial().optional(),
    }),
    versionedResult({ thread: threadSummarySchema, turnId: identifierSchema }),
  ),
  "thread/close": mutation(
    "user",
    "ephemeral",
    threadIdInputSchema,
    booleanResult("closed"),
  ),
  "thread/rename": mutation(
    "user",
    "durable",
    versionedResult({
      threadId: identifierSchema,
      title: z.string().min(1).max(1_024),
    }),
    versionedResult({ thread: threadSummarySchema }),
  ),
  "thread/archive": mutation(
    "user",
    "durable",
    threadIdInputSchema,
    versionedResult({ thread: threadSummarySchema }),
  ),
  "thread/unarchive": mutation(
    "user",
    "durable",
    threadIdInputSchema,
    versionedResult({ thread: threadSummarySchema }),
  ),
  "thread/delete": mutation(
    "user",
    "durable",
    threadIdInputSchema,
    booleanResult("deleted"),
  ),
  "thread/settings/update": mutation(
    "user",
    "durable",
    versionedResult({
      threadId: identifierSchema,
      expectedRevision: z.number().int().nonnegative(),
      patch: threadSettingsSchema
        .omit({ version: true, revision: true })
        .partial(),
    }),
    threadSettingsSchema,
  ),
  "thread/tui/handoff": mutation(
    "user",
    "ephemeral",
    threadIdInputSchema,
    versionedResult({
      command: z.string().min(1).max(16_384),
      expiresAt: timestampSchema,
    }),
    GATEWAY_CAPABILITIES_V2.tuiHandoff,
  ),
  "turn/start": mutation(
    "user",
    "durable",
    versionedResult({
      threadId: identifierSchema,
      prompt: z.string().min(1).max(1_000_000),
    }),
    versionedResult({ threadId: identifierSchema, turnId: identifierSchema }),
  ),
  "turn/interrupt": mutation(
    "user",
    "ephemeral",
    versionedResult({
      threadId: identifierSchema,
      turnId: identifierSchema.optional(),
    }),
    booleanResult("interrupted"),
  ),
  "interaction/list": query(
    "user",
    threadIdInputSchema,
    versionedResult({ interactions: z.array(interactionSchema) }),
  ),
  "interaction/respond": mutation(
    "user",
    "durable",
    versionedResult({
      threadId: identifierSchema,
      interactionId: identifierSchema,
      response: jsonValueSchema,
    }),
    versionedResult({
      interactionId: identifierSchema,
      resolved: z.literal(true),
    }),
  ),
  "queue/list": query(
    "user",
    versionedResult({
      threadId: identifierSchema.optional(),
      ...pageInputFields,
    }),
    versionedResult({ items: z.array(queueItemSchema), ...pageResultFields }),
  ),
  "queue/add": mutation(
    "user",
    "durable",
    versionedResult({
      threadId: identifierSchema,
      text: z.string().min(1).max(1_000_000),
    }),
    versionedResult({ item: queueItemSchema }),
  ),
  "queue/remove": mutation(
    "user",
    "durable",
    queueItemIdInputSchema,
    booleanResult("removed"),
  ),
  "queue/steer": mutation(
    "user",
    "durable",
    versionedResult({
      itemId: identifierSchema,
      text: z.string().min(1).max(1_000_000),
    }),
    versionedResult({ item: queueItemSchema }),
    GATEWAY_CAPABILITIES_V2.queueSteer,
  ),
  "queue/indeterminate/acknowledge": mutation(
    "user",
    "durable",
    versionedResult({
      itemId: identifierSchema,
      disposition: z.enum(["retry", "dismiss"]),
    }),
    versionedResult({ item: queueItemSchema }),
  ),
  "mutation/status": query(
    "pre-auth",
    versionedResult({ operationKey: uuidSchema }),
    mutationStatusSchema,
  ),
  "preferences/read": query("user", versionedEmptySchema, preferencesSchema),
  "preferences/update": mutation(
    "user",
    "durable",
    versionedResult({
      expectedRevision: z.number().int().nonnegative(),
      patch: preferencesSchema
        .omit({ version: true, revision: true })
        .partial(),
    }),
    preferencesSchema,
  ),
  "admin/host/status": query(
    "admin",
    versionedEmptySchema,
    versionedResult({
      installationId: identifierSchema,
      serverName: shortTextSchema,
      controllerStartedAt: timestampSchema,
      managedUsers: z.number().int().nonnegative(),
      enabledUsers: z.number().int().nonnegative(),
      disabledUsers: z.number().int().nonnegative(),
      pendingRemovals: z.number().int().nonnegative(),
    }),
  ),
  "admin/user/inspect": query(
    "admin",
    versionedResult({ username: identifierSchema }),
    versionedResult({
      eligible: z.boolean(),
      reason: z.string().max(2_048).optional(),
      user: adminUserSchema.optional(),
    }),
  ),
  "admin/user/register": mutation(
    "admin",
    "durable",
    versionedResult({ username: identifierSchema }),
    versionedResult({ user: adminUserSchema }),
  ),
  "admin/user/disable": mutation(
    "admin",
    "durable",
    versionedResult(adminMutationBase),
    versionedResult({ user: adminUserSchema }),
  ),
  "admin/user/enable": mutation(
    "admin",
    "durable",
    versionedResult(adminMutationBase),
    versionedResult({ user: adminUserSchema }),
  ),
  "admin/user/removal/schedule": mutation(
    "admin",
    "durable",
    versionedResult({ ...adminMutationBase, removeAfter: timestampSchema }),
    versionedResult({ user: adminUserSchema }),
  ),
  "admin/user/removal/cancel": mutation(
    "admin",
    "durable",
    versionedResult(adminMutationBase),
    versionedResult({ user: adminUserSchema }),
  ),
  "admin/user/recovery/start": mutation(
    "admin",
    "durable",
    versionedResult(adminMutationBase),
    versionedResult({
      username: identifierSchema,
      handoffCode: z.string().min(1).max(256),
      expiresAt: timestampSchema,
    }),
  ),
  "admin/audit/list": query(
    "admin",
    versionedResult({
      username: identifierSchema.optional(),
      ...pageInputFields,
    }),
    versionedResult({ events: z.array(adminAuditSchema), ...pageResultFields }),
  ),
} as const satisfies Record<string, GatewayMethodDefinition<ZodType, ZodType>>;

export type GatewayMethodName = keyof typeof gatewayMethodDefinitions;
type DefinitionOf<MethodName extends GatewayMethodName> =
  (typeof gatewayMethodDefinitions)[MethodName];

export type InputOf<MethodName extends GatewayMethodName> = z.output<
  DefinitionOf<MethodName>["input"]
>;

export type OutputOf<MethodName extends GatewayMethodName> = z.output<
  DefinitionOf<MethodName>["output"]
>;

export type GatewayMethodMap = {
  [MethodName in GatewayMethodName]: Method<
    InputOf<MethodName>,
    OutputOf<MethodName>
  > & {
    readonly kind: DefinitionOf<MethodName>["kind"];
    readonly idempotency: DefinitionOf<MethodName>["idempotency"];
  };
};

export type RequestOptionsOf<MethodName extends GatewayMethodName> =
  DefinitionOf<MethodName>["kind"] extends "mutation"
    ? { readonly operationKey: string; readonly signal?: AbortSignal }
    : { readonly signal?: AbortSignal };

export function isGatewayMethodName(value: string): value is GatewayMethodName {
  return Object.hasOwn(gatewayMethodDefinitions, value);
}

export const gatewayMethodNames = Object.freeze(
  Object.keys(gatewayMethodDefinitions) as GatewayMethodName[],
);
