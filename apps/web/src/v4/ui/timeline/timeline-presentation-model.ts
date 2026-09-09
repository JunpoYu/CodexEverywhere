import type { OutputOf } from "@codex-everywhere/protocol/v2";

import {
  isEmptyReasoningTimelineItem,
  isUserTimelineItem,
  timelineMessageRole,
  type TimelineItem,
} from "./timeline-item-model.js";

type ThreadState = OutputOf<"thread/open">["state"];

export type TimelinePresentationEntry =
  | {
      readonly kind: "item";
      readonly id: string;
      readonly item: TimelineItem;
    }
  | {
      readonly kind: "activity";
      readonly id: string;
      readonly items: readonly TimelineItem[];
    };

/**
 * Keeps conversation outcomes prominent while retaining every process item
 * behind one turn-scoped disclosure. This is a view projection only: the
 * actor's authoritative snapshot remains untouched.
 */
export function projectTimelinePresentation(
  items: readonly TimelineItem[],
  threadState: ThreadState,
): TimelinePresentationEntry[] {
  const visible = items.filter((item) => !isEmptyReasoningTimelineItem(item));
  const legacyFinalIds = legacyFinalAssistantIds(visible, threadState);
  const entries: TimelinePresentationEntry[] = [];
  let activityItems: TimelineItem[] = [];
  let activityTurnId: string | undefined;

  const flushActivity = () => {
    const first = activityItems[0];
    if (first === undefined) return;
    entries.push({
      kind: "activity",
      id: `activity:${first.turnId ?? "unscoped"}:${first.id}`,
      items: activityItems,
    });
    activityItems = [];
    activityTurnId = undefined;
  };

  for (const item of visible) {
    if (isPrimaryTimelineItem(item, legacyFinalIds)) {
      flushActivity();
      entries.push({ kind: "item", id: item.id, item });
      continue;
    }
    if (activityItems.length > 0 && activityTurnId !== item.turnId) {
      flushActivity();
    }
    activityTurnId = item.turnId;
    activityItems.push(item);
  }
  flushActivity();
  return entries;
}

function legacyFinalAssistantIds(
  items: readonly TimelineItem[],
  threadState: ThreadState,
): ReadonlySet<string> {
  const explicitFinalTurns = new Set<string>();
  const candidates = new Map<string, string>();

  for (const item of items) {
    if (!isAssistantMessage(item)) continue;
    const turnKey = item.turnId ?? "unscoped";
    if (item.data.phase === "final_answer") {
      explicitFinalTurns.add(turnKey);
      continue;
    }
    if (item.data.phase !== "commentary") candidates.set(turnKey, item.id);
  }

  for (const turnKey of explicitFinalTurns) candidates.delete(turnKey);
  if (threadState !== "idle") {
    const latestTurnKey = latestTurn(items)?.turnId ?? "unscoped";
    candidates.delete(latestTurnKey);
  }
  return new Set(candidates.values());
}

function isPrimaryTimelineItem(
  item: TimelineItem,
  legacyFinalIds: ReadonlySet<string>,
): boolean {
  if (
    isUserTimelineItem(item) ||
    item.type === "error" ||
    item.type === "plan"
  ) {
    return true;
  }
  if (item.type === "generic" && item.data.type === "exitedReviewMode") {
    return true;
  }
  if (!isAssistantMessage(item)) return false;
  return item.data.phase === "final_answer" || legacyFinalIds.has(item.id);
}

function isAssistantMessage(item: TimelineItem): boolean {
  if (item.type !== "message" || timelineMessageRole(item) !== "assistant") {
    return false;
  }
  return item.data.type !== "reasoning" && item.data.type !== "hookPrompt";
}

function latestTurn(items: readonly TimelineItem[]): TimelineItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.turnId !== undefined) return items[index];
  }
  return items.at(-1);
}
