import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import {
  conversationOutlineLabel,
  projectConversationOutline,
} from "./conversation-outline-model.js";

type TimelineItem = OutputOf<"thread/open">["items"][number];

describe("conversation outline model", () => {
  it("projects only user messages in authoritative timeline order", () => {
    const entries = projectConversationOutline([
      item("user-1", "message", { type: "userMessage", text: "第一项" }),
      item("assistant-1", "message", {
        type: "agentMessage",
        text: "回复",
      }),
      item("plan-1", "plan", { type: "plan", text: "计划" }),
      item("user-2", "message", {
        role: "user",
        content: [{ type: "text", text: "第二项" }],
      }),
    ]);

    expect(entries.map((entry) => [entry.id, entry.label])).toEqual([
      ["user-1", "第一项"],
      ["user-2", "第二项"],
    ]);
  });

  it("normalizes whitespace and truncates by Unicode code point", () => {
    expect(conversationOutlineLabel("  第一行\n\n第二行  ")).toBe(
      "第一行 第二行",
    );
    expect(conversationOutlineLabel("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("uses a readable fallback for an empty user message", () => {
    expect(conversationOutlineLabel(" \n ")).toBe("（空消息）");
  });
});

function item(
  id: string,
  type: TimelineItem["type"],
  data: TimelineItem["data"],
): TimelineItem {
  return {
    version: 1,
    id,
    turnId: `turn-${id}`,
    type,
    createdAt: "2026-08-22T02:00:00.000Z",
    data,
  };
}
