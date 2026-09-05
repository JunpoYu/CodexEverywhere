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
import {
  mergeAuthoritativeTimelineWindow,
  mergeTimelinePages,
  prependAuthoritativeHistoryPage,
  replaceAuthoritativeTimelineWindow,
  TIMELINE_PAGE_SIZE,
} from "./thread-timeline-model.js";

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
  /** Stable IDs introduced only by explicit backward pagination. */
  readonly loadedHistoryItemIds: readonly string[];
  readonly refreshing?: boolean;
  readonly historyStatus: "idle" | "loading" | "failed";
  readonly historyError?: string | undefined;
  readonly refreshPending?: boolean;
  readonly replaceHistoryOnRefresh?: boolean | undefined;
  readonly error?: string;
}

type Event =
  | { readonly type: "OPEN"; readonly threadId: string }
  | { readonly type: "OPENED"; readonly snapshot: Snapshot }
  | {
      readonly type: "SETTINGS_UPDATED";
      readonly threadId: string;
      readonly settings: OutputOf<"thread/settings/update">;
    }
  | { readonly type: "LOAD_EARLIER" }
  | {
      readonly type: "HISTORY_LOADED";
      readonly page: OutputOf<"thread/history">;
    }
  | { readonly type: "HISTORY_FAILED"; readonly message: string }
  | { readonly type: "GATEWAY_EVENT"; readonly event: GatewayEventEnvelopeV2 }
  | { readonly type: "RECONNECTING" }
  | { readonly type: "CLOSE" }
  | { readonly type: "FAILED"; readonly message: string };

type Effect =
  | {
      readonly type: "FETCH";
      readonly threadId: string;
      readonly previousThreadId?: string;
    }
  | {
      readonly type: "HISTORY";
      readonly threadId: string;
      readonly cursor: string;
    }
  | { readonly type: "CLOSE"; readonly threadId?: string };

