export type QueueSteerItemStatus =
  | "pending"
  | "paused"
  | "running"
  | "delivering"
  | "indeterminate"
  | "confirming";

type QueueSteerCandidate = {
  id: string;
  threadId: string;
  status: QueueSteerItemStatus;
};

const ACTIONABLE_STATUSES = new Set<QueueSteerItemStatus>([
  "pending",
  "paused",
]);
const DISPATCH_LOCK_STATUSES = new Set<QueueSteerItemStatus>([
  "running",
  "delivering",
  "indeterminate",
]);

/**
 * Preserve Host Queue order in the UI. Each thread may offer Steer only for
 * its earliest pending/paused item, and an earlier durable dispatch claim
 * blocks every item behind it until that claim is resolved.
 */
export function steerableQueueItemIds(
  items: readonly QueueSteerCandidate[],
): ReadonlySet<string> {
  const threadsWithActionableHead = new Set<string>();
  const threadsBlockedByDispatch = new Set<string>();
  const steerable = new Set<string>();

  for (const item of items) {
    const blockedByEarlierDispatch = threadsBlockedByDispatch.has(
      item.threadId,
    );
    if (DISPATCH_LOCK_STATUSES.has(item.status)) {
      threadsBlockedByDispatch.add(item.threadId);
    }
    if (!ACTIONABLE_STATUSES.has(item.status)) continue;
    if (!threadsWithActionableHead.has(item.threadId)) {
      threadsWithActionableHead.add(item.threadId);
      if (!blockedByEarlierDispatch) steerable.add(item.id);
    }
  }

  return steerable;
}
