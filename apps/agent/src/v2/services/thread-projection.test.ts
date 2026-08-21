import { describe, expect, it } from "vitest";

import type { CodexObject } from "../codex/codex-json.js";
import {
  projectThreadHistory,
  projectThreadTimeline,
} from "./thread-projection.js";

describe("thread projection", () => {
  it("preserves Codex plan items as structured timeline entries", () => {
    const timeline = projectThreadTimeline(authoritativeThread());

    expect(timeline).toEqual([
      expect.objectContaining({
        id: "user-1",
        turnId: "turn-1",
        type: "message",
        createdAt: "2023-11-14T22:13:20.000Z",
      }),
      expect.objectContaining({
        id: "plan-1",
        turnId: "turn-1",
        type: "plan",
        data: expect.objectContaining({ type: "plan" }),
      }),
      expect.objectContaining({
        id: "agent-1",
        turnId: "turn-1",
        type: "message",
      }),
    ]);
  });

  it("paginates backward with stable item boundaries", () => {
    const thread: CodexObject = {
      turns: [
        {
          id: "turn-1",
          items: Array.from({ length: 5 }, (_, index) => ({
            id: `item-${index + 1}`,
            type: "agentMessage",
            text: `message ${index + 1}`,
          })),
        },
      ],
    };

    const latest = projectThreadHistory(thread, undefined, 2);
    expect(latest.items.map((item) => item.id)).toEqual(["item-4", "item-5"]);
    expect(latest.hasMore).toBe(true);
    expect(latest.nextCursor).toBeTypeOf("string");

    const earlier = projectThreadHistory(thread, latest.nextCursor, 2);
    expect(earlier.items.map((item) => item.id)).toEqual(["item-2", "item-3"]);
    expect(earlier.hasMore).toBe(true);

    const first = projectThreadHistory(thread, earlier.nextCursor, 2);
    expect(first.items.map((item) => item.id)).toEqual(["item-1"]);
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).toBeUndefined();
  });

  it("rejects a cursor whose authoritative boundary disappeared", () => {
    const page = projectThreadHistory(authoritativeThread(), undefined, 1);
    const changed: CodexObject = { turns: [] };

    expect(() => projectThreadHistory(changed, page.nextCursor, 1)).toThrow(
      "History cursor is no longer present",
    );
  });
});

function authoritativeThread(): CodexObject {
  return {
    turns: [
      {
        id: "turn-1",
        startedAt: 1_700_000_000,
        items: [
          { id: "user-1", type: "userMessage", text: "inspect" },
          {
            id: "plan-1",
            type: "plan",
            items: [{ step: "Read the repository", status: "inProgress" }],
          },
          { id: "agent-1", type: "agentMessage", text: "done" },
        ],
      },
    ],
  };
}
