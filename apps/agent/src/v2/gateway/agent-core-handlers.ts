import {
  GatewayV2Error,
  type GatewayHandler,
  type GatewayMethodName,
  type GatewayV2Router,
  gatewayMethodDefinitions,
  type InputOf,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import type { AgentMutationMiddleware } from "../services/mutation-middleware.js";
import type { ModelCatalogService } from "../services/model-catalog-service.js";
import type { PreferencesService } from "../services/preferences-service.js";
import type { QueueService } from "../services/queue-service.js";
import type { ThreadService } from "../services/thread-service.js";
import type { WorkspaceService } from "../services/workspace-service.js";
import type { AgentGatewayContext } from "./agent-gateway-session.js";
import { IDENTITY_METHODS, SETUP_METHODS } from "./handler-types.js";

export interface AgentCoreHandlerServices {
  readonly hostId: string;
  readonly mutationMiddleware: AgentMutationMiddleware;
  readonly workspaces: WorkspaceService;
  readonly preferences: PreferencesService;
  readonly queue: QueueService;
  readonly models: ModelCatalogService;
  readonly threads: ThreadService;
}

export function registerAgentCoreHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  registerHostHandlers(router, services);
  registerWorkspaceHandlers(router, services);
  registerModelHandlers(router, services);
  registerThreadHandlers(router, services);
  registerQueueHandlers(router, services);
  registerPreferenceHandlers(router, services);
}

function registerModelHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  router.register("model/list", (input) => services.models.list(input));
}

export function registerAgentHandlerMap<Methods extends GatewayMethodName>(
  router: GatewayV2Router<AgentGatewayContext>,
  handlers: {
    readonly [Method in Methods]: GatewayHandler<Method, AgentGatewayContext>;
  },
  methods: readonly Methods[],
): void {
  for (const method of methods) {
    router.register(method, handlers[method]);
  }
}

export function queueItemView(
  item: Awaited<ReturnType<QueueService["add"]>>,
): OutputOf<"queue/add">["item"] {
  return {
    version: 1,
    id: item.id,
    threadId: item.threadId,
    text: item.text,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revision: item.revision,
    ...(item.indeterminateReason === undefined
      ? {}
      : { indeterminateReason: item.indeterminateReason }),
  };
}

function registerHostHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  router.register("host/ping", () => ({
    version: 1,
    hostId: services.hostId,
    serverTime: new Date().toISOString(),
    gatewayApiVersion: 2,
  }));
  router.register("mutation/status", (input, context) =>
    services.mutationMiddleware.status(context.principalId, input.operationKey),
  );
}

function registerWorkspaceHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  router.register("workspace/list", async () => ({
    version: 1,
    workspaces: await services.workspaces.list(),
  }));
  router.register("workspace/browse", async (input) => ({
    version: 1,
    ...(await services.workspaces.browse(input.path)),
  }));
  router.register("workspace/add", async (input) => ({
    version: 1,
    workspace: await services.workspaces.add(input.path, input.label),
  }));
  router.register("workspace/remove", async (input) => {
    if (
      !(await services.workspaces.remove(
        input.workspaceId,
        input.expectedRevision,
      ))
    ) {
      throw new GatewayV2Error("WORKSPACE_NOT_FOUND", "Workspace not found");
    }
    return { version: 1, removed: true };
  });
  router.register("workspace/default/read", async () => ({
    version: 1,
    ...optional("workspaceId", await services.workspaces.defaultId()),
  }));
  router.register("workspace/default/update", async (input) => ({
    version: 1,
    workspaceId: await services.workspaces.setDefault(input.workspaceId),
  }));
}

function registerThreadHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  router.register("thread/list", (input) => services.threads.list(input));
  router.register("thread/open", async (input, context) => {
    const handle = await context.session.openThread(input.threadId);
    try {
      return await services.threads.open(handle, input);
    } catch (error) {
      await context.session.closeThread(input.threadId);
      throw error;
    }
  });
  router.register("thread/history", (input, context) =>
    services.threads.history(
      context.session.requireThread(input.threadId),
      input,
    ),
  );
  router.register("thread/start", (input) => services.threads.start(input));
  router.register("thread/close", async (input, context) => {
    await context.session.closeThread(input.threadId);
    return { version: 1, closed: true };
  });
  router.register("thread/rename", async (input) => ({
    version: 1,
    thread: await services.threads.rename(input.threadId, input.title),
  }));
  router.register("thread/archive", async (input) => ({
    version: 1,
    thread: await services.threads.archive(input.threadId),
  }));
  router.register("thread/unarchive", async (input) => ({
    version: 1,
    thread: await services.threads.unarchive(input.threadId),
  }));
  router.register("thread/delete", async (input, context) => {
    await context.session.closeThread(input.threadId);
    await services.threads.delete(input.threadId);
    return { version: 1, deleted: true };
  });
  router.register("thread/settings/update", (input, context) =>
    services.threads.updateSettings(
      context.session.requireThread(input.threadId),
      input,
    ),
  );
  router.register("thread/tui/handoff", (input) =>
    services.threads.tuiHandoff(input.threadId),
  );
  router.register("turn/start", (input, context) =>
    services.threads.turnStart(
      context.session.requireThread(input.threadId),
      input.prompt,
    ),
  );
  router.register("turn/interrupt", (input, context) =>
    services.threads.interrupt(
      context.session.requireThread(input.threadId),
      input.turnId,
    ),
  );
  router.register("interaction/list", (input, context) =>
    services.threads.listInteractions(
      context.session.requireThread(input.threadId),
    ),
  );
  router.register("interaction/respond", (input, context) =>
    services.threads.respondToInteraction(
      context.session.requireThread(input.threadId),
      input.interactionId,
      input.response,
    ),
  );
}

function registerQueueHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  router.register("queue/list", async (input) => {
    const items = (await services.queue.list(input.threadId)).map(
      queueItemView,
    );
    return queuePage(items, input.cursor, input.limit);
  });
  router.register("queue/add", async (input) => ({
    version: 1,
    item: queueItemView(await services.queue.add(input)),
  }));
  router.register("queue/remove", async (input) => {
    if (!(await services.queue.remove(input.itemId))) {
      throw new GatewayV2Error(
        "QUEUE_STATE_CONFLICT",
        "Queue item is missing or cannot be removed",
      );
    }
    return { version: 1, removed: true };
  });
  router.register("queue/steer", async (input) => ({
    version: 1,
    item: queueItemView(await services.queue.steer(input.itemId, input.text)),
  }));
  router.register("queue/indeterminate/acknowledge", async (input) => ({
    version: 1,
    item: queueItemView(
      await services.queue.acknowledgeIndeterminate(
        input.itemId,
        input.disposition,
      ),
    ),
  }));
}

function registerPreferenceHandlers(
  router: GatewayV2Router<AgentGatewayContext>,
  services: AgentCoreHandlerServices,
): void {
  router.register("preferences/read", () => services.preferences.read());
  router.register("preferences/update", (input) =>
    services.preferences.update(
      input.expectedRevision,
      compactPreferencesPatch(input.patch),
    ),
  );
}

function compactPreferencesPatch(
  patch: InputOf<"preferences/update">["patch"],
): Parameters<PreferencesService["update"]>[1] {
  return {
    ...(patch.theme === undefined ? {} : { theme: patch.theme }),
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
    ...(patch.defaultWorkspaceId === undefined
      ? {}
      : { defaultWorkspaceId: patch.defaultWorkspaceId }),
    ...(patch.sandbox === undefined ? {} : { sandbox: patch.sandbox }),
    ...(patch.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: patch.approvalPolicy }),
  };
}

function queuePage(
  items: OutputOf<"queue/add">["item"][],
  cursor: string | undefined,
  limit: number,
): OutputOf<"queue/list"> {
  let start = 0;
  if (cursor !== undefined) {
    const afterId = decodeQueueCursor(cursor);
    const index = items.findIndex((item) => item.id === afterId);
    if (index < 0) {
      throw new GatewayV2Error("QUEUE_CURSOR_STALE", "Queue cursor is stale");
    }
    start = index + 1;
  }
  const page = items.slice(start, start + limit);
  const hasMore = start + page.length < items.length;
  return {
    version: 1,
    items: page,
    ...(hasMore && page.length > 0
      ? { nextCursor: encodeQueueCursor(page.at(-1)!.id) }
      : {}),
    hasMore,
  };
}

function encodeQueueCursor(itemId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, afterItemId: itemId }),
  ).toString("base64url");
}

function decodeQueueCursor(cursor: string): string {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).version === 1 &&
      typeof (value as Record<string, unknown>).afterItemId === "string"
    ) {
      return (value as { afterItemId: string }).afterItemId;
    }
  } catch {
    // Converted into a stable public error below.
  }
  throw new GatewayV2Error("INVALID_CURSOR", "Queue cursor is invalid");
}

function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { readonly [Property in Key]?: Value } {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [Property in Key]: Value });
}

// Router sealing catches runtime omissions; this inventory keeps protocol metadata
// and the statically registered user method set visible to the type checker.
const AGENT_CORE_METHODS = Object.freeze(
  (Object.keys(gatewayMethodDefinitions) as GatewayMethodName[]).filter(
    (method) =>
      gatewayMethodDefinitions[method].access !== "admin" &&
      !IDENTITY_METHODS.includes(method as (typeof IDENTITY_METHODS)[number]) &&
      !SETUP_METHODS.includes(method as (typeof SETUP_METHODS)[number]),
  ),
);
void AGENT_CORE_METHODS;
