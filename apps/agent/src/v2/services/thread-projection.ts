import {
  GatewayV2Error,
  THREAD_TITLE_MAX_LENGTH,
  jsonValueSchema,
  type JsonValue,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import {
  isCodexObject,
  parseCodexObject,
  requireCodexObject,
  requireCodexString,
  type CodexObject,
} from "../codex/codex-json.js";
import type { ThreadLeaseState } from "./thread-lease-manager.js";
import type { WorkspaceView } from "./workspace-service.js";

type ThreadSummary = OutputOf<"thread/list">["threads"][number];
type TimelineItem = OutputOf<"thread/history">["items"][number];

export interface ThreadHistoryProjection {
  readonly items: TimelineItem[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export function projectThreadHistory(
  thread: CodexObject,
  cursor: string | undefined,
  limit: number,
): ThreadHistoryProjection {
  const items = projectThreadTimeline(thread);
  let end = items.length;
  if (cursor !== undefined) {
    const boundaryId = decodeHistoryCursor(cursor);
    const boundary = items.findIndex((item) => item.id === boundaryId);
    if (boundary < 0) {
      throw new GatewayV2Error(
        "HISTORY_CURSOR_STALE",
        "History cursor is no longer present in the authoritative task",
      );
    }
    end = boundary;
  }
  const start = Math.max(0, end - limit);
  const page = items.slice(start, end);
  return {
    items: page,
    ...(start === 0 || page.length === 0
      ? {}
      : { nextCursor: encodeHistoryCursor(page[0]!.id) }),
    hasMore: start > 0,
  };
}

export function projectThreadTimeline(thread: CodexObject): TimelineItem[] {
  if (!Array.isArray(thread.turns)) return [];
  const timeline: TimelineItem[] = [];
  for (const [turnIndex, value] of thread.turns.entries()) {
    if (!isCodexObject(value)) continue;
    const turnId =
      typeof value.id === "string" && value.id.length > 0
        ? value.id
        : `turn-${turnIndex}`;
    const createdAt = timestampFromSeconds(value.startedAt);
    if (Array.isArray(value.items)) {
      for (const [itemIndex, raw] of value.items.entries()) {
        if (!isCodexObject(raw)) continue;
        const id =
          typeof raw.id === "string" && raw.id.length > 0
            ? raw.id
            : `${turnId}:item:${itemIndex}`;
        timeline.push({
          version: 1,
          id,
          turnId,
          type: timelineType(raw.type),
          ...(createdAt === undefined ? {} : { createdAt }),
          data: raw,
        });
      }
    }
    if (value.error !== null && value.error !== undefined) {
      const error = jsonValueSchema.safeParse(value.error);
      timeline.push({
        version: 1,
        id: `${turnId}:error`,
        turnId,
        type: "error",
        ...(createdAt === undefined ? {} : { createdAt }),
        data:
          error.success && isCodexObject(error.data)
            ? error.data
            : { message: "Codex turn failed" },
      });
    }
  }
  return timeline;
}

export function projectThreadSummary(
  thread: CodexObject,
  workspace: WorkspaceView,
  archived: boolean,
): ThreadSummary {
  const name = typeof thread.name === "string" ? thread.name : undefined;
  const preview = typeof thread.preview === "string" ? thread.preview : "";
  return {
    version: 1,
    id: requireCodexString(thread.id, "thread id"),
    workspaceId: workspace.id,
    title: boundedThreadTitle(name ?? preview),
    state: threadState(thread.status),
    archived,
    createdAt: requireTimestamp(thread.createdAt, "thread createdAt"),
    updatedAt: requireTimestamp(thread.updatedAt, "thread updatedAt"),
  };
}

export function parseThreadListResponse(value: unknown): {
  readonly threads: CodexObject[];
  readonly nextCursor?: string;
} {
  const response = parseCodexObject(value, "thread/list response");
  if (!Array.isArray(response.data)) throw new Error("Thread list has no data");
  const threads = response.data.map((entry) =>
    requireCodexObject(entry, "thread"),
  );
  const nextCursor =
    typeof response.nextCursor === "string" && response.nextCursor.length > 0
      ? response.nextCursor
      : undefined;
  return { threads, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function timelineType(value: JsonValue | undefined): TimelineItem["type"] {
  if (
    value === "userMessage" ||
    value === "agentMessage" ||
    value === "reasoning" ||
    value === "hookPrompt"
  ) {
    return "message";
  }
  if (value === "plan") return "plan";
  if (value === "commandExecution") return "command";
  if (value === "fileChange") return "file-change";
  if (value === "mcpToolCall" || value === "dynamicToolCall") return "mcp";
  if (value === "collabAgentToolCall" || value === "subAgentActivity") {
    return "subagent";
  }
  return "generic";
}

function boundedThreadTitle(value: string): string {
  if (value.length <= THREAD_TITLE_MAX_LENGTH) return value;

  let end = THREAD_TITLE_MAX_LENGTH;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function threadState(value: JsonValue | undefined): ThreadLeaseState {
  const status = requireCodexObject(value, "thread status");
  if (status.type === "active") return "running";
  if (status.type === "systemError") return "failed";
  return "idle";
}

function requireTimestamp(value: JsonValue | undefined, field: string): string {
  const timestamp = timestampFromSeconds(value);
  if (timestamp === undefined) throw new Error(`Invalid ${field}`);
  return timestamp;
}

function timestampFromSeconds(
  value: JsonValue | undefined,
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}

function encodeHistoryCursor(itemId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, beforeItemId: itemId }),
  ).toString("base64url");
}

function decodeHistoryCursor(value: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).version === 1 &&
      typeof (parsed as Record<string, unknown>).beforeItemId === "string"
    ) {
      return (parsed as { beforeItemId: string }).beforeItemId;
    }
  } catch {
    // Converted into a stable public protocol error below.
  }
  throw new GatewayV2Error("INVALID_CURSOR", "History cursor is invalid");
}
