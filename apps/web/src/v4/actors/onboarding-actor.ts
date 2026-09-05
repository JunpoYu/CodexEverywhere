import { Actor, type Scope } from "@codex-everywhere/kernel";
import type {
  GatewayEventPayload,
  OutputOf,
} from "@codex-everywhere/protocol/v2";

import { queryOptions, type GatewayPort } from "../gateway/gateway-port.js";

export type OnboardingStep =
  "inspect" | "network" | "install" | "codex-login" | "ready";

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly loading: boolean;
  readonly status?: OutputOf<"setup/status">;
  readonly installProgress?: GatewayEventPayload<"setup/codex/install/progress">;
  readonly loginCompletion?: GatewayEventPayload<"setup/codex/login/completed">;
  readonly error?: string;
}

type Event =
  | { readonly type: "INSPECT" }
  | { readonly type: "INSTALL_STARTED" }
  | { readonly type: "RUNTIME_RESTARTED" }
  | { readonly type: "LOGIN_STARTED" }
  | { readonly type: "LOADED"; readonly status: OutputOf<"setup/status"> }
  | {
      readonly type: "INSTALL_PROGRESS";
      readonly progress: GatewayEventPayload<"setup/codex/install/progress">;
    }
  | {
      readonly type: "LOGIN_COMPLETED";
      readonly completion: GatewayEventPayload<"setup/codex/login/completed">;
    }
  | { readonly type: "FAILED"; readonly message: string };

type Effect = { readonly type: "LOAD" };

export function createOnboardingActor(scope: Scope, gateway: GatewayPort) {
  return new Actor<OnboardingState, Event, Effect>({
    name: "onboarding",
    scope,
    initialState: { step: "inspect", loading: false },
    reducer: (state, event) => {
      switch (event.type) {
        case "INSPECT":
          return {
            state: { ...withoutError(state), loading: true },
            effects: [{ type: "LOAD" }],
          };
        case "INSTALL_STARTED":
          return { state: withoutInstallProgress(withoutError(state)) };
        case "RUNTIME_RESTARTED":
          return {
            state: withoutInstallProgress(withoutError(state)),
            preserveEffects: true,
          };
        case "LOGIN_STARTED":
          return { state: withoutLoginCompletion(withoutError(state)) };
        case "LOADED": {
          const error =
            state.installProgress?.phase === "failed"
              ? "Codex 更新或 app-server 切换失败；请确认没有活动任务后重试，必要时检查 Agent 日志"
              : !event.status.codexAuthenticated &&
                  state.loginCompletion?.success === false
                ? (state.loginCompletion.error ?? "Codex 设备码登录失败")
                : undefined;
          return {
            state: {
              ...withoutError(state),
              loading: false,
              step: setupStep(event.status),
              status: event.status,
              ...(error === undefined ? {} : { error }),
            },
          };
        }
        case "INSTALL_PROGRESS": {
          const error =
            event.progress.phase === "failed"
              ? "Codex 更新或 app-server 切换失败；请确认没有活动任务后重试，必要时检查 Agent 日志"
              : undefined;
          return {
            state: {
              ...withoutError(state),
              installProgress: event.progress,
              ...(error === undefined ? {} : { error }),
            },
            preserveEffects: true,
          };
        }
        case "LOGIN_COMPLETED": {
          const error = event.completion.success
            ? undefined
            : (event.completion.error ?? "Codex 设备码登录失败");
          return {
            state: {
              ...withoutError(state),
              loginCompletion: event.completion,
              ...(error === undefined ? {} : { error }),
            },
            preserveEffects: true,
          };
        }
        case "FAILED":
          return {
            state: { ...state, loading: false, error: event.message },
          };
      }
    },
    runEffect: async (_effect, context) => {
      try {
        const status = await gateway.request(
          "setup/status",
          { version: 1 },
          queryOptions(context.signal),
        );
        context.dispatch({ type: "LOADED", status });
      } catch (error) {
        if (!context.signal.aborted) {
          context.dispatch({ type: "FAILED", message: message(error) });
        }
      }
    },
    onEffectError: () => undefined,
  });
}

function setupStep(status: OutputOf<"setup/status">): OnboardingStep {
  if (!status.networkConfigured) return "network";
  if (!status.codexInstalled) return "install";
  if (!status.codexAuthenticated) return "codex-login";
  return "ready";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "初始化状态读取失败";
}

function withoutError(state: OnboardingState): Omit<OnboardingState, "error"> {
  const { error: _error, ...rest } = state;
  return rest;
}

function withoutInstallProgress<State extends OnboardingState>(
  state: State,
): Omit<State, "installProgress"> {
  const { installProgress: _installProgress, ...rest } = state;
  return rest;
}

function withoutLoginCompletion<State extends OnboardingState>(
  state: State,
): Omit<State, "loginCompletion"> {
  const { loginCompletion: _loginCompletion, ...rest } = state;
  return rest;
}
