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

  it("pages complete recent turns even when tools alone exceed the item limit", () => {
    const thread: CodexObject = {
      turns: Array.from({ length: 8 }, (_, turn) => ({
        id: `turn-${turn}`,
        items: [
          { id: `user-${turn}`, type: "userMessage", text: "request" },
          ...Array.from({ length: 75 }, (_, item) => ({
            id: `tool-${turn}-${item}`,
            type: "commandExecution",
            status: "completed",
          })),
          {
            id: `answer-${turn}`,
            type: "agentMessage",
            text: "answer",
            phase: "final_answer",
          },
        ],
      })),
    };
    const latest = projectThreadHistory(thread, undefined, 50, 3);
    expect(latest.items[0]?.id).toBe("user-5");
    expect(latest.items.at(-1)?.id).toBe("answer-7");
    expect(latest.items).toHaveLength(3 * 77);
    const earlier = projectThreadHistory(thread, latest.nextCursor, 50, 3);
    expect(earlier.items[0]?.id).toBe("user-2");
    expect(earlier.items.at(-1)?.id).toBe("answer-4");
    const first = projectThreadHistory(thread, earlier.nextCursor, 50, 3);
    expect(first.items[0]?.id).toBe("user-0");
    expect(first.hasMore).toBe(false);
    expect(first.nextCursor).toBeUndefined();
    expect([...first.items, ...earlier.items, ...latest.items]).toEqual(
      projectThreadTimeline(thread),
    );
  });

  it("rejects a cursor whose authoritative boundary disappeared", () => {
    const page = projectThreadHistory(authoritativeThread(), undefined, 1);
    const changed: CodexObject = { turns: [] };

    expect(() => projectThreadHistory(changed, page.nextCursor, 1)).toThrow(
      "History cursor is no longer present",
    );
  });

  it("counts persisted compactions across the full authoritative history", () => {
    const thread: CodexObject = {
      turns: [
        {
          id: "turn-1",
          items: [
            { id: "compact-1", type: "contextCompaction" },
            { id: "message-1", type: "agentMessage", text: "after first" },
          ],
        },
        {
          id: "turn-2",
          items: [
            { id: "compact-2", type: "contextCompaction" },
            { id: "compact-1", type: "contextCompaction" },
            { id: "message-2", type: "agentMessage", text: "after second" },
          ],
        },
      ],
    };

    const latest = projectThreadHistory(thread, undefined, 1);

    expect(latest.items.map((item) => item.id)).toEqual(["message-2"]);
    expect(latest.compactionCount).toBe(2);
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
