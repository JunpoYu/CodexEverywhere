import type {
  FileUpdateChange,
  ThreadItem,
  ThreadReadResponse,
  ThreadStatus,
  Turn,
  UserInput,
} from "@codex-everywhere/codex-app-server-schema/v2";
import type { EventEnvelope } from "@codex-everywhere/protocol";

import {
  renderMessageContent,
  renderUnifiedDiff,
  unifiedDiffStats,
} from "./code-renderer.js";

export type ThreadItemPresentation = {
  kind: string;
  title: string;
  status?: string;
  summary: string;
};

const MESSAGE_TIME_REFRESH_MS = 30_000;
const ABSOLUTE_MESSAGE_TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function relativeMessageTime(
  timestampMs: number,
  nowMs = Date.now(),
): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - timestampMs) / 1_000));
  if (elapsedSeconds < 60) return "刚刚";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${String(minutes)} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${String(days)} 天前`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${String(months)} 个月前`;
  return `${String(Math.floor(days / 365))} 年前`;
}

export function preferredMessageTimestamp(
  proposedTimestampMs: number | undefined,
  existingTimestampMs: number | undefined,
  preserveExisting: boolean,
  nowMs = Date.now(),
): number {
  return preserveExisting
    ? (existingTimestampMs ?? proposedTimestampMs ?? nowMs)
    : (proposedTimestampMs ?? existingTimestampMs ?? nowMs);
}

export type McpServerStartupNotice = {
  kind: "warning";
  title: string;
  summary: string;
};

export function mcpServerStartupNotice(
  payload: unknown,
): McpServerStartupNotice | undefined {
  if (!isRecord(payload) || payload.status !== "failed") return undefined;

  const name = typeof payload.name === "string" ? payload.name : "MCP";
  const isCodexApps = name === "codex_apps";
  const title = isCodexApps ? "ChatGPT Apps 未连接" : `MCP 服务未连接：${name}`;

  if (payload.failureReason === "reauthenticationRequired") {
    return {
      kind: "warning",
      title,
      summary: isCodexApps
        ? "会话记录已恢复，但 ChatGPT Apps 需要重新授权。完成授权并重新打开会话后，连接器工具即可继续使用。"
        : "会话记录已恢复，但这个 MCP 服务需要重新授权。完成授权并重新打开会话后再试。",
    };
  }

  const error = typeof payload.error === "string" ? payload.error : "";
  const networkFailure =
    /HTTP request failed|error sending request|connect|transport/i.test(error);
  return {
    kind: "warning",
    title,
    summary: isCodexApps
      ? networkFailure
        ? "会话记录已恢复，但宿主机暂时无法连接 ChatGPT Apps。连接器工具当前不可用；如果发送普通消息也失败，请在“设置 → Codex 网络”检查代理，然后重新打开会话。"
        : "会话记录已恢复，但 ChatGPT Apps 启动失败。连接器工具当前不可用；请重新打开会话，仍失败时检查 Codex 网络。"
      : networkFailure
        ? "会话记录已恢复，但宿主机暂时无法连接这个 MCP 服务。请检查服务地址和 Codex 网络，然后重新打开会话。"
        : "会话记录已恢复，但这个 MCP 服务启动失败。请检查 MCP 配置，然后重新打开会话。",
  };
}

export function threadSendMode(
  status: ThreadStatus | undefined,
): "start" | "queue" {
  return status?.type === "active" ? "queue" : "start";
}

