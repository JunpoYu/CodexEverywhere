import { lazy, Suspense } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { Icon, type IconName } from "../components/Icon.js";

const MarkdownContent = lazy(() => import("./MarkdownContent.js"));

type TimelineItem = OutputOf<"thread/open">["items"][number];
type TimelineData = TimelineItem["data"];

export function TimelineItemView(input: { readonly item: TimelineItem }) {
  const { item } = input;
  const role = messageRole(item);
  return (
    <article
      className={`timeline-item type-${item.type} ${role === "user" ? "role-user" : item.type === "message" ? "role-assistant" : ""}`}
    >
      <header>
        <span className="timeline-author">
          <i aria-hidden="true" />
          {itemLabel(item)}
        </span>
        {item.createdAt ? (
          <time dateTime={item.createdAt}>
            {new Date(item.createdAt).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        ) : null}
      </header>
      <TimelineItemContent item={item} />
    </article>
  );
}

function TimelineItemContent(input: { readonly item: TimelineItem }) {
  const { item } = input;
  if (item.type === "message" || item.type === "plan") {
    const text = timelineText(item.data);
    return text === undefined ? (
      <GenericEvent data={item.data} />
    ) : (
      <Suspense fallback={<p className="timeline-plain-text">{text}</p>}>
        <MarkdownContent text={text} />
      </Suspense>
    );
  }
  if (item.type === "command") return <CommandEvent data={item.data} />;
  if (item.type === "file-change") return <FileChangeEvent data={item.data} />;
  if (item.type === "mcp") return <McpEvent data={item.data} />;
  if (item.type === "subagent") return <SubagentEvent data={item.data} />;
  if (item.type === "error") return <ErrorEvent data={item.data} />;
  return <GenericEvent data={item.data} />;
}

function CommandEvent(input: { readonly data: TimelineData }) {
  const command = stringValue(input.data.command) ?? "Codex 执行了一个命令";
  const output = stringValue(input.data.aggregatedOutput);
  const status = stringValue(input.data.status);
  const cwd = stringValue(input.data.cwd);
  return (
    <>
      <EventSummary
        icon="terminal"
        meta={cwd}
        status={status}
        title={command}
      />
      {output === undefined || output.length === 0 ? null : (
        <details className="timeline-details">
          <summary>查看命令输出</summary>
          <pre>{output}</pre>
        </details>
      )}
    </>
  );
}

function FileChangeEvent(input: { readonly data: TimelineData }) {
  const changes = objectArray(input.data.changes);
  const status = stringValue(input.data.status);
  return (
    <>
      <EventSummary
        icon="workspace"
        status={status}
        title={
          changes.length > 0 ? `修改了 ${changes.length} 个文件` : "文件修改"
        }
      />
      {changes.length === 0 ? null : (
        <ul className="file-change-list">
          {changes.map((change, index) => {
            const path = stringValue(change.path) ?? `文件 ${index + 1}`;
            const diff = stringValue(change.diff);
            return (
              <li key={`${path}:${index}`}>
                <div>
                  <code>{path}</code>
                  <span>{fileChangeKind(change.kind)}</span>
                </div>
                {diff === undefined || diff.length === 0 ? null : (
                  <details className="timeline-details">
                    <summary>查看差异</summary>
                    <pre>{diff}</pre>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function McpEvent(input: { readonly data: TimelineData }) {
  const server = stringValue(input.data.server);
  const tool =
    stringValue(input.data.tool) ??
    stringValue(input.data.namespace) ??
    "工具调用";
  const status = stringValue(input.data.status);
  const error = objectValue(input.data.error);
  const detail =
    error === undefined
      ? (input.data.result ?? input.data.contentItems ?? input.data.arguments)
      : error;
  return (
    <>
      <EventSummary
        icon="connection"
        meta={server}
        status={status}
        title={tool}
      />
      {detail === undefined || detail === null ? null : (
        <details className="timeline-details">
          <summary>
            {error === undefined ? "查看调用详情" : "查看错误详情"}
          </summary>
          <pre>{formatJson(detail)}</pre>
        </details>
      )}
    </>
  );
}

function SubagentEvent(input: { readonly data: TimelineData }) {
  const tool = stringValue(input.data.tool);
  const kind = stringValue(input.data.kind);
  const status = stringValue(input.data.status) ?? kind;
  const agentPath = stringValue(input.data.agentPath);
  const receivers = stringArray(input.data.receiverThreadIds);
  const prompt = stringValue(input.data.prompt);
  return (
    <>
      <EventSummary
        icon="task"
        meta={
          agentPath ??
          (receivers.length > 0 ? `${receivers.length} 个目标` : undefined)
        }
        status={status}
        title={subagentLabel(tool ?? kind)}
      />
      {prompt === undefined ? null : (
        <p className="event-description">{prompt}</p>
      )}
    </>
  );
}

function ErrorEvent(input: { readonly data: TimelineData }) {
  const message =
    stringValue(input.data.message) ??
    stringValue(input.data.error) ??
    "Codex turn 执行失败";
  return <p className="event-error">{message}</p>;
}

function GenericEvent(input: { readonly data: TimelineData }) {
  return (
    <details className="timeline-details generic-event">
      <summary>{genericEventLabel(input.data)}</summary>
      <pre>{formatJson(input.data)}</pre>
    </details>
  );
}

function EventSummary(input: {
  readonly icon: IconName;
  readonly meta?: string | undefined;
  readonly status?: string | undefined;
  readonly title: string;
}) {
  return (
    <div className="event-summary">
      <span className="event-icon">
        <Icon name={input.icon} />
      </span>
      <div>
        <strong title={input.title}>{input.title}</strong>
        {input.meta === undefined ? null : <small>{input.meta}</small>}
      </div>
      {input.status === undefined ? null : (
        <span className={`event-status ${eventStatusTone(input.status)}`}>
          {eventStatusLabel(input.status)}
        </span>
      )}
    </div>
  );
}

function itemLabel(item: TimelineItem): string {
  if (item.type === "message") {
    const sourceType = stringValue(item.data.type);
    if (sourceType === "reasoning") return "推理摘要";
    if (sourceType === "hookPrompt") return "Hook";
    return messageRole(item) === "user" ? "你" : "Codex";
  }
  const labels: Record<TimelineItem["type"], string> = {
    message: "Codex",
    plan: "计划",
    command: "命令",
    "file-change": "文件修改",
    mcp: "MCP",
    subagent: "Subagent",
    error: "错误",
    generic: "事件",
  };
  return labels[item.type];
}

function messageRole(item: TimelineItem): "user" | "assistant" {
  return item.data.role === "user" || item.data.type === "userMessage"
    ? "user"
    : "assistant";
}

function timelineText(data: TimelineData): string | undefined {
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

function genericEventLabel(data: TimelineData): string {
  const type = stringValue(data.type);
  const labels: Record<string, string> = {
    webSearch: "Web 搜索",
    imageView: "查看图片",
    imageGeneration: "生成图片",
    sleep: "等待",
    enteredReviewMode: "进入 Review 模式",
    exitedReviewMode: "退出 Review 模式",
    contextCompaction: "上下文已压缩",
  };
  return type === undefined ? "查看事件详情" : (labels[type] ?? type);
}

function subagentLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    spawnAgent: "启动 Subagent",
    sendInput: "向 Subagent 发送消息",
    wait: "等待 Subagent",
    closeAgent: "关闭 Subagent",
    started: "Subagent 已启动",
    interacted: "Subagent 有新活动",
    interrupted: "Subagent 已中断",
  };
  return value === undefined ? "Subagent 活动" : (labels[value] ?? value);
}

function fileChangeKind(value: unknown): string {
  const kind = objectValue(value);
  const type = kind === undefined ? undefined : stringValue(kind.type);
  if (type === "add") return "新增";
  if (type === "delete") return "删除";
  if (type === "update") return "修改";
  return "变更";
}

function eventStatusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("declin"))
    return "failed";
  if (normalized.includes("progress") || normalized.includes("started"))
    return "running";
  return "completed";
}

function eventStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    inProgress: "进行中",
    completed: "已完成",
    failed: "失败",
    declined: "已拒绝",
    started: "已启动",
    interacted: "有活动",
    interrupted: "已中断",
  };
  return labels[status] ?? status;
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

function objectValue(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
