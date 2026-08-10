import { describe, expect, it } from "vitest";

import {
  steerableQueueItemIds,
  type QueueSteerItemStatus,
} from "./queue-steer-visibility.js";

function item(
  id: string,
  threadId: string,
  status: QueueSteerItemStatus,
): { id: string; threadId: string; status: QueueSteerItemStatus } {
  return { id, threadId, status };
}

describe("queue Steer visibility", () => {
  it("offers Steer only for the earliest actionable item in each thread", () => {
    const visible = steerableQueueItemIds([
      item("a-1", "thread-a", "pending"),
      item("a-2", "thread-a", "paused"),
      item("a-3", "thread-a", "pending"),
      item("b-1", "thread-b", "paused"),
      item("b-2", "thread-b", "pending"),
    ]);

    expect([...visible]).toEqual(["a-1", "b-1"]);
  });

  it.each(["delivering", "indeterminate", "running"] as const)(
    "blocks items behind an earlier %s dispatch claim",
    (status) => {
      const visible = steerableQueueItemIds([
        item("claim", "thread-a", status),
        item("next", "thread-a", "pending"),
        item("later", "thread-a", "paused"),
      ]);

      expect([...visible]).toEqual([]);
    },
  );

  it("does not let a later dispatch claim retroactively hide the queue head", () => {
    const visible = steerableQueueItemIds([
      item("head", "thread-a", "pending"),
      item("claim", "thread-a", "delivering"),
      item("later", "thread-a", "paused"),
    ]);

    expect([...visible]).toEqual(["head"]);
  });

  it("does not treat an optimistic confirming row as a Host queue head", () => {
    const visible = steerableQueueItemIds([
      item("confirming", "thread-a", "confirming"),
      item("head", "thread-a", "paused"),
      item("later", "thread-a", "pending"),
    ]);

    expect([...visible]).toEqual(["head"]);
  });
});
