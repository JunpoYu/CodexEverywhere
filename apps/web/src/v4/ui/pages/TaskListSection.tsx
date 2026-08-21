import { Link } from "react-router-dom";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import type { TaskListState } from "../../actors/task-list-actor.js";
import { Icon } from "../components/Icon.js";
import styles from "./TaskListSection.module.css";

type Workspace = OutputOf<"workspace/list">["workspaces"][number];

export function TaskListSection(input: {
  readonly state: TaskListState;
  readonly workspaces: readonly Workspace[];
  readonly onLoadMore: () => void;
  readonly onWorkspaceChange: (workspace: Workspace | undefined) => void;
}) {
  const { state, workspaces } = input;
  return (
    <section aria-labelledby="task-list-heading" className={styles.section}>
      <header className={styles.toolbar}>
        <div>
          <h2 id="task-list-heading">
            {state.archived ? "已归档任务" : "当前任务"}
          </h2>
          <p>
            {state.workspaceLabel ?? "全部工作区"}
            {state.status === "ready"
              ? ` · 已显示 ${state.tasks.length} 个${state.hasMore ? "，还有更多" : ""}`
              : " · 正在更新"}
          </p>
        </div>
        <label className={styles.workspaceFilter}>
          <span>筛选工作区</span>
          <select
            aria-label="筛选任务工作区"
            disabled={workspaces.length === 0}
            value={state.workspaceId ?? ""}
            onChange={(event) => {
              input.onWorkspaceChange(
                workspaces.find(
                  (workspace) => workspace.id === event.target.value,
                ),
              );
            }}
          >
            <option value="">全部工作区</option>
            {state.workspaceId !== undefined &&
            !workspaces.some(
              (workspace) => workspace.id === state.workspaceId,
            ) ? (
              <option value={state.workspaceId}>
                {state.workspaceLabel ?? "当前工作区"}
              </option>
            ) : null}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.label}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div
        aria-label={state.archived ? "已归档任务" : "当前任务"}
        className={styles.grid}
        data-task-grid
        aria-busy={state.status === "loading"}
      >
        {state.tasks.map((task) => {
          const workspace = workspaces.find(
            (candidate) => candidate.id === task.workspaceId,
          );
          return (
            <Link
              className={styles.card}
              data-task-card
              key={task.id}
              to={`/tasks/${encodeURIComponent(task.id)}`}
            >
              <div className={styles.state}>
                <i className={styles.dot} data-state={task.state} />
                <span>{stateLabel(task.state)}</span>
              </div>
              <div className={styles.copy}>
                <h2>{task.title || "未命名任务"}</h2>
                <span
                  className={styles.workspaceName}
                  title={workspace?.path ?? task.workspaceId}
                >
                  <Icon name="workspace" />
                  {workspace?.label ?? "未知工作区"}
                </span>
              </div>
              <time dateTime={task.updatedAt}>
                {new Date(task.updatedAt).toLocaleString("zh-CN")}
              </time>
            </Link>
          );
        })}
        {state.status === "loading" && state.tasks.length === 0 ? (
          <div className="empty-state">
            <strong>正在读取任务…</strong>
            <span>历史较多时，Codex app-server 首次索引可能需要片刻。</span>
          </div>
        ) : state.status === "ready" && state.tasks.length === 0 ? (
          <div className="empty-state">
            <strong>{emptyStateTitle(state)}</strong>
            <span>{emptyStateDescription(state)}</span>
          </div>
        ) : null}
      </div>
      {state.hasMore ? (
        <button
          disabled={state.status === "paginating"}
          type="button"
          onClick={input.onLoadMore}
        >
          {state.status === "paginating" ? "正在加载…" : "加载更多"}
        </button>
      ) : null}
    </section>
  );
}

function emptyStateTitle(state: TaskListState): string {
  if (state.workspaceLabel !== undefined) {
    return `${state.workspaceLabel} 中没有${state.archived ? "已归档" : "当前"}任务`;
  }
  return state.archived ? "没有已归档任务" : "还没有任务";
}

function emptyStateDescription(state: TaskListState): string {
  if (state.archived) return "归档后的任务会显示在这里。";
  return state.workspaceLabel === undefined
    ? "从上方输入第一条请求。"
    : "可以在该工作区创建新任务，或切换回全部工作区。";
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
