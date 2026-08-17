import { join } from "node:path";

import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayV2Router,
  gatewaySuccessResponse,
} from "@codex-everywhere/protocol/v2";

import type { AdminInstallationV2 } from "../../admin/controller-config.js";
import { HostAdminSystemAdapter } from "../adapters/admin-system-adapter.js";
import {
  AdminGatewaySession,
  adminGatewayContext,
  type AdminGatewayContext,
} from "../gateway/admin-gateway-session.js";
import {
  ADMIN_METHODS,
  type AdminHandlerMap,
} from "../gateway/handler-types.js";
import { AdminStateDatabase } from "../repositories/admin-state-database.js";
import { AdminMutationMiddleware } from "../services/admin-mutation-middleware.js";
import { AdminService } from "../services/admin-service.js";
import { AgentMutationMiddleware } from "../services/mutation-middleware.js";
import {
  parseAdminHelperV2Request,
  type AdminHelperV2Request,
} from "./helper-protocol.js";

export async function executeAdminHelperV2(input: {
  readonly request: unknown;
  readonly installation: AdminInstallationV2;
  readonly nodePath: string;
  readonly cliPath: string;
}): Promise<unknown> {
  const request = parseAdminHelperV2Request(input.request);
  const statePath = join(input.installation.home, "state.sqlite");
  const state = await AdminStateDatabase.open(statePath, {
    owner: {
      uid: input.installation.runAsUid,
      gid: input.installation.runAsGid,
    },
  });
  const scope = new Scope("admin-helper-v0.4");
  try {
    const durable = new AgentMutationMiddleware({
      scope,
      resolveRepository: () => state.mutationReceipts,
    });
    const mutations = new AdminMutationMiddleware({
      inner: durable,
      repository: state.admin,
    });
    if (request.kind === "mutation-status") {
      return gatewaySuccessResponse(
        request.requestId,
        await mutations.status(request.actor, request.operationKey),
      );
    }
    const service = new AdminService({
      repository: state.admin,
      system: new HostAdminSystemAdapter({
        nodePath: input.nodePath,
        cliPath: input.cliPath,
      }),
      installationId: input.installation.installationId,
      serverName: input.installation.serverName,
    });
    const router = new GatewayV2Router<AdminGatewayContext>(mutations);
    registerHandlerMap(router, service.handlers, ADMIN_METHODS);
    router.seal({ access: new Set(["admin"]) });
    const session = new AdminGatewaySession({
      parentScope: scope,
      access: "admin",
      principalId: request.actor,
      temporary: false,
    });
    return (
      await router.route(request.request, adminGatewayContext({ session }))
    ).response;
  } finally {
    await scope.close("admin-helper-complete");
    await state.close();
  }
}

export async function runAdminMaintenanceV2(input: {
  readonly installation: AdminInstallationV2;
  readonly nodePath: string;
  readonly cliPath: string;
}): Promise<number> {
  const state = await AdminStateDatabase.open(
    join(input.installation.home, "state.sqlite"),
    {
      owner: {
        uid: input.installation.runAsUid,
        gid: input.installation.runAsGid,
      },
    },
  );
  try {
    return await new AdminService({
      repository: state.admin,
      system: new HostAdminSystemAdapter({
        nodePath: input.nodePath,
        cliPath: input.cliPath,
      }),
      installationId: input.installation.installationId,
      serverName: input.installation.serverName,
    }).maintenance();
  } finally {
    await state.close();
  }
}

function registerHandlerMap(
  router: GatewayV2Router<AdminGatewayContext>,
  handlers: AdminHandlerMap<AdminGatewayContext>,
  methods: typeof ADMIN_METHODS,
): void {
  for (const method of methods)
    router.register(method, handlers[method] as never);
}

export function isAdminHelperV2Request(
  request: AdminHelperV2Request | { readonly version?: unknown },
): request is AdminHelperV2Request {
  return request.version === 2;
}
