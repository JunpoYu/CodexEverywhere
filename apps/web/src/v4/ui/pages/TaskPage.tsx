import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { mutationOptions } from "../../gateway/gateway-port.js";
import { Icon } from "../components/Icon.js";
import { ModalDialog } from "../components/ModalDialog.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { InteractionCard } from "../interactions/InteractionCard.js";
import { useRuntime } from "../runtime-context.js";
import { TimelineItemView } from "../timeline/TimelineItemView.js";
import { ThreadSettingsPanel } from "./ThreadSettingsPanel.js";

export function TaskPage() {
  const { threadId = "" } = useParams();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const thread = useActorState(runtime.thread);
  const composer = useActorState(runtime.composer);
  const queue = useActorState(runtime.queue);
  const [handoff, setHandoff] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [renameTitle, setRenameTitle] = useState<string>();
  const [taskMutating, setTaskMutating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [handoffCopied, setHandoffCopied] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [taskNotice, setTaskNotice] = useState<string>();

  useEffect(() => {
    setTaskNotice(undefined);
    if (threadId.length > 0)
      runtime.thread.dispatch({ type: "OPEN", threadId });
    return () => runtime.thread.dispatch({ type: "CLOSE" });
  }, [runtime, threadId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      composer.status !== "idle" ||
      thread.status !== "idle" ||
      composer.draft.trim().length === 0
    ) {
      return;
    }
    runtime.composer.dispatch({ type: "SUBMIT", threadId });
  };

  const interrupt = async () => {
    setActionError(undefined);
    try {
      await runtime.gateway.request(
        "turn/interrupt",
        { version: 1, threadId },
        mutationOptions(),
      );
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "中断任务失败");
    }
  };

  const tuiHandoff = async () => {
    setActionError(undefined);
    try {
      const result = await runtime.gateway.request(
        "thread/tui/handoff",
        { version: 1, threadId },
        mutationOptions(),
      );
      setHandoff(result.command);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "TUI 接力失败");
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const title = renameTitle?.trim() ?? "";
    if (title.length === 0) return;
    setTaskMutating(true);
    setActionError(undefined);
    try {
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/rename",
        payload: { version: 1, threadId, title },
      });
      setRenameTitle(undefined);
      runtime.thread.dispatch({ type: "OPEN", threadId });
      runtime.tasks.dispatch({ type: "LOAD" });
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "任务重命名失败",
      );
    } finally {
      setTaskMutating(false);
    }
  };

  const archive = async (archived: boolean) => {
    setTaskMutating(true);
    setActionError(undefined);
    try {
      if (archived) {
        await durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "thread/unarchive",
          payload: { version: 1, threadId },
        });
      } else {
        await durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "thread/archive",
          payload: { version: 1, threadId },
        });
      }
      runtime.tasks.dispatch({ type: "LOAD" });
      navigate("/tasks");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "任务归档失败");
    } finally {
      setTaskMutating(false);
    }
  };

  const deleteTask = async () => {
    setTaskMutating(true);
    setActionError(undefined);
    try {
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/delete",
        payload: { version: 1, threadId },
      });
      runtime.tasks.dispatch({ type: "LOAD" });
      navigate("/tasks");
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "任务删除失败");
    } finally {
      setTaskMutating(false);
    }
  };

  if (thread.threadId !== threadId || thread.snapshot === undefined) {
    return (
      <main className="page loading-page">
        <span className="spinner" />
        正在同步任务…
      </main>
    );
  }
  const snapshot = thread.snapshot;
  const taskActive =
    thread.status === "running" || thread.status === "waiting-input";
  const taskQueue = queue.items.filter((item) => item.threadId === threadId);

  return (
    <main
      className="conversation-page"
      aria-busy={
        taskMutating ||
        composer.status === "submitting" ||
        composer.status === "outcome-unknown" ||
        composer.status === "reconciling"
      }
    >
      <section className="conversation-main">
        <header className="conversation-header">
          <div className="conversation-title">
            <p className="eyebrow">任务</p>
            <h1>{snapshot.thread.title || "未命名任务"}</h1>
            <span className={`state-pill ${thread.status}`}>
              <i />
              {threadStateLabel(thread.status)}
              {thread.refreshing ? " · 正在同步" : ""}
            </span>
          </div>
          <div className="conversation-actions">
            {thread.status === "running" ? (
              <button type="button" onClick={() => void interrupt()}>
                <Icon name="stop" />
                中断
              </button>
            ) : null}
            <button
              aria-label="转到 TUI"
              className="conversation-secondary-action"
              title="转到 TUI"
              type="button"
              onClick={() => void tuiHandoff()}
            >
              <Icon name="terminal" />
              <span>转到 TUI</span>
            </button>
            <button
              aria-label="任务设置"
              className="conversation-secondary-action"
              title="任务设置"
              type="button"
              onClick={() => setSettingsOpen(true)}
            >
              <Icon name="settings" />
              <span>任务设置</span>
            </button>
            <details className="task-action-menu">
              <summary aria-label="更多任务操作">
                <Icon name="more" />
              </summary>
              <div>
                <button
                  disabled={taskMutating}
                  type="button"
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    setRenameTitle(snapshot.thread.title);
                  }}
                >
                  重命名
                </button>
                <button
                  disabled={taskMutating || thread.status === "running"}
                  type="button"
                  onClick={() => void archive(snapshot.thread.archived)}
                >
                  <Icon name="archive" />
                  {snapshot.thread.archived ? "取消归档" : "归档"}
                </button>
                <button
                  className="danger-action"
                  disabled={taskMutating || thread.status === "running"}
                  type="button"
                  onClick={(event) => {
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open");
                    setActionError(undefined);
                    setDeleteConfirmOpen(true);
                  }}
                >
                  <Icon name="trash" />
                  删除
                </button>
              </div>
            </details>
          </div>
        </header>
        {actionError === undefined || deleteConfirmOpen ? null : (
          <div className="conversation-notice">
            <StatusMessage tone="error">{actionError}</StatusMessage>
          </div>
        )}
        {taskNotice === undefined ? null : (
          <div className="conversation-notice">
            <StatusMessage tone="success">{taskNotice}</StatusMessage>
          </div>
        )}
        {renameTitle === undefined ? null : (
          <form className="conversation-rename" onSubmit={rename}>
            <input
              aria-label="任务名称"
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
            />
            <button type="button" onClick={() => setRenameTitle(undefined)}>
              取消
            </button>
            <button className="primary" disabled={taskMutating} type="submit">
              保存
            </button>
          </form>
        )}
        <section className="timeline" aria-live="polite">
          {snapshot.hasEarlierHistory ? (
            <button
              disabled={thread.status === "syncing"}
              type="button"
              onClick={() => runtime.thread.dispatch({ type: "LOAD_EARLIER" })}
            >
              {thread.status === "syncing" ? "正在加载…" : "加载更早记录"}
            </button>
          ) : null}
          {snapshot.items.map((item) => (
            <TimelineItemView item={item} key={item.id} />
          ))}
        </section>
        <section className="composer-dock">
          {snapshot.interactions.map((interaction) => (
            <InteractionCard interaction={interaction} key={interaction.id} />
          ))}
          {composer.status === "manual-review" ? (
            <div
              className="outcome-warning mutation-outcome-pending"
              role="alert"
            >
              <strong>发送结果需要人工确认</strong>
              <span>{composer.error}</span>
              <button
                type="button"
                onClick={() =>
                  runtime.composer.dispatch({ type: "ACKNOWLEDGE_MANUAL" })
                }
              >
                我已核对，恢复草稿
              </button>
            </div>
          ) : null}
          {composer.status === "idle" && composer.error !== undefined ? (
            <StatusMessage tone="error">{composer.error}</StatusMessage>
          ) : null}
          <form className="composer" onSubmit={submit}>
            <textarea
              aria-label="给 Codex 的消息"
              rows={3}
              placeholder={
                taskActive
                  ? "任务运行中；可添加到 Queue…"
                  : "继续告诉 Codex 要做什么…"
              }
              value={composer.draft}
              onChange={(event) =>
                runtime.composer.dispatch({
                  type: "DRAFT",
                  value: event.target.value,
                })
              }
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div>
              {taskActive ? (
                <button
                  disabled={
                    composer.status !== "idle" ||
                    composer.draft.trim().length === 0
                  }
                  type="button"
                  onClick={() =>
                    runtime.composer.dispatch({ type: "QUEUE", threadId })
                  }
                >
                  加入 Queue
                </button>
              ) : null}
              <button
                className="primary"
                disabled={
                  composer.status !== "idle" ||
                  thread.status !== "idle" ||
                  composer.draft.trim().length === 0
                }
                type="submit"
              >
                <Icon name="send" />
                {composer.status === "submitting" ? "发送中…" : "发送"}
              </button>
            </div>
          </form>
          <p className="composer-hint">按 Ctrl/⌘ + Enter 发送</p>
        </section>
      </section>
      <aside className="task-context" aria-label="任务上下文">
        <section>
          <header>
            <span>运行上下文</span>
            <span className={`state-pill ${thread.status}`}>
              <i />
              {threadStateLabel(thread.status)}
            </span>
          </header>
          <dl>
            <div>
              <dt>模型</dt>
              <dd>{snapshot.settings.model ?? "Codex 当前值"}</dd>
            </div>
            <div>
              <dt>推理强度</dt>
              <dd>{effortLabel(snapshot.settings.effort)}</dd>
            </div>
            <div>
              <dt>设置 revision</dt>
              <dd>{snapshot.settings.revision}</dd>
            </div>
          </dl>
        </section>
        <section>
          <header>
            <span>权限</span>
            <button
              className="context-action"
              type="button"
              onClick={() => setSettingsOpen(true)}
            >
              修改
            </button>
          </header>
          <dl>
            <div>
              <dt>文件访问</dt>
              <dd>{sandboxLabel(snapshot.settings.sandbox)}</dd>
            </div>
            <div>
              <dt>审批策略</dt>
              <dd>{approvalLabel(snapshot.settings.approvalPolicy)}</dd>
            </div>
          </dl>
        </section>
        <section>
          <header>
            <span>待处理</span>
          </header>
          <dl>
            <div>
              <dt>需要你的操作</dt>
              <dd>{snapshot.interactions.length}</dd>
            </div>
            <div>
              <dt>Queue</dt>
              <dd>{taskQueue.length}</dd>
            </div>
          </dl>
        </section>
        <p className="context-footnote">
          状态来自 Codex app-server；断线重连后会按权威快照恢复。
        </p>
      </aside>
      {settingsOpen ? (
        <ThreadSettingsPanel
          settings={snapshot.settings}
          threadId={threadId}
          onClose={() => setSettingsOpen(false)}
          onSaved={(settings) =>
            setTaskNotice(
              `任务设置已保存 · ${sandboxLabel(settings.sandbox)} · ${approvalLabel(settings.approvalPolicy)}`,
            )
          }
        />
      ) : null}
      {deleteConfirmOpen ? (
        <ModalDialog
          aria-describedby="delete-task-description"
          aria-labelledby="delete-task-title"
          className="ce-dialog confirm-dialog"
          onRequestClose={() => {
            if (!taskMutating) setDeleteConfirmOpen(false);
          }}
        >
          <span className="dialog-icon danger">
            <Icon name="trash" />
          </span>
          <h2 id="delete-task-title">永久删除这个任务？</h2>
          <p id="delete-task-description">
            任务将从 Codex app-server 中删除，CE
            无法恢复。工作区中的文件不会被删除。
          </p>
          {actionError === undefined ? null : (
            <StatusMessage tone="error">{actionError}</StatusMessage>
          )}
          <div className="dialog-actions">
            <button
              disabled={taskMutating}
              type="button"
              onClick={() => setDeleteConfirmOpen(false)}
            >
              取消
            </button>
            <button
              className="danger-button"
              disabled={taskMutating}
              type="button"
              onClick={() => void deleteTask()}
            >
              {taskMutating ? "正在删除…" : "永久删除"}
            </button>
          </div>
        </ModalDialog>
      ) : null}
      {handoff === undefined ? null : (
        <ModalDialog
          aria-labelledby="tui-handoff-title"
          className="ce-dialog"
          onRequestClose={() => {
            setHandoff(undefined);
            setHandoffCopied(false);
          }}
        >
          <h2 id="tui-handoff-title">在 HPC 终端继续</h2>
          <p>此命令只接管官方 TUI，不会中断正在运行的 turn。</p>
          <pre>{handoff}</pre>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(handoff).then(() => {
                  setHandoffCopied(true);
                })
              }
            >
              {handoffCopied ? "已复制" : "复制"}
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => {
                setHandoff(undefined);
                setHandoffCopied(false);
              }}
            >
              关闭
            </button>
          </div>
        </ModalDialog>
      )}
    </main>
  );
}

function threadStateLabel(status: string): string {
  const labels: Record<string, string> = {
    closed: "已关闭",
    opening: "正在打开",
    syncing: "正在同步",
    idle: "就绪",
    running: "正在运行",
    "waiting-input": "等待你的操作",
    reconnecting: "正在重连",
    failed: "出现错误",
  };
  return labels[status] ?? status;
}

function sandboxLabel(value: string | undefined): string {
  if (value === "read-only") return "只读";
  if (value === "workspace-write") return "工作区可写";
  if (value === "danger-full-access") return "完全访问";
  return "Codex 当前值";
}

function approvalLabel(value: string | undefined): string {
  if (value === "untrusted") return "严格审批";
  if (value === "on-request") return "按需询问";
  if (value === "never") return "从不询问";
  return "Codex 当前值";
}

function effortLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "很高",
    max: "最大",
    ultra: "Ultra",
  };
  return value === undefined ? "Codex 当前值" : (labels[value] ?? value);
}
