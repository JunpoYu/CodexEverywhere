import { Actor, type Scope } from "@codex-everywhere/kernel";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { queryOptions, type GatewayPort } from "../gateway/gateway-port.js";

export type ModelCatalogItem = OutputOf<"model/list">["models"][number];

export interface ModelCatalogState {
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly models: readonly ModelCatalogItem[];
  readonly error?: string;
}

type Event =
  | { readonly type: "LOAD" }
  | { readonly type: "LOADED"; readonly models: readonly ModelCatalogItem[] }
  | { readonly type: "FAILED"; readonly message: string };

type Effect = { readonly type: "FETCH" };

export function createModelCatalogActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<ModelCatalogState, Event, Effect>({
    name: "model-catalog",
    scope,
    initialState: { status: "idle", models: [] },
    reducer: (state, event) => {
      switch (event.type) {
        case "LOAD":
          return {
            state: { status: "loading", models: state.models },
            effects: [{ type: "FETCH" }],
          };
        case "LOADED":
          return { state: { status: "ready", models: event.models } };
        case "FAILED":
          return {
            state: {
              status: "failed",
              models: state.models,
              error: event.message,
            },
          };
      }
    },
    runEffect: async (_effect, context) => {
      try {
        const models: ModelCatalogItem[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
          const page = await gateway.request(
            "model/list",
            {
              version: 1,
              limit: 200,
              ...(cursor === undefined ? {} : { cursor }),
            },
            queryOptions(context.signal),
          );
          models.push(...page.models);
          if (!page.hasMore || page.nextCursor === undefined) break;
          if (seenCursors.has(page.nextCursor)) {
            throw new Error("Codex 模型目录返回了重复游标");
          }
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
          if (pageIndex === 19) {
            throw new Error("Codex 模型目录分页过多");
          }
        }
        context.dispatch({ type: "LOADED", models: uniqueModels(models) });
      } catch (error) {
        if (!context.signal.aborted) {
          context.dispatch({
            type: "FAILED",
            message:
              error instanceof Error ? error.message : "模型目录读取失败",
          });
        }
      }
    },
    onEffectError: () => undefined,
  });
}

function uniqueModels(models: readonly ModelCatalogItem[]): ModelCatalogItem[] {
  const byModel = new Map<string, ModelCatalogItem>();
  for (const model of models) {
    if (!byModel.has(model.model)) byModel.set(model.model, model);
  }
  return [...byModel.values()];
}
