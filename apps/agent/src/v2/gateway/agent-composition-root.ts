import {
  ServiceRegistry,
  Scope,
  TypedEventBus,
  createServiceToken,
} from "@codex-everywhere/kernel";
import {
  GATEWAY_CAPABILITIES_V2,
  gatewayEventEnvelopeV2,
  GatewayV2Error,
  GatewayV2Router,
  type GatewayEventEnvelopeV2,
} from "@codex-everywhere/protocol/v2";

import type { HostPaths } from "../../host/paths.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import type { UserStateDatabase } from "../repositories/user-state-database.js";
import {
  CodexSupervisor,
  type CodexSupervisorDependencies,
  type CodexSupervisorPort,
} from "../services/codex-supervisor.js";
import {
  IdentityService,
  type IdentityServiceConfiguration,
} from "../services/identity-service.js";
import { AgentMutationMiddleware } from "../services/mutation-middleware.js";
import { PreferencesService } from "../services/preferences-service.js";
import { QueueService } from "../services/queue-service.js";
import { SessionTicketService } from "../services/session-ticket-service.js";
import { ThreadLeaseManager } from "../services/thread-lease-manager.js";
import { ThreadService } from "../services/thread-service.js";
import { WorkspaceService } from "../services/workspace-service.js";
import {
  SetupService,
  type SetupServiceDependencies,
} from "../services/setup-service.js";
import {
  AgentGatewaySession,
  type AgentGatewaySessionConfiguration,
  type AgentGatewayContext,
} from "./agent-gateway-session.js";
import { AgentTransportSession } from "./agent-transport-session.js";
import type {
  GatewayTransportAuthenticationContext,
  GatewayTrustedDevice,
  GatewayV2Session,
} from "./transport-contract.js";
import {
  IDENTITY_METHODS,
  SETUP_METHODS,
  type IdentityHandlerMap,
  type SetupHandlerMap,
} from "./handler-types.js";
import {
  queueItemView,
  registerAgentCoreHandlers,
  registerAgentHandlerMap,
} from "./agent-core-handlers.js";

export interface AgentCompositionOptions {
  readonly state: UserStateDatabase;
  readonly clients: CodexClientFactoryPort;
  readonly hostId: string;
  readonly identity?: IdentityServiceConfiguration;
  readonly identityHandlers?: IdentityHandlerMap;
  readonly setup?: AgentSetupConfiguration;
  readonly setupHandlers?: SetupHandlerMap;
  readonly home?: string;
  readonly appServerSocketPath?: string;
  readonly maximumThreadLeases?: number;
  readonly startQueue?: boolean;
}

export interface AgentSetupConfiguration {
  readonly paths: HostPaths;
  readonly userHome?: string;
  readonly supervisor?: CodexSupervisorPort;
  readonly supervisorDependencies?: Partial<CodexSupervisorDependencies>;
  readonly dependencies?: Partial<SetupServiceDependencies>;
  readonly assertRestartSafe?: () => void | Promise<void>;
}

export interface AgentCompositionRoot {
  readonly scope: Scope;
  readonly registry: ServiceRegistry;
  readonly router: GatewayV2Router<AgentGatewayContext>;
  readonly leases: ThreadLeaseManager;
  readonly queue: QueueService;
  readonly threads: ThreadService;
  readonly workspaces: WorkspaceService;
  readonly preferences: PreferencesService;
  readonly identity?: IdentityService;
  readonly setup?: SetupService;
  readonly supervisor?: CodexSupervisorPort;
  readonly tickets: SessionTicketService;
  createSession(
    options?: AgentGatewaySessionConfiguration,
  ): AgentGatewaySession;
  createTransportSession(
    device: GatewayTrustedDevice,
    context: GatewayTransportAuthenticationContext,
  ): GatewayV2Session;
  close(): Promise<void>;
}

export const AGENT_SERVICE_TOKENS = {
  state: createServiceToken<UserStateDatabase>("agent.state"),
  clients: createServiceToken<CodexClientFactoryPort>("agent.codex-clients"),
  leases: createServiceToken<ThreadLeaseManager>("agent.thread-leases"),
  queue: createServiceToken<QueueService>("agent.queue"),
  threads: createServiceToken<ThreadService>("agent.threads"),
  workspaces: createServiceToken<WorkspaceService>("agent.workspaces"),
  preferences: createServiceToken<PreferencesService>("agent.preferences"),
  identity: createServiceToken<IdentityService>("agent.identity"),
  setup: createServiceToken<SetupService>("agent.setup"),
  supervisor: createServiceToken<CodexSupervisorPort>("agent.supervisor"),
  tickets: createServiceToken<SessionTicketService>("agent.session-tickets"),
} as const;

