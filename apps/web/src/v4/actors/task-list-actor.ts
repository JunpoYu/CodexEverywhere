import { Actor, type Scope } from "@codex-everywhere/kernel";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { queryOptions, type GatewayPort } from "../gateway/gateway-port.js";

type Task = OutputOf<"thread/list">["threads"][number];

export interface TaskListState {
  readonly status: "loading" | "ready" | "paginating" | "failed";
  readonly tasks: readonly Task[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
  readonly archived: boolean;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly error?: string;
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
    },
    reducer: (state, event) => {
      switch (event.type) {
        case "LOAD":
          return {
            state: {
              status: "loading",
              tasks: [],
              hasMore: false,
              archived: event.archived ?? false,
              ...(event.workspaceId === undefined
                ? {}
                : { workspaceId: event.workspaceId }),
              ...(event.workspaceLabel === undefined
                ? {}
                : { workspaceLabel: event.workspaceLabel }),
            },
            effects: [
              {
                type: "FETCH",
                append: false,
                archived: event.archived ?? false,
                ...(event.workspaceId === undefined
                  ? {}
                  : { workspaceId: event.workspaceId }),
              },
            ],
          };
        case "MORE":
          if (!state.hasMore || state.nextCursor === undefined) {
            return { state, preserveEffects: true };
          }
          return {
            state: { ...state, status: "paginating" },
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
          const { nextCursor: _previousCursor, ...stateWithoutCursor } = state;
          return {
            state: {
              ...stateWithoutCursor,
              status: "ready",
              tasks: event.append
                ? mergeTasks(state.tasks, event.page.threads)
                : event.page.threads,
              ...(event.page.nextCursor === undefined
                ? {}
                : { nextCursor: event.page.nextCursor }),
              hasMore: event.page.hasMore,
            },
          };
        }
        case "FAILED":
          return {
            state: { ...state, status: "failed", error: event.message },
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

function mergeTasks(current: readonly Task[], next: readonly Task[]): Task[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of next) byId.set(task.id, task);
  return [...byId.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "任务列表读取失败";
}
