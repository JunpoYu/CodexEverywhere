import type { OutputOf } from "@codex-everywhere/protocol/v2";

export type TimelineItem = OutputOf<"thread/open">["items"][number];
export type TimelineData = TimelineItem["data"];

export function timelineMessageRole(item: TimelineItem): "user" | "assistant" {
  return item.data.role === "user" || item.data.type === "userMessage"
    ? "user"
    : "assistant";
}

export function isUserTimelineItem(item: TimelineItem): boolean {
  return item.type === "message" && timelineMessageRole(item) === "user";
}

export function timelineItemText(data: TimelineData): string | undefined {
  const direct = stringValue(data.text);
  if (direct !== undefined) return direct;
  const content = objectArray(data.content);
  const contentText = content
    .map(
      (part) =>
        stringValue(part.text) ??
        (part.type === "image" || part.type === "localImage"
          ? "[图片]"
          : part.type === "audio" || part.type === "localAudio"
            ? "[音频]"
            : part.type === "skill"
              ? `[Skill: ${stringValue(part.name) ?? "未知"}]`
              : undefined),
    )
    .filter((value): value is string => value !== undefined);
  if (contentText.length > 0) return contentText.join("\n\n");
  const summary = stringArray(data.summary);
  if (summary.length > 0) return summary.join("\n\n");
  const fragments = objectArray(data.fragments)
    .map((fragment) => stringValue(fragment.text))
    .filter((value): value is string => value !== undefined);
  return fragments.length > 0 ? fragments.join("\n\n") : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function objectArray(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Readonly<Record<string, unknown>> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}
