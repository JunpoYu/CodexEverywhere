import type { OutputOf } from "@codex-everywhere/protocol/v2";

type Snapshot = OutputOf<"thread/open">;
type HistoryPage = OutputOf<"thread/history">;
type TimelineItem = Snapshot["items"][number];

/** Keep browser history requests bounded independently of the protocol maximum. */
export const TIMELINE_PAGE_SIZE = 50;

export function prependAuthoritativeHistoryPage(
  snapshot: Snapshot,
  page: HistoryPage,
): Snapshot {
  const { historyCursor: _previousCursor, ...withoutCursor } = snapshot;
  return {
    ...withoutCursor,
    items: mergeTimelinePages(page.items, snapshot.items),
    ...(page.nextCursor === undefined
      ? {}
      : { historyCursor: page.nextCursor }),
    hasEarlierHistory: page.hasMore,
  };
}

/**
 * Reconcile a refreshed latest page without discarding history that the user
 * explicitly loaded. A missing overlap is treated as window drift and fails
 * closed to the newest authoritative page.
 */
export function mergeAuthoritativeTimelineWindow(
  current: Snapshot | undefined,
  authoritative: Snapshot,
): Snapshot {
  if (current === undefined || current.thread.id !== authoritative.thread.id) {
    return authoritative;
  }

  const overlap = firstOverlap(current.items, authoritative.items);
  if (overlap === undefined) {
    return replaceAuthoritativeTimelineWindow(current, authoritative);
  }

  const retainedEarlier = current.items.slice(0, overlap.currentIndex);
  const transient = current.items.filter(isTransientGenericItem);
  const items = mergeTimelinePages(retainedEarlier, [
    ...authoritative.items,
    ...transient,
  ]);
  const { historyCursor: _authoritativeCursor, ...latest } = authoritative;
  return {
    ...latest,
    items,
    ...(current.historyCursor === undefined
      ? {}
      : { historyCursor: current.historyCursor }),
    hasEarlierHistory: current.hasEarlierHistory,
  };
}

/**
 * Drop every previously loaded authoritative item after an explicit Codex
 * compaction while retaining transient forward-compatible Gateway events.
 */
export function replaceAuthoritativeTimelineWindow(
  current: Snapshot | undefined,
  authoritative: Snapshot,
): Snapshot {
  if (current === undefined || current.thread.id !== authoritative.thread.id) {
    return authoritative;
  }
  const transient = current.items.filter(isTransientGenericItem);
  if (transient.length === 0) return authoritative;
  return {
    ...authoritative,
    items: mergeTimelinePages(authoritative.items, transient),
  };
}

export function mergeTimelinePages(
  earlier: readonly TimelineItem[],
  later: readonly TimelineItem[],
): TimelineItem[] {
  const laterIds = new Set(later.map((item) => item.id));
  return [
    ...earlier.filter((item) => !laterIds.has(item.id)),
    ...deduplicateKeepingLast(later),
  ];
}

function firstOverlap(
  current: readonly TimelineItem[],
  authoritative: readonly TimelineItem[],
): { readonly currentIndex: number } | undefined {
  const currentIndex = new Map(
    current.map((item, index) => [item.id, index] as const),
  );
  for (const item of authoritative) {
    const index = currentIndex.get(item.id);
    if (index !== undefined) return { currentIndex: index };
  }
  return undefined;
}

function deduplicateKeepingLast(
  items: readonly TimelineItem[],
): TimelineItem[] {
  const seen = new Set<string>();
  const result: TimelineItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result.reverse();
}

function isTransientGenericItem(item: TimelineItem): boolean {
  return item.type === "generic" && item.data.source === "codex/generic";
}
