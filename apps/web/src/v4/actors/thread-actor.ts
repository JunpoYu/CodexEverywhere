import { Actor, type Scope } from "@codex-everywhere/kernel";
import {
  parseGatewayEventPayload,
  type GatewayEventEnvelopeV2,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import {
  mutationOptions,
  queryOptions,
  type GatewayPort,
} from "../gateway/gateway-port.js";

type Snapshot = OutputOf<"thread/open">;

export interface ThreadActorState {
  readonly status:
    | "closed"
    | "opening"
    | "syncing"
    | "idle"
    | "running"
    | "waiting-input"
    | "reconnecting"
    | "failed";
  readonly threadId?: string;
  readonly snapshot?: Snapshot;
  readonly error?: string;
}

type Event =
  | { readonly type: "OPEN"; readonly threadId: string }
  | { readonly type: "OPENED"; readonly snapshot: Snapshot }
  | { readonly type: "LOAD_EARLIER" }
  | {
      readonly type: "HISTORY_LOADED";
      readonly page: OutputOf<"thread/history">;
    }
  | { readonly type: "GATEWAY_EVENT"; readonly event: GatewayEventEnvelopeV2 }
  | { readonly type: "RECONNECTING" }
  | { readonly type: "CLOSE" }
  | { readonly type: "FAILED"; readonly message: string };

type Effect =
  | { readonly type: "FETCH"; readonly threadId: string }
  | {
      readonly type: "HISTORY";
      readonly threadId: string;
      readonly cursor: string;
    }
  | { readonly type: "CLOSE" };

export function createThreadActor(scope: Scope, gateway: GatewayPort) {
  let openedThreadId: string | undefined;
  return new Actor<ThreadActorState, Event, Effect>({
    name: "thread",
    scope,
    initialState: { status: "closed" },
    reducer: (state, event) => {
      switch (event.type) {
        case "OPEN":
          if (
            state.threadId === event.threadId &&
            state.snapshot !== undefined
          ) {
            return {
              state: { ...state, status: "syncing" },
              effects: [{ type: "FETCH", threadId: event.threadId }],
            };
          }
          return {
            state: { status: "opening", threadId: event.threadId },
            effects: [{ type: "FETCH", threadId: event.threadId }],
          };
        case "OPENED":
          return {
            state: {
              status: event.snapshot.state,
              threadId: event.snapshot.thread.id,
              snapshot: preserveTransientEvents(state.snapshot, event.snapshot),
            },
          };
        case "LOAD_EARLIER":
          if (
            state.threadId === undefined ||
            state.snapshot === undefined ||
            !state.snapshot.hasEarlierHistory ||
            state.snapshot.historyCursor === undefined
          ) {
            return { state };
          }
          return {
            state: { ...state, status: "syncing" },
            effects: [
              {
                type: "HISTORY",
                threadId: state.threadId,
                cursor: state.snapshot.historyCursor,
              },
            ],
          };
        case "HISTORY_LOADED": {
          if (state.snapshot === undefined) return { state };
          const { historyCursor: _previousCursor, ...snapshot } =
            state.snapshot;
          return {
            state: {
              ...state,
              status: snapshot.state,
              snapshot: {
                ...snapshot,
                items: mergeTimeline(event.page.items, snapshot.items),
                ...(event.page.nextCursor === undefined
                  ? {}
                  : { historyCursor: event.page.nextCursor }),
                hasEarlierHistory: event.page.hasMore,
              },
            },
          };
        }
        case "GATEWAY_EVENT":
          return {
            state: applyGatewayEvent(state, event.event),
            preserveEffects: true,
          };
        case "RECONNECTING":
          return { state: { ...state, status: "reconnecting" } };
        case "CLOSE":
          return {
            state: { status: "closed" },
            effects: [{ type: "CLOSE" }],
          };
        case "FAILED":
          return {
            state: { ...state, status: "failed", error: event.message },
          };
      }
    },
    runEffect: async (effect, context) => {
      try {
        if (effect.type === "CLOSE") {
          if (openedThreadId === undefined) return;
          const closing = openedThreadId;
          await gateway.request(
            "thread/close",
            { version: 1, threadId: closing },
            mutationOptions(crypto.randomUUID(), context.signal),
          );
          if (openedThreadId === closing) openedThreadId = undefined;
          return;
        }
        if (effect.type === "HISTORY") {
          const page = await gateway.request(
            "thread/history",
            {
              version: 1,
              threadId: effect.threadId,
              cursor: effect.cursor,
              limit: 100,
            },
            queryOptions(context.signal),
          );
          context.dispatch({ type: "HISTORY_LOADED", page });
          return;
        }
        if (
          openedThreadId !== undefined &&
          openedThreadId !== effect.threadId
        ) {
          await gateway.request(
            "thread/close",
            { version: 1, threadId: openedThreadId },
            mutationOptions(crypto.randomUUID(), context.signal),
          );
          openedThreadId = undefined;
        }
        const snapshot = await gateway.request(
          "thread/open",
          { version: 1, threadId: effect.threadId, historyLimit: 100 },
          queryOptions(context.signal),
        );
        openedThreadId = effect.threadId;
        context.dispatch({ type: "OPENED", snapshot });
      } catch (error) {
        if (!context.signal.aborted && effect.type !== "CLOSE") {
          context.dispatch({
            type: "FAILED",
            message:
              error instanceof Error
                ? error.message
                : effect.type === "HISTORY"
                  ? "历史加载失败"
                  : "任务打开失败",
          });
        }
      }
    },
    onEffectError: () => undefined,
  });
}

function mergeTimeline(
  earlier: Snapshot["items"],
  current: Snapshot["items"],
): Snapshot["items"] {
  const seen = new Set<string>();
  return [...earlier, ...current].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function applyGatewayEvent(
  state: ThreadActorState,
  event: GatewayEventEnvelopeV2,
): ThreadActorState {
  if (state.threadId === undefined || state.snapshot === undefined)
    return state;
  if (event.type === "thread/state") {
    const payload = parseGatewayEventPayload("thread/state", event.payload);
    if (payload.threadId !== state.threadId) return state;
    return {
      ...state,
      status: payload.state,
      snapshot: { ...state.snapshot, state: payload.state },
    };
  }
  if (event.type === "interaction/created") {
    const interaction = parseGatewayEventPayload(
      "interaction/created",
      event.payload,
    ).interaction;
    if (interaction.threadId !== state.threadId) return state;
    return {
      ...state,
      status: "waiting-input",
      snapshot: {
        ...state.snapshot,
        interactions: [
          ...state.snapshot.interactions.filter(
            (candidate) => candidate.id !== interaction.id,
          ),
          interaction,
        ],
      },
    };
  }
  if (event.type === "codex/generic") {
    const payload = parseGatewayEventPayload("codex/generic", event.payload);
    if (payload.threadId !== state.threadId) return state;
    const item: Snapshot["items"][number] = {
      version: 1,
      id: `gateway:${event.eventId}`,
      type: "generic",
      createdAt: new Date().toISOString(),
      data: {
        source: "codex/generic",
        method: payload.method,
        params: payload.params,
      },
    };
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        items: mergeTimeline(state.snapshot.items, [item]),
      },
    };
  }
  if (
    event.type === "interaction/resolved" ||
    event.type === "interaction/failed"
  ) {
    const payload = parseGatewayEventPayload(event.type, event.payload);
    if (payload.threadId !== state.threadId) return state;
    const interactionId = payload.interactionId;
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        interactions: state.snapshot.interactions.filter(
          (interaction) => interaction.id !== interactionId,
        ),
      },
    };
  }
  return state;
}

function preserveTransientEvents(
  current: Snapshot | undefined,
  authoritative: Snapshot,
): Snapshot {
  if (current === undefined || current.thread.id !== authoritative.thread.id) {
    return authoritative;
  }
  const transient = current.items.filter(
    (item) => item.type === "generic" && item.data.source === "codex/generic",
  );
  if (transient.length === 0) return authoritative;
  return {
    ...authoritative,
    items: mergeTimeline(authoritative.items, transient),
  };
}
