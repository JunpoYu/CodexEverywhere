import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import { TimelineItemView } from "./TimelineItemView.js";

type TimelineItem = OutputOf<"thread/open">["items"][number];

describe("TimelineItemView", () => {
  it("recognizes app-server userMessage items as user messages", () => {
    const html = render(
      item({
        type: "message",
        data: {
          type: "userMessage",
          content: [
            { type: "text", text: "检查当前工作区", text_elements: [] },
          ],
        },
      }),
    );

    expect(html).toContain("role-user");
    expect(html).toContain("检查当前工作区");
    expect(html).toContain("你");
  });

  it("presents commands as a compact readable event", () => {
    const html = render(
      item({
        type: "command",
        data: {
          type: "commandExecution",
          command: "pnpm test",
          cwd: "/public/demo",
          status: "completed",
          aggregatedOutput: "82 files passed",
        },
      }),
    );

    expect(html).toContain("pnpm test");
    expect(html).toContain("/public/demo");
    expect(html).toContain("已完成");
    expect(html).toContain("查看命令输出");
    expect(html).not.toContain("82 files passed");
  });

  it("does not render empty reasoning placeholders as raw JSON", () => {
    const html = render(
      item({
        type: "message",
        data: {
          type: "reasoning",
          id: "reasoning-empty",
          summary: [],
          content: [],
        },
      }),
    );

    expect(html).toBe("");
  });

  it("prefers a reasoning summary and falls back to reasoning content", () => {
    const summarized = render(
      item({
        type: "message",
        data: {
          type: "reasoning",
          id: "reasoning-summary",
          summary: ["先检查协议边界"],
          content: ["不应优先显示的详细推理"],
        },
      }),
    );
    const contentOnly = render(
      item({
        type: "message",
        data: {
          type: "reasoning",
          id: "reasoning-content",
          summary: [],
          content: ["检查运行状态"],
        },
      }),
    );

    expect(summarized).toContain("先检查协议边界");
    expect(summarized).not.toContain("不应优先显示的详细推理");
    expect(contentOnly).toContain("检查运行状态");
    expect(contentOnly).not.toContain("&quot;type&quot;:&quot;reasoning&quot;");
  });

  it("keeps the complete file path in a keyboard-scrollable code region", () => {
    const path =
      "/public/demo/a/very/long/path/that/must/remain/available/result.ts";
    const html = render(
      item({
        type: "file-change",
        data: {
          type: "fileChange",
          status: "completed",
          changes: [{ path, kind: "update", diff: "+changed" }],
        },
      }),
    );

    expect(html).toContain(`<code tabindex="0" title="${path}">${path}</code>`);
    expect(html).toContain("查看差异");
  });

  it("keeps unknown items inspectable without mounting closed payloads", () => {
    const html = render(
      item({
        type: "generic",
        data: { type: "futureCodexEvent", payload: { enabled: true } },
      }),
    );

    expect(html).toContain("futureCodexEvent");
    expect(html).not.toContain("enabled");
  });
});

function item(input: {
  readonly type: TimelineItem["type"];
  readonly data: TimelineItem["data"];
}): TimelineItem {
  return {
    version: 1,
    id: crypto.randomUUID(),
    type: input.type,
    data: input.data,
  };
}

function render(value: TimelineItem): string {
  return renderToStaticMarkup(createElement(TimelineItemView, { item: value }));
}
