import { describe, expect, it } from "vitest";

import { conversationOutlineLabel } from "./conversation-outline.js";

describe("conversation outline labels", () => {
  it("turns a multiline user message into a compact readable label", () => {
    expect(conversationOutlineLabel("  第一行\n\n第二行   第三段  ")).toBe(
      "第一行 第二行 第三段",
    );
  });

  it("truncates long messages without exceeding the configured length", () => {
    const label = conversationOutlineLabel(
      "这是一个需要在大纲里缩短的很长消息",
      10,
    );
    expect(label).toBe("这是一个需要在大纲…");
    expect(label).toHaveLength(10);
  });

  it("uses a meaningful fallback for empty message content", () => {
    expect(conversationOutlineLabel(" \n ")).toBe("（空消息）");
  });
});
