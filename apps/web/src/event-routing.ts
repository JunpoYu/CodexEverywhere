const HOST_LEVEL_EVENT_TYPES = new Set([
  "codex/account/login/completed",
  "codex/account/updated",
  "codex/account/rateLimits/updated",
  "codex/configWarning",
  "codex/remoteControl/status/changed",
]);

export type CodexLoginEventAction =
  | { type: "ignore" }
  | { type: "refresh" }
  | { type: "failed"; message: string };

export function codexLoginEventAction(input: {
  eventType: string;
  payload: unknown;
  pendingLoginId: string | undefined;
}): CodexLoginEventAction {
  if (!input.pendingLoginId) return { type: "ignore" };
  const payload = asRecord(input.payload);
  if (input.eventType === "codex/account/login/completed") {
    const loginId = payload?.loginId;
    if (typeof loginId === "string" && loginId !== input.pendingLoginId) {
      return { type: "ignore" };
    }
    if (payload?.success === true) return { type: "refresh" };
    const error = payload?.error;
    return {
      type: "failed",
      message:
        typeof error === "string" && error.trim()
          ? error
          : "Codex 登录未完成，请重新生成代码",
    };
  }
  if (
    input.eventType === "codex/account/updated" &&
    payload?.authMode !== null &&
    payload?.authMode !== undefined
  ) {
    return { type: "refresh" };
  }
  return { type: "ignore" };
}

export function shouldRenderInThreadTimeline(input: {
  activeThreadId: string | undefined;
  eventThreadId: string | undefined;
  eventType: string;
}): boolean {
  if (!input.activeThreadId) return false;
  if (HOST_LEVEL_EVENT_TYPES.has(input.eventType)) return false;
  return (
    input.eventThreadId === undefined ||
    input.eventThreadId === input.activeThreadId
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
