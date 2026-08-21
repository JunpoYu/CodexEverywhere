import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useActorState } from "../../actors/use-actor.js";
import { composerDraftFor } from "../../actors/composer-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { mutationOptions } from "../../gateway/gateway-port.js";
import { Icon } from "../components/Icon.js";
import { ModalDialog } from "../components/ModalDialog.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { InteractionCard } from "../interactions/InteractionCard.js";
import {
  approvalSettingLabel,
  reasoningEffortLabel,
  sandboxSettingLabel,
} from "../formatters/thread-settings.js";
import { useRuntime } from "../runtime-context.js";
import { ConversationOutlineDialog } from "../timeline/ConversationOutlineDialog.js";
import { projectConversationOutline } from "../timeline/conversation-outline-model.js";
import {
  TimelineViewport,
  type TimelineViewportHandle,
} from "../timeline/TimelineViewport.js";
import { TaskContextBar } from "./TaskContextBar.js";
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
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [activeOutlineItemId, setActiveOutlineItemId] = useState<string>();
  const timelineViewportRef = useRef<TimelineViewportHandle>(null);
  const activeThreadId = useRef(threadId);
  activeThreadId.current = threadId;
  const composerDraft = composerDraftFor(composer, threadId);

  useEffect(() => {
    setActionError(undefined);
    setRenameTitle(undefined);
    setTaskMutating(false);
    setSettingsOpen(false);
    setHandoff(undefined);
    setHandoffCopied(false);
    setDeleteConfirmOpen(false);
    setTaskNotice(undefined);
    setOutlineOpen(false);
    setActiveOutlineItemId(undefined);
    if (threadId.length > 0)
      runtime.thread.dispatch({ type: "OPEN", threadId });
    return () => runtime.thread.dispatch({ type: "CLOSE" });
  }, [runtime, threadId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      composer.status !== "idle" ||
      thread.status !== "idle" ||
      composerDraft.trim().length === 0
    ) {
      return;
    }
    runtime.composer.dispatch({ type: "SUBMIT", threadId });
  };

  const interrupt = async () => {
    const targetThreadId = threadId;
    setActionError(undefined);
    try {
      await runtime.gateway.request(
        "turn/interrupt",
        { version: 1, threadId: targetThreadId },
        mutationOptions(),
      );
    } catch (reason) {
      if (activeThreadId.current === targetThreadId) {
        setActionError(
          reason instanceof Error ? reason.message : "中断任务失败",
        );
      }
    }
  };

  const tuiHandoff = async () => {
    const targetThreadId = threadId;
    setActionError(undefined);
    try {
      const result = await runtime.gateway.request(
        "thread/tui/handoff",
        { version: 1, threadId: targetThreadId },
        mutationOptions(),
      );
      if (activeThreadId.current === targetThreadId) {
        setHandoff(result.command);
      }
    } catch (reason) {
      if (activeThreadId.current === targetThreadId) {
        setActionError(
          reason instanceof Error ? reason.message : "TUI 接力失败",
        );
      }
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const title = renameTitle?.trim() ?? "";
    if (title.length === 0) return;
    const targetThreadId = threadId;
    setTaskMutating(true);
    setActionError(undefined);
    try {
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/rename",
        payload: { version: 1, threadId: targetThreadId, title },
      });
      runtime.refreshTasks();
      if (activeThreadId.current === targetThreadId) {
        setRenameTitle(undefined);
        runtime.thread.dispatch({ type: "OPEN", threadId: targetThreadId });
      }
    } catch (reason) {
      if (activeThreadId.current === targetThreadId) {
        setActionError(
          reason instanceof Error ? reason.message : "任务重命名失败",
        );
      }
    } finally {
      if (activeThreadId.current === targetThreadId) setTaskMutating(false);
    }
  };

  const archive = async (archived: boolean) => {
    const targetThreadId = threadId;
    setTaskMutating(true);
    setActionError(undefined);
    try {
      if (archived) {
        await durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "thread/unarchive",
          payload: { version: 1, threadId: targetThreadId },
        });
      } else {
        await durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "thread/archive",
          payload: { version: 1, threadId: targetThreadId },
        });
      }
      const taskList = runtime.tasks.getSnapshot();
      runtime.tasks.dispatch({
        type: "LOAD",
        ...(taskList.workspaceId === undefined
          ? {}
          : { workspaceId: taskList.workspaceId }),
        ...(taskList.workspaceLabel === undefined
          ? {}
          : { workspaceLabel: taskList.workspaceLabel }),
      });
      if (activeThreadId.current === targetThreadId) navigate("/tasks");
    } catch (reason) {
      if (activeThreadId.current === targetThreadId) {
        setActionError(
          reason instanceof Error ? reason.message : "任务归档失败",
        );
      }
    } finally {
      if (activeThreadId.current === targetThreadId) setTaskMutating(false);
    }
  };

  const deleteTask = async () => {
    const targetThreadId = threadId;
    setTaskMutating(true);
    setActionError(undefined);
    try {
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/delete",
        payload: { version: 1, threadId: targetThreadId },
      });
      runtime.refreshTasks();
      if (activeThreadId.current === targetThreadId) navigate("/tasks");
    } catch (reason) {
      if (activeThreadId.current === targetThreadId) {
        setActionError(
          reason instanceof Error ? reason.message : "任务删除失败",
        );
      }
    } finally {
      if (activeThreadId.current === targetThreadId) setTaskMutating(false);
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
  const outlineEntries = projectConversationOutline(snapshot.items);
  const composerBusyElsewhere =
    composer.status !== "idle" &&
    composer.threadId !== undefined &&
    composer.threadId !== threadId;

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
              aria-controls="conversation-outline"
              aria-expanded={outlineOpen}
              aria-label={`打开对话大纲，当前已加载 ${outlineEntries.length} 条请求`}
              className="conversation-secondary-action"
              title={`对话大纲 · ${outlineEntries.length} 条已加载请求`}
              type="button"
              onClick={() => setOutlineOpen(true)}
            >
              <Icon name="outline" />
              <span>大纲 {outlineEntries.length}</span>
            </button>
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
        <TaskContextBar
          approval={approvalSettingLabel(snapshot.settings.approvalPolicy)}
          effort={reasoningEffortLabel(snapshot.settings.effort)}
          model={snapshot.settings.model ?? "Codex 当前值"}
          revision={snapshot.settings.revision}
          sandbox={sandboxSettingLabel(snapshot.settings.sandbox)}
          status={thread.status}
          statusLabel={threadStateLabel(thread.status)}
          onEdit={() => setSettingsOpen(true)}
        />
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
        <TimelineViewport
          ref={timelineViewportRef}
          hasEarlierHistory={snapshot.hasEarlierHistory}
          historyDisabled={thread.refreshing === true}
          historyError={thread.historyError}
          historyStatus={thread.historyStatus}
          items={snapshot.items}
          key={threadId}
          onActiveUserItemChange={setActiveOutlineItemId}
          onLoadEarlier={() => {
            runtime.thread.dispatch({ type: "LOAD_EARLIER" });
            return runtime.thread.getSnapshot().historyStatus === "loading";
          }}
        />
        <section className="composer-dock">
          {snapshot.interactions.map((interaction) => (
            <InteractionCard interaction={interaction} key={interaction.id} />
          ))}
          {composerBusyElsewhere ? (
            <StatusMessage tone="warning">
              {composer.status === "manual-review"
                ? "另一个任务的发送结果需要人工核对。"
                : "另一个任务正在发送或确认消息；你可以继续编辑此处草稿，完成后再发送。"}
              <Link
                to={`/tasks/${encodeURIComponent(composer.threadId ?? "")}`}
              >
                查看对应任务
              </Link>
            </StatusMessage>
          ) : null}
          {composer.status === "manual-review" &&
          composer.threadId === threadId ? (
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
          {composer.status === "idle" &&
          composer.threadId === threadId &&
          composer.error !== undefined ? (
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
              value={composerDraft}
              onChange={(event) =>
                runtime.composer.dispatch({
                  type: "DRAFT",
                  threadId,
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
                    composerDraft.trim().length === 0
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
                  composerDraft.trim().length === 0
                }
                type="submit"
              >
                <Icon name="send" />
                {composer.status === "submitting" ? "发送中…" : "发送"}
              </button>
            </div>
          </form>
          <div className="composer-meta">
            <Link
              aria-label={`查看 Queue，当前 ${taskQueue.length} 项`}
              className={taskQueue.length > 0 ? "has-items" : undefined}
              to="/queue"
            >
              <Icon name="queue" />
              <span>Queue</span>
              <strong>{taskQueue.length}</strong>
            </Link>
            <span>按 Ctrl/⌘ + Enter 发送</span>
          </div>
        </section>
      </section>
      {settingsOpen ? (
        <ThreadSettingsPanel
          settings={snapshot.settings}
          threadId={threadId}
          onClose={() => setSettingsOpen(false)}
          onSaved={(settings) => {
            if (activeThreadId.current === threadId) {
              setTaskNotice(
                `任务设置已保存 · ${sandboxSettingLabel(settings.sandbox)} · ${approvalSettingLabel(settings.approvalPolicy)}`,
              );
            }
          }}
        />
      ) : null}
      {outlineOpen ? (
        <ConversationOutlineDialog
          activeItemId={activeOutlineItemId}
          entries={outlineEntries}
          hasEarlierHistory={snapshot.hasEarlierHistory}
          historyDisabled={thread.refreshing === true}
          historyStatus={thread.historyStatus}
          onClose={() => setOutlineOpen(false)}
          onLoadEarlier={() => timelineViewportRef.current?.loadEarlier()}
          onSelect={(itemId) => {
            if (timelineViewportRef.current?.scrollToItem(itemId) === true) {
              setOutlineOpen(false);
            }
          }}
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
