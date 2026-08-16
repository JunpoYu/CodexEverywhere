import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { mutationOptions } from "../../gateway/gateway-port.js";
import { InteractionCard } from "../interactions/InteractionCard.js";
import { useRuntime } from "../runtime-context.js";
import { ThreadSettingsPanel } from "./ThreadSettingsPanel.js";

const MarkdownContent = lazy(() => import("../timeline/MarkdownContent.js"));

export function TaskPage() {
  const { threadId = "" } = useParams();
  const runtime = useRuntime();
  const navigate = useNavigate();
  const thread = useActorState(runtime.thread);
  const composer = useActorState(runtime.composer);
  const [handoff, setHandoff] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [renameTitle, setRenameTitle] = useState<string>();
  const [taskMutating, setTaskMutating] = useState(false);

  useEffect(() => {
    if (threadId.length > 0)
      runtime.thread.dispatch({ type: "OPEN", threadId });
    return () => runtime.thread.dispatch({ type: "CLOSE" });
  }, [runtime, threadId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
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
    if (!window.confirm("永久删除这个 Codex 任务？此操作无法从 CE 恢复。"))
      return;
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
      <header className="conversation-header">
        <div>
          <p className="eyebrow">任务</p>
          <h1>{snapshot.thread.title || "未命名任务"}</h1>
        </div>
        <div className="conversation-actions">
          {thread.status === "running" ? (
            <button type="button" onClick={() => void interrupt()}>
              中断
            </button>
          ) : null}
          <button type="button" onClick={() => void tuiHandoff()}>
            转到 TUI
          </button>
          <button
            disabled={taskMutating}
            type="button"
            onClick={() => setRenameTitle(snapshot.thread.title)}
          >
            重命名
          </button>
          <button
            disabled={taskMutating || thread.status === "running"}
            type="button"
            onClick={() => void archive(snapshot.thread.archived)}
          >
            {snapshot.thread.archived ? "取消归档" : "归档"}
          </button>
          <button
            disabled={taskMutating || thread.status === "running"}
            type="button"
            onClick={() => void deleteTask()}
          >
            删除
          </button>
          <span className={`state-pill ${thread.status}`}>{thread.status}</span>
        </div>
      </header>
      {actionError === undefined ? null : (
        <p className="error">{actionError}</p>
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
          <article className={`timeline-item type-${item.type}`} key={item.id}>
            <header>
              <span>{itemLabel(item.type, item.data.role)}</span>
              {item.createdAt ? (
                <time>
                  {new Date(item.createdAt).toLocaleTimeString("zh-CN")}
                </time>
              ) : null}
            </header>
            {typeof item.data.text === "string" ? (
              <Suspense fallback={<pre>{item.data.text}</pre>}>
                <MarkdownContent text={item.data.text} />
              </Suspense>
            ) : (
              <pre className="structured-event">
                {JSON.stringify(item.data, null, 2)}
              </pre>
            )}
          </article>
        ))}
      </section>
      <section className="composer-dock">
        <ThreadSettingsPanel
          key={snapshot.settings.revision}
          settings={snapshot.settings}
          threadId={threadId}
        />
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
          <p className="error" role="alert">
            {composer.error}
          </p>
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
              disabled={composer.status !== "idle" || thread.status !== "idle"}
              type="submit"
            >
              {composer.status === "submitting" ? "发送中…" : "发送"}
            </button>
          </div>
        </form>
      </section>
      {handoff === undefined ? null : (
        <dialog className="ce-dialog" open aria-labelledby="tui-handoff-title">
          <h2 id="tui-handoff-title">在 HPC 终端继续</h2>
          <p>此命令只接管官方 TUI，不会中断正在运行的 turn。</p>
          <pre>{handoff}</pre>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(handoff)}
            >
              复制
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => setHandoff(undefined)}
            >
              关闭
            </button>
          </div>
        </dialog>
      )}
    </main>
  );
}

function itemLabel(type: string, role: unknown): string {
  if (type === "message") return role === "user" ? "你" : "Codex";
  const labels: Record<string, string> = {
    plan: "计划",
    command: "命令",
    "file-change": "文件修改",
    mcp: "MCP",
    subagent: "Subagent",
    error: "错误",
    generic: "事件",
  };
  return labels[type] ?? type;
}