export async function createAgentCompositionRoot(
  options: AgentCompositionOptions,
): Promise<AgentCompositionRoot> {
  const scope = new Scope("agent-v0.4");
  const registry = new ServiceRegistry();
  try {
    registry.register(AGENT_SERVICE_TOKENS.state, options.state);
    registry.register(AGENT_SERVICE_TOKENS.clients, options.clients);
    scope.defer(() => options.state.close());

    const workspaces = new WorkspaceService(options.state.workspaces, {
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    const preferences = new PreferencesService(options.state.preferences);
    const leases = new ThreadLeaseManager({
      scope,
      clientFactory: options.clients,
      ...(options.maximumThreadLeases === undefined
        ? {}
        : { maximumLeases: options.maximumThreadLeases }),
    });
    const queue = new QueueService({
      scope,
      repository: options.state.queue,
      leases,
      authorizeWorkspace: (path) => workspaces.resolve(path),
    });
    const threads = new ThreadService({
      scope,
      clients: options.clients,
      leases,
      workspaces,
      preferences,
      settings: options.state.threadSettings,
      ...(options.appServerSocketPath === undefined
        ? {}
        : { appServerSocketPath: options.appServerSocketPath }),
    });
    registry.register(AGENT_SERVICE_TOKENS.workspaces, workspaces);
    registry.register(AGENT_SERVICE_TOKENS.preferences, preferences);
    registry.register(AGENT_SERVICE_TOKENS.leases, leases);
    registry.register(AGENT_SERVICE_TOKENS.queue, queue);
    registry.register(AGENT_SERVICE_TOKENS.threads, threads);

    const tickets = new SessionTicketService({ scope });
    registry.register(AGENT_SERVICE_TOKENS.tickets, tickets);

    if (
      options.identity !== undefined &&
      options.identityHandlers !== undefined
    ) {
      throw new Error(
        "Configure IdentityService or identity handlers, not both",
      );
    }
    const identity =
      options.identity === undefined
        ? undefined
        : new IdentityService({
            scope,
            repository: options.state.identity,
            tickets,
            ...options.identity,
          });
    if (identity !== undefined) {
      registry.register(AGENT_SERVICE_TOKENS.identity, identity);
    }

    if (options.setup !== undefined && options.setupHandlers !== undefined) {
      throw new Error("Configure SetupService or setup handlers, not both");
    }
    const supervisor =
      options.setup === undefined
        ? undefined
        : (options.setup.supervisor ??
          new CodexSupervisor({
            scope,
            paths: options.setup.paths,
            ...(options.setup.userHome === undefined
              ? {}
              : { userHome: options.setup.userHome }),
            ...(options.setup.supervisorDependencies === undefined
              ? {}
              : { dependencies: options.setup.supervisorDependencies }),
          }));
    const setup =
      options.setup === undefined || supervisor === undefined
        ? undefined
        : new SetupService({
            scope,
            paths: options.setup.paths,
            coordination: options.state,
            supervisor,
            clients: options.clients,
            ...(options.setup.userHome === undefined
              ? {}
              : { userHome: options.setup.userHome }),
            ...(options.setup.dependencies === undefined
              ? {}
              : { dependencies: options.setup.dependencies }),
            assertRestartSafe: async () => {
              const busyThreads = leases.busyThreadIds;
              if (busyThreads.length > 0) {
                throw new GatewayV2Error(
                  "APP_SERVER_BUSY",
                  "Cannot restart Codex app-server while a task is active or waiting for input",
                );
              }
              await options.setup?.assertRestartSafe?.();
            },
          });
    if (supervisor !== undefined) {
      registry.register(AGENT_SERVICE_TOKENS.supervisor, supervisor);
    }
    if (setup !== undefined) {
      registry.register(AGENT_SERVICE_TOKENS.setup, setup);
    }

    const identityHandlers = identity?.handlers ?? options.identityHandlers;
    if (identityHandlers === undefined) {
      throw new Error("Agent composition requires identity configuration");
    }
    const setupHandlers = setup?.handlers ?? options.setupHandlers;
    if (setupHandlers === undefined) {
      throw new Error("Agent composition requires setup configuration");
    }

    const mutationMiddleware = new AgentMutationMiddleware({
      scope,
      resolveRepository: () => options.state.mutationReceipts,
    });
    await mutationMiddleware.recoverPending(["user"]);

    const globalEvents = new TypedEventBus<{
      readonly event: GatewayEventEnvelopeV2;
    }>();
    scope.defer(() => globalEvents.clear());
    const publish = (event: GatewayEventEnvelopeV2): void => {
      try {
        globalEvents.emit("event", event);
      } catch {
        // A disconnected session cannot change a service-side outcome.
      }
    };
    scope.defer(
      queue.events.on("changed", (item) =>
        publish(
          gatewayEventEnvelopeV2("queue/changed", {
            version: 1,
            item: queueItemView(item),
          }),
        ),
      ),
    );
    scope.defer(
      queue.events.on("removed", ({ itemId }) =>
        publish(
          gatewayEventEnvelopeV2("queue/removed", { version: 1, itemId }),
        ),
      ),
    );
    scope.defer(
      queue.events.on("delivery", (delivery) =>
        publish(
          gatewayEventEnvelopeV2("queue/delivery", {
            version: 1,
            ...delivery,
          }),
        ),
      ),
    );
    if (setup !== undefined) {
      scope.defer(
        setup.events.on("event", (event) => {
          if (event.type === "setup/codex/install/progress") {
            publish(gatewayEventEnvelopeV2(event.type, event.payload));
          } else {
            publish(gatewayEventEnvelopeV2(event.type, event.payload));
          }
        }),
      );
    }
    if (options.startQueue !== false) await queue.start();

    const router = new GatewayV2Router<AgentGatewayContext>(mutationMiddleware);
    registerAgentHandlerMap(router, identityHandlers, IDENTITY_METHODS);
    registerAgentHandlerMap(router, setupHandlers, SETUP_METHODS);
    registerAgentCoreHandlers(router, {
      hostId: options.hostId,
      mutationMiddleware,
      workspaces,
      preferences,
      queue,
      threads,
    });
    router.seal({ access: new Set(["pre-auth", "user"]) });
    registry.seal();

    return {
      scope,
      registry,
      router,
      leases,
      queue,
      threads,
      workspaces,
      preferences,
      ...(identity === undefined ? {} : { identity }),
      ...(setup === undefined ? {} : { setup }),
      ...(supervisor === undefined ? {} : { supervisor }),
      tickets,
      createSession: (sessionOptions = {}) =>
        new AgentGatewaySession({
          parentScope: scope,
          leases,
          subscribeGlobalEvents: (listener) =>
            globalEvents.on("event", listener),
          ...sessionOptions,
        }),
      createTransportSession: (device, transportContext) => {
        let authentication:
          | {
              readonly access: "user";
              readonly principalId: string;
              readonly temporary: boolean;
            }
          | undefined;
        if (
          transportContext.authenticationMode === "pair" ||
          transportContext.authenticationMode === "connect"
        ) {
          authentication = {
            access: "user",
            principalId: `user:${options.identity?.loginName ?? "local"}`,
            temporary: false,
          };
        } else if (transportContext.authenticationMode === "resume") {
          const binding =
            transportContext.resumeToken === undefined
              ? undefined
              : tickets.verify(transportContext.resumeToken, device);
          if (binding === undefined) throw new Error("REAUTH_REQUIRED");
          authentication = {
            access: "user",
            principalId: binding.principalId,
            temporary: binding.temporary,
          };
        }
        const session = new AgentGatewaySession({
          parentScope: scope,
          leases,
          subscribeGlobalEvents: (listener) =>
            globalEvents.on("event", listener),
          device: {
            id: device.id,
            name: device.name,
            publicKey: device.publicKey,
          },
          assertDeviceCurrent: async () => {
            try {
              await options.state.identity.verifyDevice(
                device.id,
                device.publicKey,
              );
            } catch {
              tickets.revokeDevice(device.id);
              throw new GatewayV2Error(
                "REAUTH_REQUIRED",
                "This device is no longer trusted",
                { closeConnection: true },
              );
            }
          },
          ...(authentication ?? {}),
        });
        return new AgentTransportSession({
          session,
          router,
          capabilities: new Set(Object.values(GATEWAY_CAPABILITIES_V2)),
        });
      },
      close: () => scope.close("agent-composition-closed"),
    };
  } catch (error) {
    await scope.close("agent-composition-failed").catch(() => undefined);
    throw error;
  }
}
