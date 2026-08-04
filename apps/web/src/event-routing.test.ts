import { describe, expect, it } from "vitest";

import {
  codexLoginEventAction,
  shouldRenderInThreadTimeline,
} from "./event-routing.js";

describe("shouldRenderInThreadTimeline", () => {
  it("keeps every event out of the empty thread view", () => {
    expect(
      shouldRenderInThreadTimeline({
        activeThreadId: undefined,
        eventThreadId: undefined,
        eventType: "codex/configWarning",
      }),
    ).toBe(false);
    expect(
      shouldRenderInThreadTimeline({
        activeThreadId: undefined,
        eventThreadId: "thread-1",
        eventType: "codex/turn/started",
      }),
    ).toBe(false);
  });

  it("does not mix host-level status into an open thread", () => {
    for (const eventType of [
      "codex/configWarning",
      "codex/remoteControl/status/changed",
      "codex/account/login/completed",
      "codex/account/updated",
    ]) {
      expect(
        shouldRenderInThreadTimeline({
          activeThreadId: "thread-1",
          eventThreadId: undefined,
          eventType,
        }),
      ).toBe(false);
    }
  });

  it("renders current-thread and forward-compatible generic events", () => {
    expect(
      shouldRenderInThreadTimeline({
        activeThreadId: "thread-1",
        eventThreadId: "thread-1",
        eventType: "codex/turn/started",
      }),
    ).toBe(true);
    expect(
      shouldRenderInThreadTimeline({
        activeThreadId: "thread-1",
        eventThreadId: undefined,
        eventType: "codex/future/event",
      }),
    ).toBe(true);
  });

  it("rejects events from another thread", () => {
    expect(
      shouldRenderInThreadTimeline({
        activeThreadId: "thread-1",
        eventThreadId: "thread-2",
        eventType: "codex/item/started",
      }),
    ).toBe(false);
  });
});

describe("codexLoginEventAction", () => {
  it("advances the matching app-server login completion", () => {
    expect(
      codexLoginEventAction({
        eventType: "codex/account/login/completed",
        pendingLoginId: "login-1",
        payload: { loginId: "login-1", success: true, error: null },
      }),
    ).toEqual({ type: "refresh" });
    expect(
      codexLoginEventAction({
        eventType: "codex/account/updated",
        pendingLoginId: "login-1",
        payload: { authMode: "chatgpt" },
      }),
    ).toEqual({ type: "refresh" });
  });

  it("ignores stale logins and reports an app-server failure", () => {
    expect(
      codexLoginEventAction({
        eventType: "codex/account/login/completed",
        pendingLoginId: "login-1",
        payload: { loginId: "login-old", success: true },
      }),
    ).toEqual({ type: "ignore" });
    expect(
      codexLoginEventAction({
        eventType: "codex/account/login/completed",
        pendingLoginId: "login-1",
        payload: { loginId: "login-1", success: false, error: "expired" },
      }),
    ).toEqual({ type: "failed", message: "expired" });
  });
});
