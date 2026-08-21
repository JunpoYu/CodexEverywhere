import {
  isUserTimelineItem,
  timelineItemText,
  type TimelineItem,
} from "./timeline-item-model.js";

const DEFAULT_LABEL_LENGTH = 72;

export interface ConversationOutlineEntry {
  readonly id: string;
  readonly turnId?: string;
  readonly label: string;
  readonly createdAt?: string;
}

export function projectConversationOutline(
  items: readonly TimelineItem[],
): ConversationOutlineEntry[] {
  return items.filter(isUserTimelineItem).map((item) => ({
    id: item.id,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    label: conversationOutlineLabel(timelineItemText(item.data) ?? ""),
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
  }));
}

export function conversationOutlineLabel(
  text: string,
  maxLength = DEFAULT_LABEL_LENGTH,
): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "（空消息）";
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  return `${characters
    .slice(0, Math.max(1, maxLength - 1))
    .join("")
    .trimEnd()}…`;
}
