import { useEffect, useRef, useState } from "react";
import { composerDraftFor } from "../../actors/composer-actor.js";
import { sideMutationBusy } from "../../actors/side-chat-runtime.js";
import { useActorState } from "../../actors/use-actor.js";
import { InteractionCard } from "../interactions/InteractionCard.js";
import { useRuntime } from "../runtime-context.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { TimelineViewport } from "../timeline/TimelineViewport.js";
import { projectTimelinePresentation } from "../timeline/timeline-presentation-model.js";
import {
  timelineItemText,
  timelineMessageRole,
} from "../timeline/timeline-item-model.js";
import styles from "./SideChatPanel.module.css";

export function SideChatPanel({
  parentThreadId,
  parentStatus,
}: {
  parentThreadId: string;
  parentStatus: string;
}) {
  const runtime = useRuntime();
  const control = useActorState(runtime.side.actor);
  const thread = useActorState(runtime.side.thread);
  const composer = useActorState(runtime.side.composer);
  const [copied, setCopied] = useState(false);
  const [acknowledgeOrphan, setAcknowledgeOrphan] = useState(false);
  useEffect(() => setAcknowledgeOrphan(false), [control.side?.creationKey]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadId = control.side?.threadId;
  const snapshot = thread.threadId === threadId ? thread.snapshot : undefined;
  const busy = sideMutationBusy(control);
  const ready = control.status === "idle" && control.side?.status === "ready";
  const draft = threadId ? composerDraftFor(composer, threadId) : "";
  const running =
    thread.status === "running" || thread.status === "waiting-input";
  const canSend =
    ready &&
    composer.status === "idle" &&
    (thread.status === "idle" ||
      (thread.status === "failed" && thread.error === undefined));
  const answer =
    snapshot === undefined
      ? undefined
      : projectTimelinePresentation(snapshot.items, snapshot.state)
          .filter(
            (entry) =>
              entry.kind === "item" &&
              entry.item.type === "message" &&
              timelineMessageRole(entry.item) === "assistant",
          )
          .at(-1);
  const answerText =
    answer?.kind === "item" ? timelineItemText(answer.item.data) : undefined;
  useEffect(() => {
    if (ready) inputRef.current?.focus();
  }, [ready, threadId]);
  useEffect(() => {
    setCopied(false);
  }, [answer?.id]);
  return (
    <aside
      className={styles.panel}
      aria-label="旁支问答"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          runtime.side.actor.dispatch({ type: "HIDE" });
        }
      }}
    >
      <header className={styles.header}>
        <div>
          <h2>旁支问答</h2>
          <span>主任务 · {parentStatus}</span>
        </div>
        <button
          type="button"
          onClick={() => runtime.side.actor.dispatch({ type: "HIDE" })}
        >
          收起 / 返回
        </button>
      </header>
      <p className={styles.context}>
        继承主任务截至创建时最近已完成轮次的上下文；下方仅显示旁支新消息。
      </p>
      {control.status === "creating" || control.status === "loading" ? (
        <p className={styles.notice} role="status">
          正在同步旁支…
        </p>
      ) : null}
      {control.status === "reconciling" ? (
        <p className={styles.notice} role="status">
          正在核对操作结果，请勿重复提交。
        </p>
      ) : null}
      {control.error || control.status === "review" ? (
        <div className={styles.notice}>
          <StatusMessage tone="error">
            {control.error ??
              "上次操作结果需要核对；刷新读取宿主机状态，不会重复创建旁支。"}
          </StatusMessage>
        </div>
      ) : null}
      {thread.error ? (
        <div className={styles.notice}>
          <StatusMessage tone="error">{thread.error}</StatusMessage>
        </div>
      ) : null}
      {snapshot && ready ? (
        <TimelineViewport
          key={threadId}
          items={snapshot.items}
          threadState={snapshot.state}
          hasEarlierHistory={snapshot.hasEarlierHistory}
          historyStatus={thread.historyStatus}
          historyError={thread.historyError}
          historyDisabled={thread.refreshing === true}
          onLoadEarlier={() => {
            runtime.side.thread.dispatch({ type: "LOAD_EARLIER" });
            return (
              runtime.side.thread.getSnapshot().historyStatus === "loading"
            );
          }}
        />
      ) : (
        <div className={styles.empty}>
          {ready ? "正在读取消息…" : "旁支内容以宿主机上的 Codex 会话为准。"}
        </div>
      )}
      <div className={styles.bottom}>
        {snapshot?.interactions
          .filter((interaction) => interaction.kind === "user-question")
          .map((interaction) => (
            <InteractionCard key={interaction.id} interaction={interaction} />
          ))}
        {snapshot?.interactions.some(
          (interaction) => interaction.kind !== "user-question",
        ) ? (
          <StatusMessage tone="warning">
            旁支请求了不支持的执行操作；请结束并删除旁支。
          </StatusMessage>
        ) : null}
        {answerText ? (
          <button
            type="button"
            disabled={copied || running}
            onClick={() => {
              const existing = composerDraftFor(
                runtime.composer.getSnapshot(),
                parentThreadId,
              );
              runtime.composer.dispatch({
                type: "DRAFT",
                threadId: parentThreadId,
                value: [existing, `旁支问答参考：\n${answerText}`]
                  .filter(Boolean)
                  .join("\n\n"),
              });
              setCopied(true);
            }}
          >
            {copied ? "已追加到主对话草稿" : "带回主对话"}
          </button>
        ) : null}
        {control.initialQuestion && !busy ? (
          <div>
            <StatusMessage tone="warning">
              待发送问题：{control.initialQuestion}
            </StatusMessage>
            <button
              type="button"
              onClick={() => {
                const existing = composerDraftFor(
                  runtime.composer.getSnapshot(),
                  parentThreadId,
                );
                runtime.composer.dispatch({
                  type: "DRAFT",
                  threadId: parentThreadId,
                  value: [existing, control.initialQuestion!]
                    .filter(Boolean)
                    .join("\n\n"),
                });
                runtime.side.actor.dispatch({ type: "CONSUMED" });
              }}
            >
              将问题恢复到主对话草稿
            </button>
          </div>
        ) : null}
        {composer.error ? (
          <StatusMessage tone="error">{composer.error}</StatusMessage>
        ) : null}
        {composer.status === "manual-review" ? (
          <button
            type="button"
            onClick={() =>
              runtime.side.composer.dispatch({ type: "ACKNOWLEDGE_MANUAL" })
            }
          >
            我已核对发送结果，恢复草稿
          </button>
        ) : null}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend && threadId && draft.trim())
              runtime.side.composer.dispatch({ type: "SUBMIT", threadId });
          }}
        >
          <textarea
            ref={inputRef}
            aria-label="旁支问题"
            placeholder="针对主任务提问…"
            rows={3}
            disabled={!ready || threadId === undefined}
            value={draft}
            onChange={(event) => {
              if (threadId)
                runtime.side.composer.dispatch({
                  type: "DRAFT",
                  threadId,
                  value: event.target.value,
                });
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div>
            <span>{running ? "Codex 正在回答…" : "仅问答 · 不执行操作"}</span>
            <button
              className="primary"
              type="submit"
              disabled={!canSend || !draft.trim()}
            >
              {composer.status === "idle" ? "提问" : "确认发送中…"}
            </button>
          </div>
        </form>
        {control.side?.creationKey && !threadId ? (
          <div>
            <p>
              创建结果未知，Codex
              中可能仍有遗留旁支。解除占用只清除关联，不会宣称已删除该会话；遗留会话需在宿主机核对处理。
            </p>
            <label>
              <input
                type="checkbox"
                checked={acknowledgeOrphan}
                onChange={(event) => setAcknowledgeOrphan(event.target.checked)}
              />
              我已了解可能存在遗留会话
            </label>
            <button
              type="button"
              disabled={busy || !acknowledgeOrphan || !!control.initialQuestion}
              onClick={() => runtime.side.actor.dispatch({ type: "ABANDON" })}
            >
              解除旁支占用
            </button>
          </div>
        ) : null}
        <footer className={styles.footer}>
          <span>收起后保留，结束后删除。</span>
          {control.status === "failed" ||
          control.status === "review" ||
          thread.error ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                runtime.side.actor.dispatch({ type: "RELOAD" });
                runtime.side.refreshThread();
              }}
            >
              刷新
            </button>
          ) : null}
          <button
            className="danger-action"
            type="button"
            disabled={busy || composer.status !== "idle" || !threadId}
            onClick={() => runtime.side.actor.dispatch({ type: "DELETE" })}
          >
            {control.status === "deleting"
              ? "正在删除…"
              : running
                ? "停止并删除"
                : "结束并删除"}
          </button>
        </footer>
      </div>
    </aside>
  );
}
