import {
  ServiceRegistry,
  Scope,
  createServiceToken,
} from "@codex-everywhere/kernel";
import {
  GatewayV2Error,
  GatewayV2Router,
  type GatewayHandler,
  type GatewayMethodName,
} from "@codex-everywhere/protocol/v2";

import type { AdminStateDatabase } from "../repositories/admin-state-database.js";
import { AdminMutationMiddleware } from "../services/admin-mutation-middleware.js";
import {
  AdminService,
  type AdminSystemPort,
} from "../services/admin-service.js";
import {
  IdentityService,
  type IdentityServiceConfiguration,
} from "../services/identity-service.js";
import { AgentMutationMiddleware } from "../services/mutation-middleware.js";
import { SessionTicketService } from "../services/session-ticket-service.js";
import {
  AdminGatewaySession,
  type AdminGatewayContext,
  type AdminGatewaySessionOptions,
} from "./admin-gateway-session.js";
import { AdminTransportSession } from "./admin-transport-session.js";
import type {
  GatewayTransportAuthenticationContext,
  GatewayTrustedDevice,
  GatewayV2Session,
} from "./transport-contract.js";
import {
  ADMIN_METHODS,
  IDENTITY_METHODS,
  type AdminHandlerMap,
  type IdentityHandlerMap,
} from "./handler-types.js";

export interface AdminCompositionOptions {
  readonly state: AdminStateDatabase;
  readonly system: AdminSystemPort;
  readonly installationId: string;
  readonly serverName: string;
  readonly hostId: string;
  readonly identity: IdentityServiceConfiguration;
  readonly maintenanceIntervalMs?: number;
  readonly onMaintenanceError?: (error: unknown) => void;
}

export interface AdminCompositionRoot {
  readonly scope: Scope;
  readonly registry: ServiceRegistry;
  readonly router: GatewayV2Router<AdminGatewayContext>;
  readonly admin: AdminService;
  readonly identity: IdentityService;
  readonly tickets: SessionTicketService;
  createSession(
    options?: Omit<AdminGatewaySessionOptions, "parentScope">,
  ): AdminGatewaySession;
  createTransportSession(
    device: GatewayTrustedDevice,
    context: GatewayTransportAuthenticationContext,
  ): GatewayV2Session;
  close(): Promise<void>;
}

export const ADMIN_SERVICE_TOKENS = {
  state: createServiceToken<AdminStateDatabase>("admin.state"),
  admin: createServiceToken<AdminService>("admin.service"),
  identity: createServiceToken<IdentityService>("admin.identity"),
  tickets: createServiceToken<SessionTicketService>("admin.session-tickets"),
} as const;

export async function createAdminCompositionRoot(
  options: AdminCompositionOptions,
): Promise<AdminCompositionRoot> {
  const scope = new Scope("admin-v0.4");
  const registry = new ServiceRegistry();
  try {
    registry.register(ADMIN_SERVICE_TOKENS.state, options.state);
    scope.defer(() => options.state.close());

    const tickets = new SessionTicketService({ scope });
    const identity = new IdentityService({
      scope,
      repository: options.state.identity,
      tickets,
      ...options.identity,
      access: "admin",
      principal: "host-admin",
      principalId: `admin:${options.installationId}`,
    });
    const admin = new AdminService({
      repository: options.state.admin,
      system: options.system,
      installationId: options.installationId,
      serverName: options.serverName,
    });
    registry.register(ADMIN_SERVICE_TOKENS.tickets, tickets);
    registry.register(ADMIN_SERVICE_TOKENS.identity, identity);
    registry.register(ADMIN_SERVICE_TOKENS.admin, admin);

    const durableMutations = new AgentMutationMiddleware({
      scope,
      resolveRepository: () => options.state.mutationReceipts,
    });
    await durableMutations.recoverPending([`admin:${options.installationId}`]);
    const mutations = new AdminMutationMiddleware({
      inner: durableMutations,
      repository: options.state.admin,
    });
    const router = new GatewayV2Router<AdminGatewayContext>(mutations);
    registerHandlerMap(router, identity.handlers, IDENTITY_METHODS);
    registerHandlerMap(router, admin.handlers, ADMIN_METHODS);
    router.register("host/ping", () => ({
      version: 1,
      hostId: options.hostId,
      serverTime: new Date().toISOString(),
      gatewayApiVersion: 2,
    }));
    router.register("mutation/status", (input, context) =>
      mutations.status(context.principalId, input.operationKey),
    );
    router.seal({ access: new Set(["pre-auth", "admin"]) });
    registry.seal();

    const maintenanceIntervalMs = options.maintenanceIntervalMs ?? 60_000;
    if (
      !Number.isSafeInteger(maintenanceIntervalMs) ||
      maintenanceIntervalMs < 1_000
    ) {
      throw new Error("Administrator maintenance interval is invalid");
    }
    let maintenanceRunning = false;
    const runMaintenance = (): void => {
      if (maintenanceRunning) return;
      maintenanceRunning = true;
      void admin
        .maintenance()
        .catch((error) => options.onMaintenanceError?.(error))
        .finally(() => {
          maintenanceRunning = false;
        });
    };
    scope.setInterval(runMaintenance, maintenanceIntervalMs);

    return {
      scope,
      registry,
      router,
      admin,
      identity,
      tickets,
      createSession: (sessionOptions = {}) =>
        new AdminGatewaySession({ parentScope: scope, ...sessionOptions }),
      createTransportSession: (device, transportContext) => {
        let authentication:
          | {
              readonly access: "admin";
              readonly principalId: string;
              readonly temporary: boolean;
            }
          | undefined;
        if (
          transportContext.authenticationMode === "pair" ||
          transportContext.authenticationMode === "connect"
        ) {
          authentication = {
            access: "admin",
            principalId: `admin:${options.installationId}`,
            temporary: false,
          };
        } else if (transportContext.authenticationMode === "resume") {
          const binding =
            transportContext.resumeToken === undefined
              ? undefined
              : tickets.verify(transportContext.resumeToken, device);
          if (binding === undefined) {
            throw new GatewayV2Error(
              "REAUTH_REQUIRED",
              "Administrator authentication must be repeated",
            );
          }
          authentication = {
            access: "admin",
            principalId: binding.principalId,
            temporary: binding.temporary,
          };
        }
        const session = new AdminGatewaySession({
          parentScope: scope,
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
                "This administrator device is no longer trusted",
                { closeConnection: true },
              );
            }
          },
          ...(authentication ?? {}),
        });
        return new AdminTransportSession({ session, router });
      },
      close: () => scope.close("admin-composition-closed"),
    };
  } catch (error) {
    await scope.close("admin-composition-failed").catch(() => undefined);
    throw error;
  }
}

function registerHandlerMap<
  Context extends AdminGatewayContext,
  Methods extends GatewayMethodName,
>(
  router: GatewayV2Router<Context>,
  handlers: {
    readonly [Method in Methods]: GatewayHandler<Method, Context>;
  },
  methods: readonly Methods[],
): void {
  for (const method of methods) router.register(method, handlers[method]);
}
