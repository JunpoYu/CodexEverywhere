import { describe, expect, it } from "vitest";

import {
  approvalPresentation,
  contextUsagePresentation,
  formatTokenCount,
  mcpElicitationResponse,
  sandboxModeForPolicy,
} from "./session-controls.js";

describe("approvalPresentation", () => {
  it("shows the command and reason without exposing protocol JSON", () => {
    expect(
      approvalPresentation("item/commandExecution/requestApproval", {
        command: "pnpm test",
        cwd: "/work/project",
        reason: "需要运行测试",
        threadId: "thread-secret",
      }),
    ).toEqual({
      title: "允许 Codex 执行命令？",
      summary: "需要运行测试",
      code: "pnpm test",
      meta: ["工作目录：/work/project"],
    });
  });

  it("uses a network-specific prompt when Codex requests a host", () => {
    expect(
      approvalPresentation("item/commandExecution/requestApproval", {
        networkApprovalContext: { protocol: "https", host: "example.com" },
      }),
    ).toMatchObject({
      title: "允许 Codex 访问网络？",
      meta: ["目标：https://example.com"],
    });
  });
});

describe("sandboxModeForPolicy", () => {
  it("maps app-server policy variants to resume overrides", () => {
    expect(sandboxModeForPolicy("readOnly")).toBe("read-only");
    expect(sandboxModeForPolicy("workspaceWrite")).toBe("workspace-write");
    expect(sandboxModeForPolicy("dangerFullAccess")).toBe("danger-full-access");
  });
});

describe("mcpElicitationResponse", () => {
  it("uses the app-server elicitation response schema", () => {
    expect(mcpElicitationResponse(false)).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
  });
});

describe("contextUsagePresentation", () => {
  it("shows current context use rather than cumulative token spend", () => {
    expect(
      contextUsagePresentation({
        last: {
          totalTokens: 32_000,
          inputTokens: 30_000,
          cachedInputTokens: 20_000,
          outputTokens: 1_000,
          reasoningOutputTokens: 1_000,
        },
        total: {
          totalTokens: 180_000,
          inputTokens: 160_000,
          cachedInputTokens: 100_000,
          outputTokens: 10_000,
          reasoningOutputTokens: 10_000,
        },
        modelContextWindow: 128_000,
      }),
    ).toEqual({
      label: "32K / 128K",
      percent: 25,
      detail: "25.0% · 累计 180K",
    });
  });

  it("formats compact token counts and an unavailable state", () => {
    expect(formatTokenCount(1_250)).toBe("1.3K");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(contextUsagePresentation(undefined).percent).toBeNull();
  });
});
