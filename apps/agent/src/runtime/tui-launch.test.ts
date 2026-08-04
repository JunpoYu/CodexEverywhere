import { describe, expect, it } from "vitest";

import { tuiArguments, tuiExitGuidance } from "./tui-launch.js";

const connection = [
  "--remote",
  "unix:///tmp/codex-everywhere-1000/app-server.sock",
  "-C",
  "/public/home/user/project",
];

describe("TUI handoff", () => {
  it("explains how to leave without interrupting a running turn", () => {
    expect(tuiExitGuidance()).toContain("/quit");
    expect(tuiExitGuidance()).toContain("/exit");
    expect(tuiExitGuidance()).toContain("Esc 会中断当前任务");
  });

  it("opens the shared app-server resume picker by default", () => {
    expect(
      tuiArguments({
        socketPath: "/tmp/codex-everywhere-1000/app-server.sock",
        workspacePath: "/public/home/user/project",
      }),
    ).toEqual(["resume", "--include-non-interactive", ...connection]);
  });

  it("resumes the selected Web thread directly", () => {
    expect(
      tuiArguments({
        socketPath: "/tmp/codex-everywhere-1000/app-server.sock",
        workspacePath: "/public/home/user/project",
        thread: "  thr_123  ",
      }),
    ).toEqual([
      "resume",
      "--include-non-interactive",
      ...connection,
      "thr_123",
    ]);
  });

  it("starts a new remote TUI thread only when explicitly requested", () => {
    expect(
      tuiArguments({
        socketPath: "/tmp/codex-everywhere-1000/app-server.sock",
        workspacePath: "/public/home/user/project",
        newThread: true,
      }),
    ).toEqual(connection);
  });

  it("rejects conflicting new and resume modes", () => {
    expect(() =>
      tuiArguments({
        socketPath: "/tmp/codex-everywhere-1000/app-server.sock",
        workspacePath: "/public/home/user/project",
        thread: "thr_123",
        newThread: true,
      }),
    ).toThrow("--new and --thread cannot be used together");
  });
});