export function queuedMessageText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return "";
  return payload.input
    .filter(isRecord)
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (part.type === "localImage" && typeof part.path === "string")
        return `📎 ${localImageNameFromPath(part.path)}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function threadSnapshotRevision(response: ThreadReadResponse): string {
  return JSON.stringify(response.thread.turns);
}

export const TRANSIENT_TIMELINE_SELECTOR =
  "[data-local-user], .timeline-entry.streaming";

export function localUserReconciledByTurns(
  localTurnId: string | undefined,
  turns: ReadonlyArray<{
    id: string;
    items?: ReadonlyArray<{
      type: string;
      clientId?: string | null;
    }>;
  }>,
  localClientId?: string,
): boolean {
  if (localTurnId && turns.some((turn) => turn.id === localTurnId)) return true;
  return Boolean(
    localClientId &&
    turns.some((turn) =>
      turn.items?.some(
        (item) =>
          item.type === "userMessage" && item.clientId === localClientId,
      ),
    ),
  );
}

export type StreamingTimelineKind = "agent" | "plan" | "tool";

export type StreamingTimelineIdentity = {
  turnId: string | undefined;
  itemId: string | undefined;
  kind: StreamingTimelineKind | undefined;
  rawText?: string | undefined;
};

export type BufferedStreamingDelta = {
  itemId: string;
  delta: string;
  kind: StreamingTimelineKind;
  turnId: string | undefined;
};

/** Coalesces adjacent transport deltas so Markdown is parsed at most once per paint. */
export class StreamingDeltaBuffer {
  readonly #pending = new Map<string, BufferedStreamingDelta>();

  append(update: BufferedStreamingDelta): void {
    const key = JSON.stringify([update.itemId, update.kind, update.turnId]);
    const pending = this.#pending.get(key);
    if (pending) {
      pending.delta += update.delta;
      return;
    }
    this.#pending.set(key, { ...update });
  }

  drain(): BufferedStreamingDelta[] {
    const updates = [...this.#pending.values()];
    this.#pending.clear();
    return updates;
  }

  clear(): void {
    this.#pending.clear();
  }
}

export function completedStreamingCandidateId(
  completedTurnId: string | undefined,
  completedKind: StreamingTimelineKind | undefined,
  candidates: ReadonlyArray<StreamingTimelineIdentity>,
  exactItemPresent = false,
  completedText?: string,
): string | undefined {
  if (exactItemPresent || !completedTurnId || !completedKind) return undefined;
  const matches = candidates.filter(
    (candidate) =>
      candidate.turnId === completedTurnId &&
      candidate.kind === completedKind &&
      candidate.itemId &&
      (completedText === undefined || candidate.rawText === completedText),
  );
  return matches.length === 1 ? matches[0]?.itemId : undefined;
}

export function streamingItemCandidateId(
  streamTurnId: string | undefined,
  streamItemId: string | undefined,
  streamKind: StreamingTimelineKind | undefined,
  streamText: string | undefined,
  turns: ReadonlyArray<Turn>,
): string | undefined {
  if (!streamTurnId || !streamItemId) return undefined;
  const turn = turns.find((candidate) => candidate.id === streamTurnId);
  if (!turn) return undefined;
  if (
    turn.items.some(
      (item: ThreadItem) =>
        isVisibleThreadItem(item) && item.id === streamItemId,
    )
  )
    return streamItemId;
  if (!streamKind || streamText === undefined) return undefined;
  const semanticMatches: VisibleThreadItem[] = [];
  for (const item of turn.items) {
    if (
      isVisibleThreadItem(item) &&
      itemTimelineKind(item) === streamKind &&
      itemTimelineReconciliationText(item) === streamText
    )
      semanticMatches.push(item);
  }
  return semanticMatches.length === 1 ? semanticMatches[0]?.id : undefined;
}

export function streamingCardReconciliation(
  streamTurnId: string | undefined,
  turns: ReadonlyArray<Turn>,
): "preserve" | "finalize" | "discard" {
  if (!streamTurnId) return "preserve";
  const authoritativeTurn = turns.find((turn) => turn.id === streamTurnId);
  if (!authoritativeTurn) return "finalize";
  return authoritativeTurn.status === "inProgress" ? "preserve" : "discard";
}

export type LooseTimelineIdentity = {
  itemId?: string | undefined;
  clientUserMessageId?: string | undefined;
};

export function looseItemReconciledByTurn(
  identity: LooseTimelineIdentity,
  turn: Pick<Turn, "id" | "items">,
): boolean {
  if (
    identity.itemId &&
    turn.items.some(
      (item: ThreadItem) =>
        isVisibleThreadItem(item) && item.id === identity.itemId,
    )
  )
    return true;
  if (
    identity.clientUserMessageId &&
    turn.items.some(
      (item: ThreadItem) =>
        item.type === "userMessage" &&
        item.clientId === identity.clientUserMessageId,
    )
  )
    return true;
  return false;
}

const FOLLOW_LATEST_THRESHOLD_PX = 64;

export type TimelineScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function shouldFollowTimeline(
  metrics: TimelineScrollMetrics,
  threshold = FOLLOW_LATEST_THRESHOLD_PX,
): boolean {
  return (
    metrics.scrollHeight <= metrics.clientHeight ||
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
  );
}

export type VisibleThreadItem = Exclude<ThreadItem, { type: "reasoning" }>;

export function isVisibleThreadItem(
  item: ThreadItem,
): item is VisibleThreadItem {
  return item.type !== "reasoning";
}

export function isReasoningEventType(type: string): boolean {
  return type.startsWith("codex/item/reasoning/");
}

const INTERNAL_TIMELINE_EVENT_TYPES = new Set([
  "codex/thread/archived",
  "codex/thread/deleted",
  "codex/thread/unarchived",
  "codex/thread/closed",
  "codex/thread/goal/updated",
  "codex/thread/goal/cleared",
  "codex/hook/started",
  "codex/hook/completed",
  "codex/turn/plan/updated",
  "codex/item/autoApprovalReview/started",
  "codex/item/autoApprovalReview/completed",
  "codex/rawResponseItem/completed",
  "codex/item/commandExecution/terminalInteraction",
  "codex/item/mcpToolCall/progress",
  "codex/thread/compacted",
  "codex/model/verification",
  "codex/turn/moderationMetadata",
  "codex/model/safetyBuffering/updated",
  "codex/thread/realtime/started",
  "codex/thread/realtime/itemAdded",
  "codex/thread/realtime/transcript/delta",
  "codex/thread/realtime/transcript/done",
  "codex/thread/realtime/outputAudio/delta",
  "codex/thread/realtime/sdp",
  "codex/thread/realtime/closed",
]);

export function isInternalTimelineEventType(type: string): boolean {
  return INTERNAL_TIMELINE_EVENT_TYPES.has(type);
}

export function describeThreadItem(
  item: VisibleThreadItem,
): ThreadItemPresentation {
  switch (item.type) {
    case "userMessage":
      return {
        kind: "user",
        title: "你",
        summary: item.content
          .map((part: UserInput) => {
            if (part.type === "text") return part.text;
            if (part.type === "skill") return `$${part.name}`;
            if (part.type === "mention") return `@${part.name}`;
            return part.type === "localImage"
              ? `📎 ${localImageNameFromPath(part.path)}`
              : part.url;
          })
          .join("\n"),
      };
    case "agentMessage":
      return { kind: "agent", title: "Codex", summary: item.text };
    case "plan":
      return { kind: "plan", title: "计划", summary: item.text };
    case "commandExecution":
      return {
        kind: "tool",
        title: "命令",
        status: item.status,
        summary: item.command,
      };
    case "fileChange":
      return {
        kind: "tool",
        title: "文件修改",
        status: item.status,
        summary: item.changes
          .map((change: FileUpdateChange) => change.path)
          .join("\n"),
      };
    case "mcpToolCall":
      return {
        kind: "tool",
        title: `${item.server} · ${item.tool}`,
        status: item.status,
        summary: safeJson(item.arguments),
      };
    case "dynamicToolCall":
      return {
        kind: "tool",
        title: [item.namespace, item.tool].filter(Boolean).join(" · "),
        status: item.status,
        summary: safeJson(item.arguments),
      };
    case "collabAgentToolCall":
      return {
        kind: "tool",
        title: `协作 Agent · ${item.tool}`,
        status: item.status,
        summary: item.prompt ?? item.receiverThreadIds.join(", "),
      };
    case "subAgentActivity":
      return {
        kind: "tool",
        title: `子 Agent · ${item.kind}`,
        summary: item.agentPath,
      };
    case "webSearch":
      return {
        kind: "tool",
        title: "网页搜索",
        summary: "query" in item ? String(item.query) : "",
      };
    case "imageView":
      return { kind: "tool", title: "查看图片", summary: item.path };
    case "imageGeneration":
      return { kind: "tool", title: "生成图片", summary: safeJson(item) };
    case "sleep":
      return {
        kind: "tool",
        title: "等待",
        summary: formatDuration(item.durationMs),
      };
    case "enteredReviewMode":
      return { kind: "event", title: "进入审查模式", summary: item.review };
    case "exitedReviewMode":
      return { kind: "event", title: "退出审查模式", summary: item.review };
    case "contextCompaction":
      return { kind: "event", title: "上下文已压缩", summary: "" };
    case "hookPrompt":
      return {
        kind: "event",
        title: "Hook",
        summary: safeJson(item.fragments),
      };
  }
  return {
    kind: "event",
    title: "Codex 活动",
    summary: safeJson(item),
  };
}

export function fileChangeKindLabel(change: FileUpdateChange): string {
  switch (change.kind.type) {
    case "add":
      return "新增";
    case "delete":
      return "删除";
    case "update":
      return change.kind.move_path ? "移动并修改" : "修改";
  }
  return "修改";
}

export function fileChangeItemFromPatchUpdate(
  payload: unknown,
): Extract<ThreadItem, { type: "fileChange" }> | undefined {
  if (
    !isRecord(payload) ||
    typeof payload.itemId !== "string" ||
    !Array.isArray(payload.changes) ||
    !payload.changes.every(isFileUpdateChange)
  )
    return undefined;
  return {
    type: "fileChange",
    id: payload.itemId,
    changes: payload.changes,
    status: "inProgress",
  };
}

export class FileChangeDisclosureState {
  readonly #open = new Set<string>();

  isOpen(itemId: string, path: string): boolean {
    return this.#open.has(fileChangeDisclosureKey(itemId, path));
  }

  setOpen(itemId: string, path: string, open: boolean): void {
    const key = fileChangeDisclosureKey(itemId, path);
    if (open) this.#open.add(key);
    else this.#open.delete(key);
  }

  clear(): void {
    this.#open.clear();
  }
}

function fileChangeDisclosureKey(itemId: string, path: string): string {
  return JSON.stringify([itemId, path]);
}

function localImageNameFromPath(path: string): string {
  const leaf = path.split(/[\\/]/u).at(-1) ?? "图片";
  return leaf.replace(/^[0-9a-f-]{36}-/iu, "") || "图片";
}

export class ThreadTimelineView {
  readonly #container: HTMLElement;
  readonly #onLoadOlder: (() => void) | undefined;
  readonly #onFollowLatestChanged: ((following: boolean) => void) | undefined;
  readonly #fileChangeDisclosures = new FileChangeDisclosureState();
  readonly #streamingDeltas = new StreamingDeltaBuffer();
  #snapshotRevision = "";
  #followingLatest = true;
  #hasOlderHistory = false;
  #loadingOlderHistory = false;
  #streamingDeltaFrame: number | undefined;

  constructor(
    container: HTMLElement,
    options: {
      onLoadOlder?(): void;
      onFollowLatestChanged?(following: boolean): void;
    } = {},
  ) {
    this.#container = container;
    this.#onLoadOlder = options.onLoadOlder;
    this.#onFollowLatestChanged = options.onFollowLatestChanged;
    container.addEventListener(
      "scroll",
      () => this.#setFollowingLatest(this.#isNearLatest()),
      { passive: true },
    );
    window.setInterval(
      () => this.#refreshMessageTimes(),
      MESSAGE_TIME_REFRESH_MS,
    );
  }

  clear(message = "选择一个会话查看内容"): void {
    this.#discardStreamingDeltas();
    this.#fileChangeDisclosures.clear();
    this.#hasOlderHistory = false;
    this.#loadingOlderHistory = false;
    this.#container.replaceChildren(emptyElement(message));
    this.#setFollowingLatest(true);
  }

  renderSnapshot(
    response: ThreadReadResponse,
    options: { hasOlderHistory?: boolean } = {},
  ): void {
    this.#flushStreamingDeltas();
    this.#hasOlderHistory = options.hasOlderHistory ?? false;
    this.#loadingOlderHistory = false;
    this.#replaceSnapshot(response);
    this.followLatest();
  }

  setOlderHistoryLoading(loading: boolean): void {
    this.#loadingOlderHistory = loading;
    this.#renderHistoryPager();
  }

  setHasOlderHistory(hasOlderHistory: boolean): void {
    this.#hasOlderHistory = hasOlderHistory;
    this.#renderHistoryPager();
  }

  prependTurns(turns: Turn[], hasOlderHistory: boolean): void {
    this.#flushStreamingDeltas();
    const previousHeight = this.#container.scrollHeight;
    const anchor = this.#container.querySelector(
      ".turn-block, .timeline-entry:not(.history-pagination)",
    );
    const fragment = document.createDocumentFragment();
    for (const turn of turns) {
      if (
        this.#container.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`)
      )
        continue;
      const section = this.#turnElement(turn);
      if (section) fragment.append(section);
    }
    this.#container.insertBefore(fragment, anchor);
    this.#hasOlderHistory = hasOlderHistory;
    this.#loadingOlderHistory = false;
    this.#renderHistoryPager();
    this.#container.scrollTop += this.#container.scrollHeight - previousHeight;
    this.#setFollowingLatest(false);
  }

  mergeRecentTurns(turns: Turn[]): void {
    this.#flushStreamingDeltas();
    const followLatest = this.#isNearLatest();
    const existingTimestamps = this.#itemTimestamps();
    const transientCards = Array.from(
      this.#container.querySelectorAll<HTMLElement>(
        TRANSIENT_TIMELINE_SELECTOR,
      ),
    );
    const detachedTransientCards: HTMLElement[] = [];
    for (const card of transientCards) {
      if (
        card.classList.contains("streaming") &&
        streamingCardReconciliation(card.dataset.streamTurnId, turns) ===
          "finalize"
      ) {
        this.#finalizeStreamingCard(card);
        continue;
      }
      card.remove();
      detachedTransientCards.push(card);
    }
    for (const turn of turns) {
      const replacement = this.#turnElement(turn, existingTimestamps);
      const existing = this.#container.querySelector<HTMLElement>(
        `[data-turn-id="${CSS.escape(turn.id)}"]`,
      );
      this.#removeLooseTurnItems(turn);
      if (existing) {
        if (replacement) existing.replaceWith(replacement);
        else existing.remove();
      } else if (replacement) {
        this.#container.append(replacement);
      }
    }
    for (const card of detachedTransientCards) {
      if (
        localUserReconciledByTurns(
          card.dataset.localTurnId,
          turns,
          card.dataset.localOperationId,
        )
      )
        continue;
      const reconciliation = streamingCardReconciliation(
        card.dataset.streamTurnId,
        turns,
      );
      if (reconciliation === "discard") continue;
      const candidateId = streamingItemCandidateId(
        card.dataset.streamTurnId,
        card.dataset.itemId,
        streamingKind(card.dataset.streamKind),
        card.dataset.rawText,
        turns,
      );
      const snapshotCard = candidateId
        ? this.#findItem(candidateId)
        : undefined;
      if (snapshotCard && candidateId === card.dataset.itemId)
        snapshotCard.replaceWith(card);
      else if (snapshotCard) continue;
      else this.#container.append(card);
    }
    this.#renderHistoryPager();
    this.#finishContentUpdate(followLatest);
  }

  reconcileSnapshot(
    response: ThreadReadResponse,
    options: { maxTurns?: number } = {},
  ): boolean {
    this.#flushStreamingDeltas();
    const boundedResponse = boundedThreadSnapshot(response, options.maxTurns);
    const revision = threadSnapshotRevision(boundedResponse);
    if (revision === this.#snapshotRevision) return false;
    const followLatest = this.#isNearLatest();
    const previousScrollTop = this.#container.scrollTop;
    const existingTimestamps = this.#itemTimestamps();
    const transientCards = Array.from(
      this.#container.querySelectorAll<HTMLElement>(
        TRANSIENT_TIMELINE_SELECTOR,
      ),
    );
    const finalizedCards = transientCards.filter(
      (card) =>
        card.classList.contains("streaming") &&
        streamingCardReconciliation(
          card.dataset.streamTurnId,
          boundedResponse.thread.turns,
        ) === "finalize",
    );
    for (const card of finalizedCards) this.#finalizeStreamingCard(card);
    const finalizedCardSet = new Set(finalizedCards);
    this.#replaceSnapshot(boundedResponse, existingTimestamps);
    if (finalizedCards.length > 0) {
      const fragment = document.createDocumentFragment();
      for (const card of finalizedCards) fragment.append(card);
      const anchor = this.#container.querySelector(
        ".turn-block, .timeline-entry:not(.history-pagination)",
      );
      this.#container.insertBefore(fragment, anchor);
    }
    for (const card of transientCards) {
      if (finalizedCardSet.has(card)) continue;
      if (
        localUserReconciledByTurns(
          card.dataset.localTurnId,
          boundedResponse.thread.turns,
          card.dataset.localOperationId,
        )
      )
        continue;
      const reconciliation = streamingCardReconciliation(
        card.dataset.streamTurnId,
        boundedResponse.thread.turns,
      );
      if (reconciliation === "discard") continue;
      const candidateId = streamingItemCandidateId(
        card.dataset.streamTurnId,
        card.dataset.itemId,
        streamingKind(card.dataset.streamKind),
        card.dataset.rawText,
        boundedResponse.thread.turns,
      );
      const snapshotCard = candidateId
        ? this.#findItem(candidateId)
        : undefined;
      if (snapshotCard && candidateId === card.dataset.itemId)
        snapshotCard.replaceWith(card);
      else if (snapshotCard) continue;
      else this.#container.append(card);
    }
    if (followLatest) this.followLatest();
    else {
      this.#container.scrollTop = previousScrollTop;
      this.#setFollowingLatest(false);
    }
    return true;
  }

  appendLocalUser(
    input: UserInput[],
    clientUserMessageId: string = crypto.randomUUID(),
  ): void {
    this.#flushStreamingDeltas();
    if (
      this.#container.querySelector(
        `[data-local-operation-id="${CSS.escape(clientUserMessageId)}"]`,
      )
    )
      return;
    const id = `local-${clientUserMessageId}`;
    this.#upsertItem(
      {
        type: "userMessage",
        id,
        clientId: clientUserMessageId,
        content: input,
      },
      undefined,
      Date.now(),
    );
    const card = this.#findItem(id);
    if (card) {
      card.dataset.localUser = "true";
      card.dataset.localOperationId = clientUserMessageId;
    }
    this.followLatest();
  }

  bindLocalUserToTurn(turnId: string, clientUserMessageId?: string): void {
    const card = this.#localUserCard(clientUserMessageId);
    if (!card) return;
    const authoritativeTurn = this.#container.querySelector<HTMLElement>(
      `[data-turn-id="${CSS.escape(turnId)}"]`,
    );
    if (authoritativeTurn?.querySelector(".timeline-entry.user")) {
      card.remove();
      return;
    }
    card.dataset.localTurnId = turnId;
    card.classList.remove("outcome-unknown");
    card.querySelector(".message-delivery-state")?.remove();
  }

  markLocalUserOutcomeUnknown(clientUserMessageId: string): void {
    const card = this.#localUserCard(clientUserMessageId);
    if (!card) return;
    card.classList.add("outcome-unknown");
    let state = card.querySelector<HTMLElement>(".message-delivery-state");
    if (!state) {
      state = document.createElement("div");
      state.className = "message-delivery-state";
      state.setAttribute("role", "status");
      state.setAttribute("aria-live", "polite");
      card.append(state);
    }
    state.textContent = "连接中断，发送结果待确认；系统不会自动重复发送。";
  }

  removeLocalUser(clientUserMessageId?: string): void {
    const followLatest = this.#isNearLatest();
    this.#localUserCard(clientUserMessageId)?.remove();
    this.#finishContentUpdate(followLatest);
  }

  #localUserCard(clientUserMessageId?: string): HTMLElement | null {
    return this.#container.querySelector<HTMLElement>(
      clientUserMessageId
        ? `[data-local-operation-id="${CSS.escape(clientUserMessageId)}"]`
        : "[data-local-user]",
    );
  }

  appendNotice(title: string, content: string, kind = "event"): void {
    this.#flushStreamingDeltas();
    const followLatest = this.#isNearLatest();
    this.#appendNoticeElement(title, content, kind);
    this.#finishContentUpdate(followLatest);
  }

  #appendNoticeElement(
    title: string,
    content: string,
    kind: string,
    timestampMs = Date.now(),
  ): void {
    this.#container.querySelector(".empty")?.remove();
    const card = document.createElement("article");
    card.className = `timeline-entry ${kind}`;
    const heading = document.createElement("header");
    heading.textContent = title;
    heading.append(messageTimeElement(timestampMs));
    const body = document.createElement("div");
    body.className = "message-text";
    body.textContent = content;
    card.append(heading, body);
    this.#container.append(card);
  }

  handleEvent(event: EventEnvelope): boolean {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.type === "codex/mcpServer/startupStatus/updated") {
      const notice = mcpServerStartupNotice(payload);
      if (notice) this.appendNotice(notice.title, notice.summary, notice.kind);
      return true;
    }
    if (event.type === "codex/turn/started") return true;
    if (isReasoningEventType(event.type)) return true;
    if (isInternalTimelineEventType(event.type)) return true;
    if (
      event.type === "codex/item/started" ||
      event.type === "codex/item/completed"
    ) {
      if (isThreadItem(payload.item)) {
        this.#flushStreamingDeltas();
        const followLatest = this.#isNearLatest();
        this.#upsertItem(
          payload.item,
          typeof payload.turnId === "string" ? payload.turnId : undefined,
          lifecycleItemTimestamp(event.type, payload, payload.item),
          false,
          event.type === "codex/item/completed",
        );
        this.#finishContentUpdate(followLatest);
        return true;
      }
    }

    const patchUpdate = fileChangeItemFromPatchUpdate(payload);
    if (event.type === "codex/item/fileChange/patchUpdated" && patchUpdate) {
      this.#flushStreamingDeltas();
      const followLatest = this.#isNearLatest();
      this.#upsertItem(patchUpdate);
      this.#finishContentUpdate(followLatest);
      return true;
    }

    if (event.type === "codex/turn/diff/updated") {
      // This aggregate changes repeatedly and is not a timeline item. The
      // authoritative, per-file UI is driven by fileChange item lifecycle and
      // patchUpdated notifications.
      return true;
    }

    if (event.type === "codex/turn/completed" && isTurn(payload.turn)) {
      this.#flushStreamingDeltas();
      const followLatest = this.#isNearLatest();
      for (const item of payload.turn.items) {
        this.#upsertItem(
          item,
          payload.turn.id,
          turnItemTimestamp(payload.turn, item),
          true,
          true,
        );
      }
      this.#removeStreamingTurnCards(payload.turn.id);
      if (payload.turn.error) {
        this.#appendNoticeElement(
          "Codex 错误",
          messageFromPayload(
            payload.turn.error as unknown as Record<string, unknown>,
          ),
          "error",
          turnTimestamp(payload.turn, "completed") ?? Date.now(),
        );
      }
      this.#finishContentUpdate(followLatest);
      return true;
    }

    const deltaKinds: Record<string, "agent" | "plan" | "tool"> = {
      "codex/item/agentMessage/delta": "agent",
      "codex/item/plan/delta": "plan",
      "codex/item/commandExecution/outputDelta": "tool",
      "codex/item/fileChange/outputDelta": "tool",
    };
    const deltaKind = deltaKinds[event.type];
    if (
      deltaKind &&
      typeof payload.itemId === "string" &&
      typeof payload.delta === "string"
    ) {
      this.#queueStreamingDelta({
        itemId: payload.itemId,
        delta: payload.delta,
        kind: deltaKind,
        turnId: typeof payload.turnId === "string" ? payload.turnId : undefined,
      });
      return true;
    }

    if (
      event.type === "codex/error" ||
      event.type === "codex/warning" ||
      event.type === "codex/guardianWarning"
    ) {
      const isError = event.type === "codex/error";
      this.appendNotice(
        isError ? "Codex 错误" : "Codex 警告",
        messageFromPayload(payload),
        isError ? "error" : "event",
      );
      return true;
    }
    return false;
  }

  followLatest(): void {
    this.#container.scrollTop = this.#container.scrollHeight;
    this.#setFollowingLatest(true);
  }

  #replaceSnapshot(
    response: ThreadReadResponse,
    existingTimestamps?: ReadonlyMap<string, number>,
  ): void {
    this.#snapshotRevision = threadSnapshotRevision(response);
    this.#container.replaceChildren();
    for (const turn of response.thread.turns) {
      const section = this.#turnElement(turn, existingTimestamps);
      if (section) this.#container.append(section);
    }
    if (this.#container.childElementCount === 0) {
      this.#container.append(emptyElement("这个会话还没有消息"));
    }
    this.#renderHistoryPager();
  }

  #renderHistoryPager(): void {
    this.#container.querySelector(".history-pagination")?.remove();
    if (!this.#hasOlderHistory) return;
    const wrapper = document.createElement("div");
    wrapper.className = "history-pagination";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary compact-action";
    button.disabled = this.#loadingOlderHistory;
    button.textContent = this.#loadingOlderHistory
      ? "正在加载更早消息…"
      : "加载更早消息";
    button.addEventListener("click", () => {
      if (this.#loadingOlderHistory) return;
      this.#loadingOlderHistory = true;
      this.#renderHistoryPager();
      this.#onLoadOlder?.();
    });
    wrapper.append(button);
    this.#container.prepend(wrapper);
  }

  #isNearLatest(): boolean {
    return shouldFollowTimeline(this.#container);
  }

  #finishContentUpdate(followLatest: boolean): void {
    if (followLatest) this.followLatest();
    else this.#setFollowingLatest(false);
  }

  #setFollowingLatest(following: boolean): void {
    if (following === this.#followingLatest) return;
    this.#followingLatest = following;
    this.#onFollowLatestChanged?.(following);
  }

  #turnElement(
    turn: Turn,
    existingTimestamps?: ReadonlyMap<string, number>,
  ): HTMLElement | undefined {
    const section = document.createElement("section");
    section.className = "turn-block";
    section.dataset.turnId = turn.id;
    for (const item of turn.items) {
      if (isVisibleThreadItem(item)) {
        section.append(
          this.#itemElement(
            item,
            preferredMessageTimestamp(
              turnItemTimestamp(turn, item),
              existingTimestamps?.get(item.id),
              true,
            ),
          ),
        );
      }
    }
    if (turn.error) {
      const error = document.createElement("article");
      error.className = "timeline-entry error";
      const heading = document.createElement("header");
      heading.textContent = "Codex 错误";
      heading.append(
        messageTimeElement(
          turnTimestamp(turn, "completed") ?? turnItemTimestamp(turn),
        ),
      );
      const body = document.createElement("div");
      body.className = "message-text";
      body.textContent = messageFromPayload(
        turn.error as unknown as Record<string, unknown>,
      );
      error.append(heading, body);
      section.append(error);
    }
    return section.childElementCount > 0 ? section : undefined;
  }

  #upsertItem(
    item: ThreadItem,
    lifecycleTurnId?: string,
    timestampMs?: number,
    preserveExistingTimestamp = false,
    reconcileCompletedStream = false,
  ): void {
    if (!isVisibleThreadItem(item)) return;
    this.#container.querySelector(".empty")?.remove();
    if (item.type === "userMessage" && !item.id.startsWith("local-")) {
      const local = item.clientId
        ? this.#localUserCard(item.clientId)
        : this.#localUserCard();
      local?.remove();
    }
    const [existing, ...duplicates] = this.#findItems(item.id);
    const completedStreamId = reconcileCompletedStream
      ? completedStreamingCandidateId(
          lifecycleTurnId,
          itemTimelineKind(item),
          this.#streamingIdentities(),
          Boolean(existing),
          itemTimelineReconciliationText(item),
        )
      : undefined;
    const completedStream = completedStreamId
      ? this.#findItem(completedStreamId)
      : undefined;
    const existingTimestampMs =
      cardTimestamp(existing) ?? cardTimestamp(completedStream);
    const replacement = this.#itemElement(
      item,
      preferredMessageTimestamp(
        timestampMs,
        existingTimestampMs,
        preserveExistingTimestamp,
      ),
    );
    if (lifecycleTurnId) replacement.dataset.lifecycleTurnId = lifecycleTurnId;
    if (existing) existing.replaceWith(replacement);
    else if (completedStream) completedStream.replaceWith(replacement);
    else this.#container.append(replacement);
    if (existing && completedStream && completedStream !== existing)
      completedStream.remove();
    for (const duplicate of duplicates) duplicate.remove();
  }

  #appendDelta(
    itemId: string,
    delta: string,
    kind: StreamingTimelineKind,
    turnId: string | undefined,
  ): void {
    this.#container.querySelector(".empty")?.remove();
    let card = this.#findItem(itemId);
    if (!card) {
      card = document.createElement("article");
      card.className = `timeline-entry ${kind} streaming`;
      card.dataset.itemId = itemId;
      const heading = document.createElement("header");
      heading.textContent =
        kind === "agent" ? "Codex" : kind === "plan" ? "计划" : "执行输出";
      heading.append(messageTimeElement(Date.now()));
      const body = document.createElement("div");
      body.className = "message-text stream-target";
      card.append(heading, body);
      this.#container.append(card);
    }
    card.classList.add("streaming");
    card.dataset.streamKind = kind;
    if (turnId) card.dataset.streamTurnId = turnId;
    let target = card.querySelector<HTMLElement>(
      ".stream-target, .message-text, pre",
    );
    if (!target && kind === "tool") {
      target = document.createElement("pre");
      target.className = "stream-target command-output";
      card.append(target);
    }
    if (!target) return;
    const next = `${card.dataset.rawText ?? target.textContent ?? ""}${delta}`;
    card.dataset.rawText = next;
    if (kind === "agent" || kind === "plan") {
      renderMessageContent(target, next);
    } else {
      target.textContent = next;
    }
  }

  #queueStreamingDelta(update: BufferedStreamingDelta): void {
    this.#streamingDeltas.append(update);
    if (this.#streamingDeltaFrame !== undefined) return;
    this.#streamingDeltaFrame = window.requestAnimationFrame(() => {
      this.#streamingDeltaFrame = undefined;
      this.#flushStreamingDeltas();
    });
  }

  #flushStreamingDeltas(): void {
    if (this.#streamingDeltaFrame !== undefined) {
      window.cancelAnimationFrame(this.#streamingDeltaFrame);
      this.#streamingDeltaFrame = undefined;
    }
    const updates = this.#streamingDeltas.drain();
    if (updates.length === 0) return;
    const followLatest = this.#isNearLatest();
    for (const update of updates) {
      this.#appendDelta(
        update.itemId,
        update.delta,
        update.kind,
        update.turnId,
      );
    }
    this.#finishContentUpdate(followLatest);
  }

  #discardStreamingDeltas(): void {
    if (this.#streamingDeltaFrame !== undefined) {
      window.cancelAnimationFrame(this.#streamingDeltaFrame);
      this.#streamingDeltaFrame = undefined;
    }
    this.#streamingDeltas.clear();
  }

  #findItem(itemId: string): HTMLElement | undefined {
    return this.#findItems(itemId)[0];
  }

  #findItems(itemId: string): HTMLElement[] {
    return Array.from(
      this.#container.querySelectorAll<HTMLElement>(
        `[data-item-id="${CSS.escape(itemId)}"]`,
      ),
    );
  }

  #streamingIdentities(): StreamingTimelineIdentity[] {
    return Array.from(
      this.#container.querySelectorAll<HTMLElement>(
        ".timeline-entry.streaming",
      ),
    ).map((candidate) => ({
      turnId: candidate.dataset.streamTurnId,
      itemId: candidate.dataset.itemId,
      kind: streamingKind(candidate.dataset.streamKind),
      rawText: candidate.dataset.rawText,
    }));
  }

  #removeStreamingTurnCards(turnId: string): void {
    for (const card of this.#container.querySelectorAll<HTMLElement>(
      `.timeline-entry.streaming[data-stream-turn-id="${CSS.escape(turnId)}"]`,
    ))
      card.remove();
  }

  #finalizeStreamingCard(card: HTMLElement): void {
    card.classList.remove("streaming");
    delete card.dataset.streamKind;
    delete card.dataset.streamTurnId;
  }

  #itemTimestamps(): Map<string, number> {
    const timestamps = new Map<string, number>();
    for (const card of this.#container.querySelectorAll<HTMLElement>(
      "[data-item-id]",
    )) {
      const itemId = card.dataset.itemId;
      const timestampMs = cardTimestamp(card);
      if (itemId && timestampMs !== undefined) {
        timestamps.set(itemId, timestampMs);
      }
    }
    return timestamps;
  }

  #removeLooseTurnItems(turn: Turn): void {
    for (const card of this.#container.querySelectorAll<HTMLElement>(
      "[data-item-id]",
    )) {
      if (
        looseItemReconciledByTurn(
          {
            itemId: card.dataset.itemId,
            clientUserMessageId: card.dataset.clientUserMessageId,
          },
          turn,
        )
      )
        card.remove();
    }
  }

  #itemElement(item: VisibleThreadItem, timestampMs: number): HTMLElement {
    const presentation = describeThreadItem(item);
    const card = document.createElement("article");
    card.className = `timeline-entry ${presentation.kind}`;
    card.dataset.itemId = item.id;
    if (item.type === "userMessage" && item.clientId)
      card.dataset.clientUserMessageId = item.clientId;

    const heading = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = presentation.title;
    heading.append(title);
    if (presentation.status) {
      const status = document.createElement("span");
      status.className = `item-status ${statusTone(presentation.status)}`;
      status.textContent = statusLabel(presentation.status);
      heading.append(status);
    }
    heading.append(messageTimeElement(timestampMs));
    card.append(heading);

    if (item.type === "commandExecution") {
      const command = document.createElement("code");
      command.className = "command-line";
      command.textContent = item.command;
      card.append(command);
      if (item.aggregatedOutput) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `查看输出${item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ""}`;
        details.append(summary);
        details.addEventListener("toggle", () => {
          if (!details.open || details.querySelector("pre")) return;
          const output = document.createElement("pre");
          output.textContent = item.aggregatedOutput;
          details.append(output);
        });
        card.append(details);
      }
      return card;
    }

    if (item.type === "fileChange") {
      card.classList.add("file-change-card");
      if (item.changes.length === 0) {
        const pending = document.createElement("div");
        pending.className = "file-change-pending";
        pending.textContent = "正在准备文件差异…";
        card.append(pending);
      }
      for (const change of item.changes) {
        const details = document.createElement("details");
        details.className = "file-change-details";
        details.open = this.#fileChangeDisclosures.isOpen(item.id, change.path);
        details.addEventListener("toggle", () => {
          this.#fileChangeDisclosures.setOpen(
            item.id,
            change.path,
            details.open,
          );
          if (!details.open || details.querySelector("[data-lazy-diff]"))
            return;
          const content = document.createElement("div");
          content.dataset.lazyDiff = "true";
          content.append(renderUnifiedDiff(change.diff));
          details.append(content);
        });
        const summary = document.createElement("summary");
        const kind = document.createElement("span");
        kind.className = `file-change-kind file-change-${change.kind.type}`;
        kind.textContent = fileChangeKindLabel(change);
        const path = document.createElement("code");
        path.className = "file-change-path";
        path.textContent = change.path;
        const stats = unifiedDiffStats(change.diff);
        const size = document.createElement("span");
        size.className = "file-change-stats";
        const additions = document.createElement("span");
        additions.className = "diff-stat-addition";
        additions.textContent = `+${String(stats.additions)}`;
        const deletions = document.createElement("span");
        deletions.className = "diff-stat-deletion";
        deletions.textContent = `−${String(stats.deletions)}`;
        size.append(additions, deletions);
        summary.append(kind, path, size);
        details.append(summary);
        if (change.kind.type === "update" && change.kind.move_path) {
          const moved = document.createElement("div");
          moved.className = "file-change-move";
          moved.textContent = `移动到 ${change.kind.move_path}`;
          details.append(moved);
        }
        if (details.open) {
          const content = document.createElement("div");
          content.dataset.lazyDiff = "true";
          content.append(renderUnifiedDiff(change.diff));
          details.append(content);
        }
        card.append(details);
      }
      return card;
    }

    const body = document.createElement("div");
    body.className = "message-text stream-target";
    if (item.type === "agentMessage" || item.type === "plan") {
      card.dataset.rawText = presentation.summary;
      renderMessageContent(body, presentation.summary);
    } else {
      body.textContent = presentation.summary;
    }
    card.append(body);
    return card;
  }

  #refreshMessageTimes(): void {
    for (const time of this.#container.querySelectorAll<HTMLTimeElement>(
      "time.message-time[data-timestamp-ms]",
    )) {
      updateMessageTimeElement(time);
    }
  }
}

