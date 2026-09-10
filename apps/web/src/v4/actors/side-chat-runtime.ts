import { Actor, Scope } from "@codex-everywhere/kernel";
import {
  GatewayRemoteError,
  parseGatewayEventPayload,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";
import {
  durableMutation,
  MutationNeedsReviewError,
} from "../gateway/durable-mutation.js";
import { queryOptions, type GatewayPort } from "../gateway/gateway-port.js";
import { composerDraftFor, createComposerActor } from "./composer-actor.js";
import { createThreadActor } from "./thread-actor.js";

type Side = OutputOf<"side/read">["side"];
export interface SideChatState {
  readonly parentThreadId?: string | undefined;
  readonly side: Side;
  readonly visible: boolean;
  readonly status:
    | "idle"
    | "loading"
    | "creating"
    | "deleting"
    | "reconciling"
    | "review"
    | "failed"
    | "unsupported";
  readonly error?: string | undefined;
  readonly operationKey?: string | undefined;
  readonly initialQuestion?: string;
}
type Event =
  | { type: "SELECT"; parentThreadId: string }
  | { type: "SHOW" }
  | { type: "HIDE" }
  | { type: "START"; question?: string }
  | { type: "DELETE" }
  | { type: "ABANDON" }
  | { type: "RELOAD" }
  | { type: "CONSUMED" }
  | { type: "LOADED"; side: Side }
  | { type: "CREATED"; side: Side }
  | { type: "DELETED" }
  | { type: "UNKNOWN"; operationKey: string }
  | { type: "FAILED"; message: string; review: boolean; unsupported: boolean };
type Effect =
  | { type: "READ" | "START" | "DELETE"; parentThreadId: string }
  | { type: "ABANDON"; parentThreadId: string; creationKey: string };

/** Owns side UI lifetime across routes; execution and history use existing actors. */
export class SideChatRuntime {
  readonly scope: Scope;
  readonly actor: Actor<SideChatState, Event, Effect>;
  readonly thread;
  readonly composer;
  #refreshScope: Scope | undefined;

  constructor(
    parent: Scope,
    private readonly gateway: GatewayPort,
  ) {
    this.scope = parent.fork("side-chat");
    this.thread = createThreadActor(this.scope, gateway);
    this.composer = createComposerActor(this.scope, gateway);
    this.actor = new Actor<SideChatState, Event, Effect>({
      name: "side-chat-control",
      scope: this.scope,
      initialState: { side: null, visible: false, status: "idle" },
      reducer: (state, event) => {
        const preserve = { state, preserveEffects: true } as const;
        switch (event.type) {
          case "HIDE":
            return {
              state: { ...state, visible: false },
              preserveEffects: true,
            };
          case "SHOW":
            return {
              state: { ...state, visible: true },
              preserveEffects: true,
            };
          case "CONSUMED": {
            const { initialQuestion: _question, ...rest } = state;
            return { state: rest, preserveEffects: true };
          }
          case "SELECT":
            if (
              sideMutationBusy(state) ||
              state.initialQuestion !== undefined ||
              state.parentThreadId === event.parentThreadId
            )
              return preserve;
            return {
              state: {
                parentThreadId: event.parentThreadId,
                side: null,
                visible: false,
                status: "loading",
              },
              effects: [{ type: "READ", parentThreadId: event.parentThreadId }],
            };
          case "RELOAD":
            if (sideMutationBusy(state) || state.parentThreadId === undefined)
              return preserve;
            return {
              state: { ...state, status: "loading" },
              effects: [{ type: "READ", parentThreadId: state.parentThreadId }],
            };
          case "START":
            if (
              state.parentThreadId === undefined ||
              state.side !== null ||
              !["idle", "failed"].includes(state.status)
            )
              return preserve;
            return {
              state: {
                ...state,
                visible: true,
                status: "creating",
                ...(event.question === undefined
                  ? {}
                  : { initialQuestion: event.question }),
              },
              effects: [
                { type: "START", parentThreadId: state.parentThreadId },
              ],
            };
          case "ABANDON":
            if (
              !state.parentThreadId ||
              sideMutationBusy(state) ||
              state.side?.status !== "indeterminate" ||
              state.side.threadId ||
              !state.side.creationKey
            )
              return preserve;
            return {
              state: { ...state, status: "deleting" },
              effects: [
                {
                  type: "ABANDON",
                  parentThreadId: state.parentThreadId,
                  creationKey: state.side.creationKey,
                },
              ],
            };
          case "DELETE":
            if (
              state.parentThreadId === undefined ||
              sideMutationBusy(state) ||
              state.side === null
            )
              return preserve;
            return {
              state: { ...state, status: "deleting" },
              effects: [
                { type: "DELETE", parentThreadId: state.parentThreadId },
              ],
            };
          case "LOADED":
          case "CREATED":
            return {
              state: {
                ...state,
                side: event.side,
                visible:
                  event.side === null && state.side !== null
                    ? false
                    : state.visible,
                status:
                  event.side !== null && event.side.status !== "ready"
                    ? "review"
                    : "idle",
                error: undefined,
                operationKey: undefined,
              },
            };
          case "DELETED":
            return {
              state: {
                parentThreadId: state.parentThreadId,
                side: null,
                visible: false,
                status: "idle",
              },
            };
          case "UNKNOWN":
            return {
              state: {
                ...state,
                status: "reconciling",
                operationKey: event.operationKey,
              },
              preserveEffects: true,
            };
          case "FAILED":
            return {
              state: {
                ...state,
                status: event.unsupported
                  ? "unsupported"
                  : event.review
                    ? "review"
                    : "failed",
                error: event.message,
              },
            };
        }
      },
      runEffect: async (effect, context) => {
        try {
          if (effect.type === "READ") {
            const response = await gateway.request(
              "side/read",
              { version: 1, parentThreadId: effect.parentThreadId },
              queryOptions(context.signal),
            );
            context.dispatch({ type: "LOADED", side: response.side });
          } else if (effect.type === "START") {
            const result = await durableMutation({
              owner: this.scope,
              gateway,
              method: "side/start",
              payload: { version: 1, parentThreadId: effect.parentThreadId },
              onOutcomeUnknown: (operationKey) =>
                context.dispatch({ type: "UNKNOWN", operationKey }),
            });
            context.dispatch({ type: "CREATED", side: result.side });
          } else if (effect.type === "ABANDON") {
            await durableMutation({
              owner: this.scope,
              gateway,
              method: "side/abandon",
              payload: {
                version: 1,
                parentThreadId: effect.parentThreadId,
                creationKey: effect.creationKey,
                acknowledgeOrphan: true,
              },
              onOutcomeUnknown: (operationKey) =>
                context.dispatch({ type: "UNKNOWN", operationKey }),
            });
            context.dispatch({ type: "DELETED" });
          } else {
            await durableMutation({
              owner: this.scope,
              gateway,
              method: "side/delete",
              payload: { version: 1, parentThreadId: effect.parentThreadId },
              onOutcomeUnknown: (operationKey) =>
                context.dispatch({ type: "UNKNOWN", operationKey }),
            });
            context.dispatch({ type: "DELETED" });
          }
        } catch (error) {
          if (!context.signal.aborted)
            context.dispatch({
              type: "FAILED",
              message: error instanceof Error ? error.message : "旁支操作失败",
              review: error instanceof MutationNeedsReviewError,
              unsupported:
                error instanceof GatewayRemoteError &&
                [
                  "UNKNOWN_METHOD",
                  "METHOD_NOT_FOUND",
                  "CAPABILITY_UNAVAILABLE",
                ].includes(error.code),
            });
        }
      },
      onEffectError: () => undefined,
    });
    this.scope.defer(this.actor.subscribe(() => this.#synchronizeSelection()));
    this.scope.defer(this.thread.subscribe(() => this.#sendInitialQuestion()));
    this.scope.defer(
      gateway.onEvent((event) => {
        this.thread.dispatch({ type: "GATEWAY_EVENT", event });
        if (event.type === "side/changed") {
          const payload = parseGatewayEventPayload(
            "side/changed",
            event.payload,
          );
          if (
            payload.parentThreadId === this.actor.getSnapshot().parentThreadId
          )
            this.actor.dispatch({ type: "RELOAD" });
        }
        if (event.type === "codex/notification") {
          const notification = parseGatewayEventPayload(
            "codex/notification",
            event.payload,
          );
          if (
            notification.threadId === this.thread.getSnapshot().threadId &&
            (notification.method.startsWith("turn/") ||
              notification.method.startsWith("item/") ||
              notification.method === "thread/compacted")
          ) {
            this.#scheduleRefresh();
          }
        }
      }),
    );
    this.scope.defer(
      gateway.onConnectionLost(() =>
        this.thread.dispatch({ type: "RECONNECTING" }),
      ),
    );
    this.scope.defer(
      gateway.onConnectionRestored(() => {
        this.actor.dispatch({ type: "RELOAD" });
        this.refreshThread();
        const operationKey = this.composer.getSnapshot().operationKey;
        if (operationKey)
          this.composer.dispatch({ type: "RECONCILE", operationKey });
      }),
    );
  }

  select(parentThreadId: string): void {
    if (this.composer.getSnapshot().status !== "idle") return;
    this.actor.dispatch({ type: "SELECT", parentThreadId });
  }
  show(question?: string): boolean {
    const state = this.actor.getSnapshot();
    this.actor.dispatch({ type: "SHOW" });
    if (state.side === null && !["idle", "failed"].includes(state.status))
      return !question;
    if (question && state.side !== null && state.side.status !== "ready")
      return false;
    if (state.side === null)
      this.actor.dispatch({ type: "START", ...(question ? { question } : {}) });
    else if (question && state.side.threadId) {
      this.composer.dispatch({
        type: "DRAFT",
        threadId: state.side.threadId,
        value: [
          composerDraftFor(this.composer.getSnapshot(), state.side.threadId),
          question,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    }
    return true;
  }
  #scheduleRefresh(): void {
    void this.#refreshScope?.close("coalesced");
    const scope = this.scope.fork("side-refresh");
    this.#refreshScope = scope;
    scope.setTimeout(() => {
      if (this.#refreshScope === scope) this.#refreshScope = undefined;
      this.refreshThread();
      void scope.close("refreshed");
    }, 100);
  }
  refreshThread(): void {
    const threadId = this.thread.getSnapshot().threadId;
    if (threadId !== undefined && !sideMutationBusy(this.actor.getSnapshot()))
      this.thread.dispatch({ type: "OPEN", threadId });
  }
  #synchronizeSelection(): void {
    const state = this.actor.getSnapshot();
    const selected = state.side?.threadId;
    const current = this.thread.getSnapshot().threadId;
    if (selected !== current) {
      this.thread.dispatch(
        selected === undefined
          ? { type: "CLOSE" }
          : { type: "OPEN", threadId: selected },
      );
    }
    this.#sendInitialQuestion();
  }
  #sendInitialQuestion(): void {
    const state = this.actor.getSnapshot();
    const thread = this.thread.getSnapshot();
    if (
      !state.initialQuestion ||
      state.status !== "idle" ||
      thread.threadId !== state.side?.threadId ||
      thread.status !== "idle"
    )
      return;
    if (this.composer.getSnapshot().status !== "idle") return;
    const question = state.initialQuestion;
    this.actor.dispatch({ type: "CONSUMED" });
    this.composer.dispatch({
      type: "DRAFT",
      threadId: thread.threadId!,
      value: question,
    });
    this.composer.dispatch({ type: "SUBMIT", threadId: thread.threadId! });
  }
}

export function sideMutationBusy(state: SideChatState): boolean {
  return (
    state.status === "creating" ||
    state.status === "deleting" ||
    state.status === "reconciling"
  );
}
