import { Actor, type Scope } from "@codex-everywhere/kernel";
import { MutationOutcomeUnknownError } from "@codex-everywhere/protocol/v2";

import {
  mutationOptions,
  queryOptions,
  type GatewayPort,
} from "../gateway/gateway-port.js";

export interface ComposerState {
  readonly status:
    "idle" | "submitting" | "outcome-unknown" | "reconciling" | "manual-review";
  readonly drafts: Readonly<Record<string, string>>;
  readonly threadId?: string;
  readonly operationKey?: string;
  readonly submittedText?: string;
  readonly submission?: "turn" | "queue";
  readonly error?: string;
}

type Event =
  | {
      readonly type: "DRAFT";
      readonly threadId: string;
      readonly value: string;
    }
  | { readonly type: "SUBMIT"; readonly threadId: string }
  | { readonly type: "QUEUE"; readonly threadId: string }
  | { readonly type: "SENT" }
  | { readonly type: "UNKNOWN"; readonly operationKey: string }
  | { readonly type: "RECONCILE"; readonly operationKey: string }
  | { readonly type: "RESOLVED" }
  | { readonly type: "MANUAL"; readonly message: string }
  | { readonly type: "ACKNOWLEDGE_MANUAL" }
  | { readonly type: "FAILED"; readonly message: string };

type Effect =
  | {
      readonly type: "SEND";
      readonly threadId: string;
      readonly text: string;
      readonly operationKey: string;
    }
  | {
      readonly type: "ENQUEUE";
      readonly threadId: string;
      readonly text: string;
      readonly operationKey: string;
    }
  | { readonly type: "STATUS"; readonly operationKey: string };

export function createComposerActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<ComposerState, Event, Effect>({
    name: "composer",
    scope,
    initialState: { status: "idle", drafts: {} },
    reducer: (state, event) => {
      switch (event.type) {
        case "DRAFT": {
          const nextDrafts = { ...state.drafts, [event.threadId]: event.value };
          if (state.status === "idle" && state.threadId === event.threadId) {
            const {
              error: _error,
              threadId: _feedbackThreadId,
              ...withoutFeedback
            } = state;
            return {
              state: { ...withoutFeedback, drafts: nextDrafts },
              preserveEffects: true,
            };
          }
          return {
            state: { ...state, drafts: nextDrafts },
            preserveEffects: true,
          };
        }
        case "SUBMIT":
        case "QUEUE": {
          const text = composerDraftFor(state, event.threadId).trim();
          if (state.status !== "idle" || text.length === 0) {
            return { state, preserveEffects: true };
          }
          const operationKey = crypto.randomUUID();
          return {
            state: {
              status: "submitting",
              drafts: { ...state.drafts, [event.threadId]: "" },
              threadId: event.threadId,
              operationKey,
              submittedText: text,
              submission: event.type === "SUBMIT" ? "turn" : "queue",
            },
            effects: [
              {
                type: event.type === "SUBMIT" ? "SEND" : "ENQUEUE",
                threadId: event.threadId,
                text,
                operationKey,
              },
            ],
          };
        }
        case "SENT":
        case "RESOLVED": {
          return { state: { status: "idle", drafts: state.drafts } };
        }
        case "UNKNOWN":
          return {
            state: {
              ...state,
              status: "outcome-unknown",
              operationKey: event.operationKey,
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
        case "MANUAL":
          return {
            state: { ...state, status: "manual-review", error: event.message },
          };
        case "ACKNOWLEDGE_MANUAL":
          if (state.status !== "manual-review") {
            return { state, preserveEffects: true };
          }
          return {
            state: {
              status: "idle",
              drafts: restoreSubmittedDraft(state),
            },
          };
        case "FAILED":
          return {
            state: {
              status: "idle",
              drafts: restoreSubmittedDraft(state),
              ...(state.threadId === undefined
                ? {}
                : { threadId: state.threadId }),
              error: event.message,
            },
          };
      }
    },
    runEffect: async (effect, context) => {
      if (effect.type === "SEND" || effect.type === "ENQUEUE") {
        try {
          if (effect.type === "SEND") {
            await gateway.request(
              "turn/start",
              {
                version: 1,
                threadId: effect.threadId,
                prompt: effect.text,
              },
              mutationOptions(effect.operationKey, context.signal),
            );
          } else {
            await gateway.request(
              "queue/add",
              {
                version: 1,
                threadId: effect.threadId,
                text: effect.text,
              },
              mutationOptions(effect.operationKey, context.signal),
            );
          }
          context.dispatch({ type: "SENT" });
        } catch (error) {
          if (context.signal.aborted) return;
          if (error instanceof MutationOutcomeUnknownError) {
            context.dispatch({
              type: "UNKNOWN",
              operationKey: error.operationKey,
            });
          } else {
            context.dispatch({ type: "FAILED", message: message(error) });
          }
        }
        return;
      }
      try {
        const status = await gateway.request(
          "mutation/status",
          { version: 1, operationKey: effect.operationKey },
          queryOptions(context.signal),
        );
        if (status.status === "completed") {
          context.dispatch(
            status.outcome.kind === "success"
              ? { type: "RESOLVED" }
              : { type: "FAILED", message: status.outcome.error.message },
          );
        } else if (status.status === "pending") {
          await abortableDelay(1_000, context.signal);
          context.dispatch({
            type: "RECONCILE",
            operationKey: effect.operationKey,
          });
        } else {
          context.dispatch({
            type: "MANUAL",
            message:
              status.status === "indeterminate"
                ? "宿主机无法确认本次发送是否生效，请检查任务历史后再操作。"
                : "宿主机没有找到本次操作，请检查任务历史。",
          });
        }
      } catch (error) {
        if (!context.signal.aborted) {
          context.dispatch({ type: "MANUAL", message: message(error) });
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : "消息发送失败";
}

export function composerDraftFor(
  state: ComposerState,
  threadId: string,
): string {
  return state.drafts[threadId] ?? "";
}

function restoreSubmittedDraft(
  state: ComposerState,
): Readonly<Record<string, string>> {
  if (state.threadId === undefined || state.submittedText === undefined) {
    return state.drafts;
  }
  const current = composerDraftFor(state, state.threadId);
  return current.length > 0
    ? state.drafts
    : { ...state.drafts, [state.threadId]: state.submittedText };
}
