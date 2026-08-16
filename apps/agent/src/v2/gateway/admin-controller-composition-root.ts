import { Scope } from "@codex-everywhere/kernel";
import type { GatewayAuthenticationPayload } from "@codex-everywhere/protocol";
import {
  GatewayV2Error,
  GatewayV2Router,
  type GatewayHandler,
  type GatewayMethodName,
} from "@codex-everywhere/protocol/v2";

import type { AdminHelperV2Client } from "../admin/helper-protocol.js";
import type { AdminStateDatabase } from "../repositories/admin-state-database.js";
import {
  AdminProxyMutationMiddleware,
  AdminProxyService,
} from "../services/admin-proxy-service.js";
import {
  IdentityService,
  type IdentityServiceConfiguration,
} from "../services/identity-service.js";
import { AgentMutationMiddleware } from "../services/mutation-middleware.js";
import { SessionTicketService } from "../services/session-ticket-service.js";
import {
  AdminGatewaySession,
  type AdminGatewayContext,
} from "./admin-gateway-session.js";
import { AdminTransportSession } from "./admin-transport-session.js";
import type {
  GatewayTrustedDevice,
  GatewayV2Session,
} from "./transport-contract.js";
import { ADMIN_METHODS, IDENTITY_METHODS } from "./handler-types.js";

export interface AdminControllerCompositionOptions {
  readonly state: AdminStateDatabase;
  readonly helper: AdminHelperV2Client;
  readonly installationId: string;
  readonly hostId: string;
  readonly identity: IdentityServiceConfiguration;
}

export interface AdminControllerCompositionRoot {
  readonly scope: Scope;
  readonly router: GatewayV2Router<AdminGatewayContext>;
  readonly identity: IdentityService;
  readonly admin: AdminProxyService;
  readonly tickets: SessionTicketService;
  createTransportSession(
    device: GatewayTrustedDevice,
    context: {
      readonly authenticationMode: GatewayAuthenticationPayload["mode"];
      readonly resumeToken?: string;
    },
  ): GatewayV2Session;
  close(): Promise<void>;
}

/** Unprivileged Web controller. High-level admin mutations cross one sudo IPC. */
export async function createAdminControllerCompositionRoot(
  options: AdminControllerCompositionOptions,
): Promise<AdminControllerCompositionRoot> {
  const scope = new Scope("admin-controller-v0.4");
  try {
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
    const localMutations = new AgentMutationMiddleware({
      scope,
      resolveRepository: () => options.state.mutationReceipts,
    });
    await localMutations.recoverPending([`admin:${options.installationId}`]);
    const mutations = new AdminProxyMutationMiddleware({
      local: localMutations,
      helper: options.helper,
    });
    const admin = new AdminProxyService({
      helper: options.helper,
      mutations,
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

    return {
      scope,
      router,
      identity,
      admin,
      tickets,
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
      close: () => scope.close("admin-controller-composition-closed"),
    };
  } catch (error) {
    await scope
      .close("admin-controller-composition-failed")
      .catch(() => undefined);
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
