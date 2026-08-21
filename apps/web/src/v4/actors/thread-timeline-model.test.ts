import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import {
  mergeAuthoritativeTimelineWindow,
  prependAuthoritativeHistoryPage,
  replaceAuthoritativeTimelineWindow,
  TIMELINE_PAGE_SIZE,
} from "./thread-timeline-model.js";

type Snapshot = OutputOf<"thread/open">;

describe("thread timeline window model", () => {
  it("uses a deliberately bounded browser page size", () => {
    expect(TIMELINE_PAGE_SIZE).toBe(50);
  });

  it("prepends an authoritative page and lets the newer window win overlaps", () => {
    const current = snapshot(["item-3", "item-4"], {
      historyCursor: "cursor-3",
      hasEarlierHistory: true,
    });
    const next = prependAuthoritativeHistoryPage(current, {
      version: 1,
      items: [timelineItem("item-1"), timelineItem("item-3", "older-copy")],
      nextCursor: "cursor-1",
      hasMore: true,
    });

    expect(next.items.map((item) => item.id)).toEqual([
      "item-1",
      "item-3",
      "item-4",
    ]);
    expect(next.items[1]?.data.text).toBe("item-3");
    expect(next.historyCursor).toBe("cursor-1");
    expect(next.hasEarlierHistory).toBe(true);
  });

  it("keeps explicitly loaded history when the refreshed latest page overlaps", () => {
    const current = snapshot(["item-1", "item-2", "item-3", "item-4"], {
      historyCursor: "cursor-1",
      hasEarlierHistory: true,
    });
    const authoritative = snapshot(
      ["item-3", "item-4", "item-5"],
      { historyCursor: "cursor-3", hasEarlierHistory: true },
      "latest",
    );

    const merged = mergeAuthoritativeTimelineWindow(current, authoritative, [
      "item-1",
      "item-2",
    ]);

    expect(merged.items.map((item) => item.id)).toEqual([
      "item-1",
      "item-2",
      "item-3",
      "item-4",
      "item-5",
    ]);
    expect(merged.items[2]?.data.text).toBe("latest:item-3");
    expect(merged.historyCursor).toBe("cursor-1");
  });

  it("does not turn an aging latest-window item into retained history", () => {
    const current = snapshot(
      Array.from({ length: 50 }, (_, index) => `item-${index + 51}`),
      { historyCursor: "cursor-51", hasEarlierHistory: true },
    );
    const authoritative = snapshot(
      Array.from({ length: 50 }, (_, index) => `item-${index + 52}`),
      { historyCursor: "cursor-52", hasEarlierHistory: true },
    );

    const merged = mergeAuthoritativeTimelineWindow(current, authoritative);

    expect(merged.items.map((item) => item.id)).toEqual(
      authoritative.items.map((item) => item.id),
    );
    expect(merged.items).toHaveLength(50);
    expect(merged.historyCursor).toBe("cursor-51");
  });

  it("replaces a window with no stable overlap while retaining generic events", () => {
    const current = snapshot(["old-1", "old-2"]);
    current.items.push({
      version: 1,
      id: "gateway:event-1",
      type: "generic",
      data: { source: "codex/generic", method: "future/progress" },
    });
    const authoritative = snapshot(["new-1", "new-2"]);

    const merged = mergeAuthoritativeTimelineWindow(current, authoritative);

    expect(merged.items.map((item) => item.id)).toEqual([
      "new-1",
      "new-2",
      "gateway:event-1",
    ]);
  });

  it("drops a loaded prefix after explicit compaction even when IDs overlap", () => {
    const current = snapshot(["old-prefix", "survivor"], {
      historyCursor: "cursor-old",
      hasEarlierHistory: true,
    });
    const authoritative = snapshot(["survivor", "summary"]);

    const replaced = replaceAuthoritativeTimelineWindow(current, authoritative);

    expect(replaced.items.map((item) => item.id)).toEqual([
      "survivor",
      "summary",
    ]);
    expect(replaced.historyCursor).toBeUndefined();
    expect(replaced.hasEarlierHistory).toBe(false);
  });
});

function snapshot(
  ids: readonly string[],
  page: {
    readonly historyCursor?: string;
    readonly hasEarlierHistory?: boolean;
  } = {},
  prefix = "",
): Snapshot {
  const now = "2026-08-22T00:00:00.000Z";
  return {
    version: 1,
    thread: {
      version: 1,
      id: "thread-1",
      workspaceId: "workspace-1",
      title: "Task",
      state: "idle",
      archived: false,
      createdAt: now,
      updatedAt: now,
    },
    state: "idle",
    items: ids.map((id) => timelineItem(id, prefix)),
    interactions: [],
    ...(page.historyCursor === undefined
      ? {}
      : { historyCursor: page.historyCursor }),
    hasEarlierHistory: page.hasEarlierHistory ?? false,
    settings: { version: 1, revision: 0 },
  };
}

function timelineItem(id: string, prefix = ""): Snapshot["items"][number] {
  return {
    version: 1,
    id,
    type: "message",
    data: { type: "agentMessage", text: `${prefix}${prefix ? ":" : ""}${id}` },
  };
}
