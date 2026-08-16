import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { queryOptions } from "../../gateway/gateway-port.js";
import { useRuntime } from "../runtime-context.js";

export function TasksPage() {
  const runtime = useRuntime();
  const tasks = useActorState(runtime.tasks);
  const [workspaces, setWorkspaces] = useState<
    Awaited<ReturnType<typeof loadWorkspaces>>
  >([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState<
    "idle" | "submitting" | "reconciling"
  >("idle");
  const [error, setError] = useState<string>();
  const navigate = useNavigate();

  useEffect(() => {
    void loadWorkspaces(runtime.gateway).then((items) => {
      setWorkspaces(items);
      setWorkspaceId(
        items.find((workspace) => workspace.isDefault)?.id ??
          items[0]?.id ??
          "",
      );
    });
  }, [runtime]);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (workspaceId.length === 0 || prompt.trim().length === 0) return;
    setStarting("submitting");
    setError(undefined);
    try {
      const result = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/start",
        payload: { version: 1, workspaceId, prompt: prompt.trim() },
        onOutcomeUnknown: () => setStarting("reconciling"),
      });
      runtime.tasks.dispatch({ type: "LOAD" });
      navigate(`/tasks/${encodeURIComponent(result.thread.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务创建失败");
    } finally {
      setStarting("idle");
    }
  };

  return (
    <main className="page tasks-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Codex app-server threads</p>
          <h1>任务</h1>
          <p>任务历史和执行状态直接来自 Codex app-server。</p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            onClick={() =>
              runtime.tasks.dispatch({
                type: "LOAD",
                archived: !tasks.archived,
              })
            }
          >
            {tasks.archived ? "查看当前任务" : "查看已归档"}
          </button>
          <button
            type="button"
            onClick={() =>
              runtime.tasks.dispatch({ type: "LOAD", archived: tasks.archived })
            }
          >
            刷新
          </button>
        </div>
      </header>

      <form className="new-task-card" onSubmit={(event) => void start(event)}>
        <select
          aria-label="工作区"
          value={workspaceId}
          onChange={(event) => setWorkspaceId(event.target.value)}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.label}
            </option>
          ))}
        </select>
        <textarea
          rows={3}
          placeholder="描述你希望 Codex 完成的工作…"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <button
          className="primary"
          type="submit"
          disabled={starting !== "idle" || workspaceId.length === 0}
        >
          {starting === "reconciling"
            ? "正在确认创建结果…"
            : starting === "submitting"
              ? "正在创建…"
              : "新建任务"}
        </button>
      </form>
      {starting === "reconciling" ? (
        <p className="warning mutation-outcome-pending">
          连接中断，正在按 operation key 查询宿主机结果；不会重复创建任务。
        </p>
      ) : null}
      {error === undefined ? null : <p className="error">{error}</p>}

      <section className="task-grid" aria-busy={tasks.status === "loading"}>
        {tasks.tasks.map((task) => (
          <Link
            className="task-card"
            key={task.id}
            to={`/tasks/${encodeURIComponent(task.id)}`}
          >
            <div>
              <i className={`task-dot ${task.state}`} />
              <span>{stateLabel(task.state)}</span>
            </div>
            <h2>{task.title || "未命名任务"}</h2>
            <p>{new Date(task.updatedAt).toLocaleString("zh-CN")}</p>
          </Link>
        ))}
        {tasks.status === "ready" && tasks.tasks.length === 0 ? (
          <div className="empty-state">
            <strong>{tasks.archived ? "没有已归档任务" : "还没有任务"}</strong>
            <span>
              {tasks.archived
                ? "归档后的任务会显示在这里。"
                : "从上方输入第一条请求。"}
            </span>
          </div>
        ) : null}
      </section>
      {tasks.hasMore ? (
        <button
          type="button"
          onClick={() => runtime.tasks.dispatch({ type: "MORE" })}
        >
          加载更多
        </button>
      ) : null}
    </main>
  );
}

async function loadWorkspaces(
  gateway: import("../../gateway/gateway-port.js").GatewayPort,
) {
  return (
    await gateway.request("workspace/list", { version: 1 }, queryOptions())
  ).workspaces;
}

function stateLabel(state: string): string {
  return state === "running"
    ? "运行中"
    : state === "waiting-input"
      ? "等待操作"
      : state === "failed"
        ? "失败"
        : "空闲";
}
