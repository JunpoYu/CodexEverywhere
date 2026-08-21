import { Actor, type Scope } from "@codex-everywhere/kernel";
import {
  MutationOutcomeUnknownError,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import {
  mutationOptions,
  queryOptions,
  type GatewayPort,
} from "../gateway/gateway-port.js";

type QueueItem = OutputOf<"queue/list">["items"][number];

export interface QueueActorState {
  readonly status:
    "loading" | "ready" | "mutating" | "reconciling" | "indeterminate";
  readonly items: readonly QueueItem[];
  readonly operationKey?: string;
  readonly error?: string;
}

type Event =
  | { readonly type: "LOAD"; readonly threadId?: string }
  | { readonly type: "LOADED"; readonly items: readonly QueueItem[] }
  | { readonly type: "ADD"; readonly threadId: string; readonly text: string }
  | { readonly type: "REMOVE"; readonly itemId: string }
  | { readonly type: "STEER"; readonly itemId: string; readonly text: string }
  | {
      readonly type: "ACKNOWLEDGE";
      readonly itemId: string;
      readonly disposition: "retry" | "dismiss";
    }
  | { readonly type: "CHANGED"; readonly item: QueueItem }
  | { readonly type: "REMOVED"; readonly itemId: string }
  | { readonly type: "MUTATED"; readonly item: QueueItem }
  | { readonly type: "MUTATION_REMOVED"; readonly itemId: string }
  | { readonly type: "UNKNOWN"; readonly operationKey: string }
  | { readonly type: "RECONCILE"; readonly operationKey: string }
  | { readonly type: "RECONCILED" }
  | {
      readonly type: "FAILED";
      readonly message: string;
      readonly unknown: boolean;
    };

type Effect =
  | { readonly type: "FETCH"; readonly threadId?: string }
  | {
      readonly type: "ADD";
      readonly threadId: string;
      readonly text: string;
      readonly operationKey: string;
    }
  | {
      readonly type: "REMOVE";
      readonly itemId: string;
      readonly operationKey: string;
    }
  | {
      readonly type: "STEER";
      readonly itemId: string;
      readonly text: string;
      readonly operationKey: string;
    }
  | {
      readonly type: "ACKNOWLEDGE";
      readonly itemId: string;
      readonly disposition: "retry" | "dismiss";
      readonly operationKey: string;
    }
  | { readonly type: "STATUS"; readonly operationKey: string };

export function createQueueActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<QueueActorState, Event, Effect>({
    name: "queue",
    scope,
    initialState: { status: "loading", items: [] },
    reducer: (state, event) => {
      switch (event.type) {
        case "LOAD":
          if (state.status === "mutating" || state.status === "reconciling") {
            return { state, preserveEffects: true };
          }
          return {
            state: { ...state, status: "loading" },
            effects: [
              {
                type: "FETCH",
                ...(event.threadId === undefined
                  ? {}
                  : { threadId: event.threadId }),
              },
            ],
          };
        case "LOADED":
          return { state: { status: "ready", items: event.items } };
        case "ADD": {
          if (state.status !== "ready") {
            return { state, preserveEffects: true };
          }
          const operationKey = crypto.randomUUID();
          return {
            state: { ...state, status: "mutating", operationKey },
            effects: [
              {
                type: "ADD",
                threadId: event.threadId,
                text: event.text,
                operationKey,
              },
            ],
          };
        }
        case "REMOVE": {
          if (state.status !== "ready") {
            return { state, preserveEffects: true };
          }
          const operationKey = crypto.randomUUID();
          return {
            state: { ...state, status: "mutating", operationKey },
            effects: [{ type: "REMOVE", itemId: event.itemId, operationKey }],
          };
        }
        case "STEER": {
          if (state.status !== "ready") {
            return { state, preserveEffects: true };
          }
          const operationKey = crypto.randomUUID();
          return {
            state: { ...state, status: "mutating", operationKey },
            effects: [
              {
                type: "STEER",
                itemId: event.itemId,
                text: event.text,
                operationKey,
              },
            ],
          };
        }
        case "ACKNOWLEDGE": {
          if (state.status !== "ready") {
            return { state, preserveEffects: true };
          }
          const operationKey = crypto.randomUUID();
          return {
            state: { ...state, status: "mutating", operationKey },
            effects: [
              {
                type: "ACKNOWLEDGE",
                itemId: event.itemId,
                disposition: event.disposition,
                operationKey,
              },
            ],
          };
        }
        case "CHANGED":
          return {
            state: {
              ...state,
              items: upsert(state.items, event.item),
            },
            preserveEffects: true,
          };
        case "REMOVED":
          return {
            state: {
              ...state,
              items: state.items.filter((item) => item.id !== event.itemId),
            },
            preserveEffects: true,
          };
        case "MUTATED":
          return {
            state: {
              status: "ready",
              items: upsert(state.items, event.item),
            },
          };
        case "MUTATION_REMOVED":
          return {
            state: {
              status: "ready",
              items: state.items.filter((item) => item.id !== event.itemId),
            },
          };
        case "UNKNOWN":
          return {
            state: {
              ...state,
              status: "reconciling",
              operationKey: event.operationKey,
              error: "Queue 操作结果未知，正在向宿主机对账。",
            },
            effects: [{ type: "STATUS", operationKey: event.operationKey }],
          };
        case "RECONCILE":
          return {
            state: {
              ...state,
              status: "reconciling",
              operationKey: event.operationKey,
            },
            effects: [{ type: "STATUS", operationKey: event.operationKey }],
          };
        case "RECONCILED":
          return {
            state: { status: "loading", items: state.items },
            effects: [{ type: "FETCH" }],
          };
        case "FAILED":
          return event.unknown
            ? {
                state: {
                  ...state,
                  status: "indeterminate",
                  error: event.message,
                },
              }
            : {
                state: {
                  status: "ready",
                  items: state.items,
                  error: event.message,
                },
              };
      }
    },
    runEffect: async (effect, context) => {
      try {
        if (effect.type === "FETCH") {
          const result = await gateway.request(
            "queue/list",
            {
              version: 1,
              limit: 100,
              ...(effect.threadId === undefined
                ? {}
                : { threadId: effect.threadId }),
            },
            queryOptions(context.signal),
          );
          context.dispatch({ type: "LOADED", items: result.items });
        } else if (effect.type === "STATUS") {
          const status = await gateway.request(
            "mutation/status",
            { version: 1, operationKey: effect.operationKey },
            queryOptions(context.signal),
          );
          if (status.status === "completed") {
            context.dispatch(
              status.outcome.kind === "success"
                ? { type: "RECONCILED" }
                : {
                    type: "FAILED",
                    unknown: false,
                    message: status.outcome.error.message,
                  },
            );
          } else if (status.status === "pending") {
            await abortableDelay(1_000, context.signal);
            context.dispatch({
              type: "RECONCILE",
              operationKey: effect.operationKey,
            });
          } else {
            context.dispatch({
              type: "FAILED",
              unknown: true,
              message:
                status.status === "indeterminate"
                  ? "宿主机无法确认 Queue 操作是否完成，请检查 Queue 状态。"
                  : "宿主机没有找到 Queue 操作记录，请人工检查后再操作。",
            });
          }
        } else if (effect.type === "ADD") {
          const result = await gateway.request(
            "queue/add",
            { version: 1, threadId: effect.threadId, text: effect.text },
            mutationOptions(effect.operationKey, context.signal),
          );
          context.dispatch({ type: "MUTATED", item: result.item });
        } else if (effect.type === "REMOVE") {
          await gateway.request(
            "queue/remove",
            { version: 1, itemId: effect.itemId },
            mutationOptions(effect.operationKey, context.signal),
          );
          context.dispatch({ type: "MUTATION_REMOVED", itemId: effect.itemId });
        } else if (effect.type === "STEER") {
          const result = await gateway.request(
            "queue/steer",
            { version: 1, itemId: effect.itemId, text: effect.text },
            mutationOptions(effect.operationKey, context.signal),
          );
          context.dispatch({ type: "MUTATED", item: result.item });
        } else {
          const result = await gateway.request(
            "queue/indeterminate/acknowledge",
            {
              version: 1,
              itemId: effect.itemId,
              disposition: effect.disposition,
            },
            mutationOptions(effect.operationKey, context.signal),
          );
          context.dispatch({ type: "MUTATED", item: result.item });
        }
      } catch (error) {
        if (!context.signal.aborted) {
          if (error instanceof MutationOutcomeUnknownError) {
            context.dispatch({
              type: "UNKNOWN",
              operationKey: error.operationKey,
            });
          } else {
            context.dispatch({
              type: "FAILED",
              message:
                error instanceof Error ? error.message : "Queue 操作失败",
              unknown: false,
            });
          }
        }
      }
    },
    onEffectError: () => undefined,
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const abort = () =>
      finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
    function finish(error?: unknown) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function upsert(items: readonly QueueItem[], item: QueueItem): QueueItem[] {
  return [item, ...items.filter((candidate) => candidate.id !== item.id)].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
}
