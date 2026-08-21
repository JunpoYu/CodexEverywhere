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
  });

  it("keeps unknown items inspectable without assuming their shape", () => {
    const html = render(
      item({
        type: "generic",
        data: { type: "futureCodexEvent", payload: { enabled: true } },
      }),
    );

    expect(html).toContain("futureCodexEvent");
    expect(html).toContain("enabled");
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
