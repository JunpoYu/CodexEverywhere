import { Actor, type Scope } from "@codex-everywhere/kernel";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { queryOptions, type GatewayPort } from "../gateway/gateway-port.js";

type Task = OutputOf<"thread/list">["threads"][number];
type TaskState = Task["state"];

export interface TaskListState {
  readonly status: "loading" | "ready" | "paginating" | "failed";
  readonly tasks: readonly Task[];
  readonly requestInFlight?: boolean;
  readonly refreshPending?: boolean;
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly archived: boolean;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly error?: string;
  /** State events received while an authoritative page request is in flight. */
  readonly pendingStateChanges: Readonly<Record<string, TaskState>>;
}

type Event =
  | {
      readonly type: "LOAD";
      readonly workspaceId?: string;
      readonly workspaceLabel?: string;
      readonly archived?: boolean;
    }
  | { readonly type: "MORE" }
  | {
      readonly type: "LOADED";
      readonly page: OutputOf<"thread/list">;
      readonly append: boolean;
    }
  | {
      readonly type: "THREAD_STATE_CHANGED";
      readonly threadId: string;
      readonly state: TaskState;
    }
  | { readonly type: "FAILED"; readonly message: string };

type Effect = {
  readonly type: "FETCH";
  readonly append: boolean;
  readonly workspaceId?: string;
  readonly archived: boolean;
  readonly cursor?: string;
};

export function createTaskListActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<TaskListState, Event, Effect>({
    name: "task-list",
    scope,
    initialState: {
      status: "loading",
      tasks: [],
      hasMore: false,
      archived: false,
      pendingStateChanges: {},
    },
    reducer: (state, event) => {
      switch (event.type) {
        case "LOAD": {
          const archived = event.archived ?? false;
          const sameScope =
            state.archived === archived &&
            state.workspaceId === event.workspaceId;
          if (sameScope && state.requestInFlight === true) {
            return {
              state: { ...state, refreshPending: true },
              preserveEffects: true,
            };
          }
          const { error: _error, ...previous } = state;
          return {
            state: {
              ...(sameScope
                ? previous
                : {
                    tasks: [],
                    hasMore: false,
                    archived,
                    ...(event.workspaceId === undefined
                      ? {}
                      : { workspaceId: event.workspaceId }),
                  }),
              status: "loading",
              requestInFlight: true,
              refreshPending: false,
              pendingStateChanges: {},
              ...(event.workspaceLabel === undefined
                ? {}
                : { workspaceLabel: event.workspaceLabel }),
            },
            effects: [
              {
                type: "FETCH",
                append: false,
                archived,
                ...(event.workspaceId === undefined
                  ? {}
                  : { workspaceId: event.workspaceId }),
              },
            ],
          };
        }
        case "MORE":
          if (
            state.requestInFlight === true ||
            !state.hasMore ||
            state.nextCursor === undefined
          ) {
            return { state, preserveEffects: true };
          }
          return {
            state: { ...state, status: "paginating", requestInFlight: true },
            effects: [
              {
                type: "FETCH",
                append: true,
                cursor: state.nextCursor,
                archived: state.archived,
                ...(state.workspaceId === undefined
                  ? {}
                  : { workspaceId: state.workspaceId }),
              },
            ],
          };
        case "LOADED": {
          const {
            nextCursor: _previousCursor,
            error: _error,
            ...stateWithoutCursor
          } = state;
          const refreshAgain = state.refreshPending === true;
          const tasks = applyPendingStateChanges(
            event.append
              ? mergeTasks(state.tasks, event.page.threads)
              : event.page.threads,
            state.pendingStateChanges,
          );
          return {
            state: {
              ...stateWithoutCursor,
              status: refreshAgain ? "loading" : "ready",
              tasks,
              requestInFlight: refreshAgain,
              refreshPending: false,
              pendingStateChanges: {},
              ...(event.page.nextCursor === undefined
                ? {}
                : { nextCursor: event.page.nextCursor }),
              hasMore: event.page.hasMore,
            },
            ...(refreshAgain ? { effects: [refreshEffect(state)] } : {}),
          };
        }
        case "THREAD_STATE_CHANGED": {
          const tasks = replaceTaskState(
            state.tasks,
            event.threadId,
            event.state,
          );
          const requestInFlight = state.requestInFlight === true;
          if (!requestInFlight && tasks === state.tasks) {
            return { state, preserveEffects: true };
          }
          return {
            state: {
              ...state,
              tasks,
              ...(requestInFlight
                ? {
                    pendingStateChanges: {
                      ...state.pendingStateChanges,
                      [event.threadId]: event.state,
                    },
                  }
                : {}),
            },
            preserveEffects: true,
          };
        }
        case "FAILED":
          if (state.refreshPending === true)
            return {
              state: {
                ...state,
                status: "loading",
                requestInFlight: true,
                refreshPending: false,
                pendingStateChanges: {},
              },
              effects: [refreshEffect(state)],
            };
          return {
            state: {
              ...state,
              status: "failed",
              requestInFlight: false,
              refreshPending: false,
              error: event.message,
              pendingStateChanges: {},
            },
          };
      }
    },
    runEffect: async (effect, context) => {
      try {
        const page = await gateway.request(
          "thread/list",
          {
            version: 1,
            archived: effect.archived,
            limit: 50,
            ...(effect.workspaceId === undefined
              ? {}
              : { workspaceId: effect.workspaceId }),
            ...(effect.cursor === undefined ? {} : { cursor: effect.cursor }),
          },
          queryOptions(context.signal),
        );
        context.dispatch({ type: "LOADED", page, append: effect.append });
      } catch (error) {
        if (!context.signal.aborted) {
          context.dispatch({ type: "FAILED", message: errorMessage(error) });
        }
      }
    },
    onEffectError: () => undefined,
  });
}

function refreshEffect(state: TaskListState): Effect {
  return {
    type: "FETCH",
    append: false,
    archived: state.archived,
    ...(state.workspaceId === undefined
      ? {}
      : { workspaceId: state.workspaceId }),
  };
}

function mergeTasks(current: readonly Task[], next: readonly Task[]): Task[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of next) byId.set(task.id, task);
  return [...byId.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function applyPendingStateChanges(
  tasks: readonly Task[],
  changes: Readonly<Record<string, TaskState>>,
): readonly Task[] {
  let result = tasks;
  for (const [threadId, state] of Object.entries(changes)) {
    result = replaceTaskState(result, threadId, state);
  }
  return result;
}

function replaceTaskState(
  tasks: readonly Task[],
  threadId: string,
  state: TaskState,
): readonly Task[] {
  const index = tasks.findIndex((task) => task.id === threadId);
  if (index < 0 || tasks[index]?.state === state) return tasks;
  const result = [...tasks];
  result[index] = { ...result[index]!, state };
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "任务列表读取失败";
}