export function boundedThreadSnapshot(
  response: ThreadReadResponse,
  maxTurns?: number,
): ThreadReadResponse {
  if (maxTurns === undefined || response.thread.turns.length <= maxTurns)
    return response;
  return {
    ...response,
    thread: {
      ...response.thread,
      turns: response.thread.turns.slice(-maxTurns),
    },
  };
}

function turnItemTimestamp(turn: Turn, item?: ThreadItem): number {
  const phase = item?.type === "userMessage" ? "started" : "completed";
  return turnTimestamp(turn, phase) ?? Date.now();
}

function turnTimestamp(
  turn: Turn,
  phase: "started" | "completed",
): number | undefined {
  const timestamp =
    phase === "completed"
      ? (turn.completedAt ?? turn.startedAt)
      : turn.startedAt;
  return unixTimestampMs(timestamp) ?? uuidV7TimestampMs(turn.id);
}

function lifecycleItemTimestamp(
  eventType: string,
  payload: Record<string, unknown>,
  item: ThreadItem,
): number | undefined {
  if (eventType === "codex/item/started") {
    return unixTimestampMs(payload.startedAtMs);
  }
  // A completed user item replaces its optimistic/started card, so retaining
  // that card's timestamp better represents when the user sent the message.
  if (item.type === "userMessage") return undefined;
  return unixTimestampMs(payload.completedAtMs);
}

function unixTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function uuidV7TimestampMs(value: string): number | undefined {
  const match =
    /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.exec(
      value,
    );
  if (!match) return undefined;
  const timestamp = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

function messageTimeElement(timestampMs: number): HTMLTimeElement {
  const time = document.createElement("time");
  time.className = "message-time";
  time.dataset.timestampMs = String(timestampMs);
  updateMessageTimeElement(time);
  return time;
}

function updateMessageTimeElement(time: HTMLTimeElement): void {
  const timestampMs = Number(time.dataset.timestampMs);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return;
  const date = new Date(timestampMs);
  const relative = relativeMessageTime(timestampMs);
  const absolute = ABSOLUTE_MESSAGE_TIME_FORMAT.format(date);
  time.dateTime = date.toISOString();
  time.textContent = relative;
  time.title = absolute;
  time.setAttribute("aria-label", `${relative}，${absolute}`);
}

function cardTimestamp(card: HTMLElement | undefined): number | undefined {
  const raw = card?.querySelector<HTMLTimeElement>(
    "time.message-time[data-timestamp-ms]",
  )?.dataset.timestampMs;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function itemTimelineKind(
  item: VisibleThreadItem,
): StreamingTimelineKind | undefined {
  if (item.type === "agentMessage") return "agent";
  if (item.type === "plan") return "plan";
  if (item.type === "commandExecution" || item.type === "fileChange")
    return "tool";
  return undefined;
}

function itemTimelineReconciliationText(
  item: VisibleThreadItem,
): string | undefined {
  return item.type === "agentMessage" || item.type === "plan"
    ? item.text
    : undefined;
}

function streamingKind(
  value: string | undefined,
): StreamingTimelineKind | undefined {
  return value === "agent" || value === "plan" || value === "tool"
    ? value
    : undefined;
}

function statusTone(status: string): string {
  if (/complete|success|applied/i.test(status)) return "success";
  if (/fail|error|declin/i.test(status)) return "failure";
  return "running";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    inProgress: "运行中",
    completed: "完成",
    failed: "失败",
    declined: "已拒绝",
  };
  return labels[status] ?? status;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function messageFromPayload(payload: Record<string, unknown>): string {
  for (const key of ["message", "error", "reason"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  return safeJson(payload);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isThreadItem(value: unknown): value is ThreadItem {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.id === "string"
  );
}

function isFileUpdateChange(value: unknown): value is FileUpdateChange {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.diff !== "string" ||
    !isRecord(value.kind)
  )
    return false;
  if (value.kind.type === "add" || value.kind.type === "delete") return true;
  return (
    value.kind.type === "update" &&
    (value.kind.move_path === null || typeof value.kind.move_path === "string")
  );
}

function isTurn(value: unknown): value is Turn {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.items)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function emptyElement(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = text;
  return element;
}
