import { Actor, type Scope } from "@codex-everywhere/kernel";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { queryOptions, type GatewayPort } from "../gateway/gateway-port.js";

export interface AdminActorState {
  readonly status: "signed-out" | "authenticating" | "ready" | "mutating";
  readonly host?: OutputOf<"admin/host/status">;
  readonly audit: OutputOf<"admin/audit/list">["events"];
  readonly error?: string;
}

type Event =
  | { readonly type: "LOAD" }
  | { readonly type: "MUTATING" }
  | {
      readonly type: "LOADED";
      readonly host: OutputOf<"admin/host/status">;
      readonly audit: OutputOf<"admin/audit/list">["events"];
    }
  | { readonly type: "FAILED"; readonly message: string };

type Effect = { readonly type: "FETCH" };

export function createAdminActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<AdminActorState, Event, Effect>({
    name: "admin",
    scope,
    initialState: { status: "signed-out", audit: [] },
    reducer: (state, event) => {
      switch (event.type) {
        case "LOAD":
          return {
            state: { ...state, status: "authenticating" },
            effects: [{ type: "FETCH" }],
          };
        case "MUTATING":
          return { state: { ...state, status: "mutating" } };
        case "LOADED":
          return {
            state: {
              status: "ready",
              host: event.host,
              audit: event.audit,
            },
          };
        case "FAILED":
          return {
            state: { ...state, status: "signed-out", error: event.message },
          };
      }
    },
    runEffect: async (_effect, context) => {
      try {
        const [host, audit] = await Promise.all([
          gateway.request(
            "admin/host/status",
            { version: 1 },
            queryOptions(context.signal),
          ),
          gateway.request(
            "admin/audit/list",
            { version: 1, limit: 50 },
            queryOptions(context.signal),
          ),
        ]);
        context.dispatch({ type: "LOADED", host, audit: audit.events });
      } catch (error) {
        if (!context.signal.aborted) {
          context.dispatch({
            type: "FAILED",
            message:
              error instanceof Error ? error.message : "管理信息读取失败",
          });
        }
      }
    },
    onEffectError: () => undefined,
  });
}
