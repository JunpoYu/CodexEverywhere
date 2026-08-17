import { AsyncLocalStorage } from "node:async_hooks";

import type {
  GatewayMutationMiddleware,
  MutationInvocation,
  MutationStatus,
} from "@codex-everywhere/protocol/v2";

import type { AdminHelperV2Client } from "../admin/helper-protocol.js";
import type { AdminGatewayContext } from "../gateway/admin-gateway-session.js";
import type { AdminHandlerMap } from "../gateway/handler-types.js";
import type { AgentMutationMiddleware } from "./mutation-middleware.js";

export class AdminProxyMutationMiddleware implements GatewayMutationMiddleware {
  readonly #local: AgentMutationMiddleware;
  readonly #helper: Pick<AdminHelperV2Client, "mutationStatus">;
  readonly #invocations = new AsyncLocalStorage<MutationInvocation>();

  constructor(input: {
    readonly local: AgentMutationMiddleware;
    readonly helper: Pick<AdminHelperV2Client, "mutationStatus">;
  }) {
    this.#local = input.local;
    this.#helper = input.helper;
  }

  run<Result>(
    invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    if (invocation.method.startsWith("admin/")) {
      return this.#invocations.run(invocation, execute);
    }
    return this.#local.run(invocation, execute);
  }

  requireInvocation(): MutationInvocation {
    const invocation = this.#invocations.getStore();
    if (invocation === undefined) {
      throw new Error("Administrator mutation escaped its request scope");
    }
    return invocation;
  }

  async status(
    principalId: string,
    operationKey: string,
  ): Promise<MutationStatus> {
    const local = await this.#local.status(principalId, operationKey);
    return local.status === "missing"
      ? this.#helper.mutationStatus(operationKey, principalId)
      : local;
  }
}

/** Proxies high-level admin operations; no privileged primitive crosses IPC. */
export class AdminProxyService {
  readonly handlers: AdminHandlerMap<AdminGatewayContext>;

  constructor(input: {
    readonly helper: Pick<AdminHelperV2Client, "query" | "mutation">;
    readonly mutations: AdminProxyMutationMiddleware;
  }) {
    const query = <
      Method extends
        "admin/host/status" | "admin/user/inspect" | "admin/audit/list",
    >(
      method: Method,
      payload: Parameters<AdminHandlerMap<AdminGatewayContext>[Method]>[0],
      context: AdminGatewayContext,
    ) => input.helper.query(method, payload, context.principalId);
    const mutation = <
      Method extends
        | "admin/user/register"
        | "admin/user/disable"
        | "admin/user/enable"
        | "admin/user/removal/schedule"
        | "admin/user/removal/cancel"
        | "admin/user/recovery/start",
    >(
      method: Method,
      payload: Parameters<AdminHandlerMap<AdminGatewayContext>[Method]>[0],
    ) =>
      input.helper.mutation(
        method,
        payload,
        input.mutations.requireInvocation(),
      );

    this.handlers = {
      "admin/host/status": (payload, context) =>
        query("admin/host/status", payload, context),
      "admin/user/inspect": (payload, context) =>
        query("admin/user/inspect", payload, context),
      "admin/audit/list": (payload, context) =>
        query("admin/audit/list", payload, context),
      "admin/user/register": (payload) =>
        mutation("admin/user/register", payload),
      "admin/user/disable": (payload) =>
        mutation("admin/user/disable", payload),
      "admin/user/enable": (payload) => mutation("admin/user/enable", payload),
      "admin/user/removal/schedule": (payload) =>
        mutation("admin/user/removal/schedule", payload),
      "admin/user/removal/cancel": (payload) =>
        mutation("admin/user/removal/cancel", payload),
      "admin/user/recovery/start": (payload) =>
        mutation("admin/user/recovery/start", payload),
    };
  }
}
