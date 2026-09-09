import { describe, expect, it } from "vitest";

import type { TimelineItem } from "./timeline-item-model.js";
import { projectTimelinePresentation } from "./timeline-presentation-model.js";

describe("timeline presentation model", () => {
  it("groups commentary and tool activity while keeping the final answer visible", () => {
    const entries = projectTimelinePresentation(
      [
        message("user", "request", "turn-1"),
        agentMessage("commentary", "checking", "turn-1"),
        timelineItem("message", "turn-1", {
          type: "reasoning",
          summary: ["inspect the project"],
          content: [],
        }),
        timelineItem("command", "turn-1", {
          type: "commandExecution",
          command: "pnpm test",
          status: "completed",
        }),
        agentMessage("final_answer", "done", "turn-1"),
      ],
      "idle",
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "item",
      "activity",
      "item",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "activity",
      items: [
        expect.objectContaining({
          data: expect.objectContaining({ text: "checking" }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({ type: "reasoning" }),
        }),
        expect.objectContaining({ type: "command" }),
      ],
    });
    expect(entries[2]).toMatchObject({
      kind: "item",
      item: expect.objectContaining({
        data: expect.objectContaining({ text: "done" }),
      }),
    });
  });

  it("uses only the last unknown-phase assistant message for a completed legacy turn", () => {
    const entries = projectTimelinePresentation(
      [
        message("user", "request", "turn-legacy"),
        agentMessage(undefined, "intermediate", "turn-legacy"),
        agentMessage(undefined, "final", "turn-legacy"),
      ],
      "idle",
    );

    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      kind: "activity",
      items: [expect.objectContaining({ id: expect.any(String) })],
    });
    expect(entries[2]).toMatchObject({
      kind: "item",
      item: expect.objectContaining({
        data: expect.objectContaining({ text: "final" }),
      }),
    });
  });

  it("does not promote an unknown-phase message from the active turn", () => {
    const entries = projectTimelinePresentation(
      [
        message("user", "request", "turn-active"),
        agentMessage(undefined, "still working", "turn-active"),
      ],
      "running",
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["item", "activity"]);
  });

  it("keeps errors, plans, and completed review output outside process groups", () => {
    const entries = projectTimelinePresentation(
      [
        timelineItem("plan", "turn-plan", { type: "plan", text: "Plan" }),
        timelineItem("generic", "turn-review", {
          type: "exitedReviewMode",
          review: "Review result",
        }),
        timelineItem("error", "turn-error", { message: "failed" }),
      ],
      "failed",
    );

    expect(entries.map((entry) => entry.kind)).toEqual([
      "item",
      "item",
      "item",
    ]);
  });

  it("drops empty reasoning placeholders without creating an empty group", () => {
    expect(
      projectTimelinePresentation(
        [
          timelineItem("message", "turn-1", {
            type: "reasoning",
            summary: [],
            content: [],
          }),
        ],
        "idle",
      ),
    ).toEqual([]);
  });
});

function message(
  role: "user" | "assistant",
  text: string,
  turnId: string,
): TimelineItem {
  return timelineItem("message", turnId, { role, text });
}

function agentMessage(
  phase: "commentary" | "final_answer" | undefined,
  text: string,
  turnId: string,
): TimelineItem {
  return timelineItem("message", turnId, {
    type: "agentMessage",
    text,
    ...(phase === undefined ? {} : { phase }),
  });
}

function timelineItem(
  type: TimelineItem["type"],
  turnId: string,
  data: TimelineItem["data"],
): TimelineItem {
  return {
    version: 1,
    id: crypto.randomUUID(),
    turnId,
    type,
    data,
  };
}