export function createThreadActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<ThreadActorState, Event, Effect>({
    name: "thread",
    scope,
    initialState: {
      status: "closed",
      historyStatus: "idle",
      loadedHistoryItemIds: [],
    },
    reducer: (state, event) => {
      switch (event.type) {
        case "OPEN":
          if (
            state.threadId === event.threadId &&
            state.snapshot !== undefined
          ) {
            if (state.historyStatus === "loading") {
              return {
                state: {
                  ...state,
                  refreshing: true,
                  refreshPending: true,
                },
                preserveEffects: true,
              };
            }
            if (state.refreshing === true) {
              return {
                state: { ...state, refreshPending: true },
                preserveEffects: true,
              };
            }
            return {
              state: { ...state, refreshing: true },
              effects: [{ type: "FETCH", threadId: event.threadId }],
            };
          }
          return {
            state: {
              status: "opening",
              threadId: event.threadId,
              historyStatus: "idle",
              loadedHistoryItemIds: [],
            },
            effects: [
              {
                type: "FETCH",
                threadId: event.threadId,
                ...(state.threadId === undefined ||
                state.threadId === event.threadId
                  ? {}
                  : { previousThreadId: state.threadId }),
              },
            ],
          };
        case "OPENED": {
          const refreshAgain = state.refreshPending === true;
          const replaceHistory = state.replaceHistoryOnRefresh === true;
          const snapshot = replaceHistory
            ? replaceAuthoritativeTimelineWindow(state.snapshot, event.snapshot)
            : mergeAuthoritativeTimelineWindow(
                state.snapshot,
                event.snapshot,
                state.loadedHistoryItemIds,
              );
          const nextState: ThreadActorState = {
            status: event.snapshot.state,
            threadId: event.snapshot.thread.id,
            snapshot,
            loadedHistoryItemIds: replaceHistory
              ? []
              : retainPresentIds(state.loadedHistoryItemIds, snapshot),
            refreshing: refreshAgain,
            historyStatus: state.historyStatus,
            refreshPending: false,
            replaceHistoryOnRefresh:
              replaceHistory && refreshAgain ? true : undefined,
          };
          if (refreshAgain) {
            return {
              state: nextState,
              effects: [{ type: "FETCH", threadId: event.snapshot.thread.id }],
            };
          }
          return { state: nextState };
        }
        case "SETTINGS_UPDATED":
          if (
            state.threadId !== event.threadId ||
            state.snapshot === undefined ||
            event.settings.revision < state.snapshot.settings.revision
          ) {
            return { state, preserveEffects: true };
          }
          return {
            state: {
              ...state,
              snapshot: { ...state.snapshot, settings: event.settings },
            },
            preserveEffects: true,
          };
        case "LOAD_EARLIER":
          if (
            state.threadId === undefined ||
            state.snapshot === undefined ||
            state.refreshing === true ||
            state.historyStatus === "loading" ||
            !state.snapshot.hasEarlierHistory ||
            state.snapshot.historyCursor === undefined
          ) {
            return { state, preserveEffects: true };
          }
          return {
            state: {
              ...state,
              historyStatus: "loading",
              historyError: undefined,
            },
            effects: [
              {
                type: "HISTORY",
                threadId: state.threadId,
                cursor: state.snapshot.historyCursor,
              },
            ],
          };
        case "HISTORY_LOADED": {
          if (state.snapshot === undefined) {
            return { state, preserveEffects: true };
          }
          const nextState: ThreadActorState = {
            ...state,
            snapshot: prependAuthoritativeHistoryPage(
              state.snapshot,
              event.page,
            ),
            loadedHistoryItemIds: appendNewHistoryIds(
              state.loadedHistoryItemIds,
              state.snapshot,
              event.page,
            ),
            historyStatus: "idle",
            historyError: undefined,
            refreshPending: false,
          };
          if (state.refreshPending === true && state.threadId !== undefined) {
            return {
              state: { ...nextState, refreshing: true },
              effects: [{ type: "FETCH", threadId: state.threadId }],
            };
          }
          return {
            state: nextState,
          };
        }
        case "HISTORY_FAILED": {
          const nextState: ThreadActorState = {
            ...state,
            historyStatus: "failed",
            historyError: event.message,
            refreshPending: false,
          };
          if (state.refreshPending === true && state.threadId !== undefined) {
            return {
              state: { ...nextState, refreshing: true },
              effects: [{ type: "FETCH", threadId: state.threadId }],
            };
          }
          return { state: nextState };
        }
        case "GATEWAY_EVENT":
          return {
            state: applyGatewayEvent(state, event.event),
            preserveEffects: true,
          };
        case "RECONNECTING":
          return {
            state: {
              ...state,
              status: "reconnecting",
              refreshing: false,
              historyStatus: "idle",
              refreshPending: false,
            },
          };
        case "CLOSE":
          return {
            state: {
              status: "closed",
              historyStatus: "idle",
              loadedHistoryItemIds: [],
            },
            effects: [
              {
                type: "CLOSE",
                ...(state.threadId === undefined
                  ? {}
                  : { threadId: state.threadId }),
              },
            ],
          };
        case "FAILED":
          return {
            state: {
              ...state,
              status: "failed",
              refreshing: false,
              error: event.message,
            },
          };
      }
    },
    runEffect: async (effect, context) => {
      try {
        if (effect.type === "CLOSE") {
          if (effect.threadId === undefined) return;
          await gateway.request(
            "thread/close",
            { version: 1, threadId: effect.threadId },
            mutationOptions(crypto.randomUUID(), context.signal),
          );
          return;
        }
        if (effect.type === "HISTORY") {
          const page = await gateway.request(
            "thread/history",
            {
              version: 1,
              threadId: effect.threadId,
              cursor: effect.cursor,
              limit: TIMELINE_PAGE_SIZE,
            },
            queryOptions(context.signal),
          );
          context.dispatch({ type: "HISTORY_LOADED", page });
          return;
        }
        if (effect.previousThreadId !== undefined) {
          await gateway.request(
            "thread/close",
            { version: 1, threadId: effect.previousThreadId },
            mutationOptions(crypto.randomUUID(), context.signal),
          );
          if (!context.isCurrent()) return;
        }
        const snapshot = await gateway.request(
          "thread/open",
          {
            version: 1,
            threadId: effect.threadId,
            historyLimit: TIMELINE_PAGE_SIZE,
            includeWorkingDirectory: true,
          },
          queryOptions(context.signal),
        );
        context.dispatch({ type: "OPENED", snapshot });
      } catch (error) {
        if (!context.signal.aborted && effect.type !== "CLOSE") {
          const message =
            error instanceof Error
              ? error.message
              : effect.type === "HISTORY"
                ? "历史加载失败"
                : "任务打开失败";
          context.dispatch(
            effect.type === "HISTORY"
              ? { type: "HISTORY_FAILED", message }
              : { type: "FAILED", message },
          );
        }
      }
    },
    onEffectError: () => undefined,
  });
}

function appendNewHistoryIds(
  loadedHistoryItemIds: readonly string[],
  current: Snapshot,
  page: OutputOf<"thread/history">,
): readonly string[] {
  const currentIds = new Set(current.items.map((item) => item.id));
  const loadedIds = new Set(loadedHistoryItemIds);
  const result = [...loadedHistoryItemIds];
  for (const item of page.items) {
    if (currentIds.has(item.id) || loadedIds.has(item.id)) continue;
    loadedIds.add(item.id);
    result.push(item.id);
  }
  return result;
}

function retainPresentIds(
  loadedHistoryItemIds: readonly string[],
  snapshot: Snapshot,
): readonly string[] {
  if (loadedHistoryItemIds.length === 0) return loadedHistoryItemIds;
  const presentIds = new Set(snapshot.items.map((item) => item.id));
  return loadedHistoryItemIds.filter((id) => presentIds.has(id));
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
  if (event.type === "codex/notification") {
    const payload = parseGatewayEventPayload(
      "codex/notification",
      event.payload,
    );
    if (payload.threadId !== state.threadId) return state;
    if (payload.method === "thread/compacted") {
      return { ...state, replaceHistoryOnRefresh: true };
    }
    return state;
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
        items: mergeTimelinePages(state.snapshot.items, [item]),
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
  if (event.type === "thread/lease/failed") {
    const payload = parseGatewayEventPayload(event.type, event.payload);
    if (payload.threadId !== state.threadId) return state;
    return {
      ...state,
      status: "failed",
      refreshing: false,
      error: payload.reason,
    };
  }
  return state;
}
