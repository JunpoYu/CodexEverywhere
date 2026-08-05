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
  "[data-queue-id], [data-request-id], .timeline-entry.streaming";

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

function localImageNameFromPath(path: string): string {
  const leaf = path.split(/[\\/]/u).at(-1) ?? "图片";
  return leaf.replace(/^[0-9a-f-]{36}-/iu, "") || "图片";
}

export class ThreadTimelineView {
  readonly #container: HTMLElement;
  readonly #onSteerQueued: ((queueId: string) => void) | undefined;
  readonly #onFollowLatestChanged: ((following: boolean) => void) | undefined;
  #snapshotRevision = "";
  #queuedSteerAvailable = false;
  #followingLatest = true;

  constructor(
    container: HTMLElement,
    options: {
      onSteerQueued?(queueId: string): void;
      onFollowLatestChanged?(following: boolean): void;
    } = {},
  ) {
    this.#container = container;
    this.#onSteerQueued = options.onSteerQueued;
    this.#onFollowLatestChanged = options.onFollowLatestChanged;
    container.addEventListener(
      "scroll",
      () => this.#setFollowingLatest(this.#isNearLatest()),
      { passive: true },
    );
  }

  clear(message = "选择一个会话查看内容"): void {
    this.#container.replaceChildren(emptyElement(message));
    this.#setFollowingLatest(true);
  }

  renderSnapshot(response: ThreadReadResponse): void {
    this.#replaceSnapshot(response);
    this.followLatest();
  }

  reconcileSnapshot(response: ThreadReadResponse): boolean {
    const revision = threadSnapshotRevision(response);
    if (revision === this.#snapshotRevision) return false;
    const followLatest = this.#isNearLatest();
    const previousScrollTop = this.#container.scrollTop;
    const transientCards = Array.from(
      this.#container.querySelectorAll<HTMLElement>(
        TRANSIENT_TIMELINE_SELECTOR,
      ),
    );
    this.#replaceSnapshot(response);
    for (const card of transientCards) {
      const itemId = card.dataset.itemId;
      const snapshotCard = itemId ? this.#findItem(itemId) : undefined;
      if (snapshotCard) snapshotCard.replaceWith(card);
      else this.#container.append(card);
    }
    if (followLatest) this.followLatest();
    else {
      this.#container.scrollTop = previousScrollTop;
      this.#setFollowingLatest(false);
    }
    return true;
  }

  appendLocalUser(input: UserInput[]): void {
    const id = `local-${crypto.randomUUID()}`;
    this.#upsertItem({
      type: "userMessage",
      id,
      clientId: id,
      content: input,
    });
    const card = this.#findItem(id);
    if (card) card.dataset.localUser = "true";
    this.followLatest();
  }

  removeLocalUser(): void {
    const followLatest = this.#isNearLatest();
    this.#container.querySelector<HTMLElement>("[data-local-user]")?.remove();
    this.#finishContentUpdate(followLatest);
  }

  upsertQueuedUser(
    queueId: string,
    text: string,
    status: "pending" | "paused" = "pending",
  ): void {
    const followLatest = this.#isNearLatest();
    this.#container.querySelector(".empty")?.remove();
    let card = this.#container.querySelector<HTMLElement>(
      `[data-queue-id="${CSS.escape(queueId)}"]`,
    );
    if (!card) {
      card = document.createElement("article");
      card.className = "timeline-entry user queued-message";
      card.dataset.queueId = queueId;
      const heading = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = "你";
      const badge = document.createElement("span");
      badge.className = "item-status queued-status";
      heading.append(title, badge);
      const body = document.createElement("div");
      body.className = "message-text";
      body.textContent = text;
      const actions = document.createElement("footer");
      actions.className = "queued-actions";
      const steer = document.createElement("button");
      steer.type = "button";
      steer.className = "ghost compact-action queued-steer";
      steer.textContent = "转为 Steer";
      steer.title = "立即补充到当前正在运行的任务";
      steer.hidden = !this.#queuedSteerAvailable;
      steer.addEventListener("click", () => this.#onSteerQueued?.(queueId));
      actions.append(steer);
      card.append(heading, body, actions);
      this.#container.append(card);
    }
    const badge = card.querySelector<HTMLElement>(".queued-status");
    if (badge) {
      badge.className = `item-status queued-status ${status === "paused" ? "failure" : "running"}`;
      badge.textContent = status === "paused" ? "队列已暂停" : "已排队";
    }
    this.#finishContentUpdate(followLatest);
  }

  setQueuedSteerAvailable(available: boolean): void {
    const followLatest = this.#isNearLatest();
    this.#queuedSteerAvailable = available;
    for (const button of this.#container.querySelectorAll<HTMLButtonElement>(
      ".queued-steer",
    )) {
      button.hidden = !available;
    }
    this.#finishContentUpdate(followLatest);
  }

  removeQueuedUser(queueId: string): void {
    const followLatest = this.#isNearLatest();
    this.#container
      .querySelector<HTMLElement>(`[data-queue-id="${CSS.escape(queueId)}"]`)
      ?.remove();
    this.#finishContentUpdate(followLatest);
  }

  appendNotice(title: string, content: string, kind = "event"): void {
    const followLatest = this.#isNearLatest();
    this.#appendNoticeElement(title, content, kind);
    this.#finishContentUpdate(followLatest);
  }

  #appendNoticeElement(title: string, content: string, kind: string): void {
    this.#container.querySelector(".empty")?.remove();
    const card = document.createElement("article");
    card.className = `timeline-entry ${kind}`;
    const heading = document.createElement("header");
    heading.textContent = title;
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
    if (
      event.type === "codex/item/started" ||
      event.type === "codex/item/completed"
    ) {
      if (isThreadItem(payload.item)) {
        const followLatest = this.#isNearLatest();
        this.#upsertItem(payload.item);
        this.#finishContentUpdate(followLatest);
        return true;
      }
    }

    const patchUpdate = fileChangeItemFromPatchUpdate(payload);
    if (event.type === "codex/item/fileChange/patchUpdated" && patchUpdate) {
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
      const followLatest = this.#isNearLatest();
      for (const item of payload.turn.items) this.#upsertItem(item);
      if (payload.turn.error) {
        this.#appendNoticeElement(
          "Codex 错误",
          messageFromPayload(
            payload.turn.error as unknown as Record<string, unknown>,
          ),
          "error",
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
      const followLatest = this.#isNearLatest();
      this.#appendDelta(payload.itemId, payload.delta, deltaKind);
      this.#finishContentUpdate(followLatest);
      return true;
    }

    if (event.type === "codex/error" || event.type === "codex/warning") {
      this.appendNotice(
        event.type === "codex/error" ? "Codex 错误" : "Codex 警告",
        messageFromPayload(payload),
        event.type === "codex/error" ? "error" : "event",
      );
      return true;
    }
    return false;
  }

  followLatest(): void {
    this.#container.scrollTop = this.#container.scrollHeight;
    this.#setFollowingLatest(true);
  }

  #replaceSnapshot(response: ThreadReadResponse): void {
    this.#snapshotRevision = threadSnapshotRevision(response);
    this.#container.replaceChildren();
    for (const turn of response.thread.turns) this.#renderTurn(turn);
    if (this.#container.childElementCount === 0) {
      this.#container.append(emptyElement("这个会话还没有消息"));
    }
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

  #renderTurn(turn: Turn): void {
    const section = document.createElement("section");
    section.className = "turn-block";
    section.dataset.turnId = turn.id;
    for (const item of turn.items) {
      if (isVisibleThreadItem(item)) section.append(this.#itemElement(item));
    }
    if (turn.error) {
      const error = document.createElement("article");
      error.className = "timeline-entry error";
      error.textContent = messageFromPayload(
        turn.error as unknown as Record<string, unknown>,
      );
      section.append(error);
    }
    if (section.childElementCount > 0) this.#container.append(section);
  }

  #upsertItem(item: ThreadItem): void {
    if (!isVisibleThreadItem(item)) return;
    this.#container.querySelector(".empty")?.remove();
    if (item.type === "userMessage" && !item.id.startsWith("local-")) {
      this.#container.querySelector<HTMLElement>("[data-local-user]")?.remove();
    }
    const existing = this.#findItem(item.id);
    const replacement = this.#itemElement(item);
    if (existing) existing.replaceWith(replacement);
    else this.#container.append(replacement);
  }

  #appendDelta(
    itemId: string,
    delta: string,
    kind: "agent" | "plan" | "tool",
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
      const body = document.createElement("div");
      body.className = "message-text stream-target";
      card.append(heading, body);
      this.#container.append(card);
    }
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

  #findItem(itemId: string): HTMLElement | undefined {
    return Array.from(
      this.#container.querySelectorAll<HTMLElement>("[data-item-id]"),
    ).find((candidate) => candidate.dataset.itemId === itemId);
  }

  #itemElement(item: VisibleThreadItem): HTMLElement {
    const presentation = describeThreadItem(item);
    const card = document.createElement("article");
    card.className = `timeline-entry ${presentation.kind}`;
    card.dataset.itemId = item.id;

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
        const output = document.createElement("pre");
        output.textContent = item.aggregatedOutput;
        details.append(summary, output);
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
        details.open = item.changes.length === 1;
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
        if (change.kind.type === "update" && change.kind.move_path) {
          const moved = document.createElement("div");
          moved.className = "file-change-move";
          moved.textContent = `移动到 ${change.kind.move_path}`;
          details.append(summary, moved, renderUnifiedDiff(change.diff));
          card.append(details);
          continue;
        }
        const diff = renderUnifiedDiff(change.diff);
        details.append(summary, diff);
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
