import { useEffect, useState, type FormEvent } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { durableMutation } from "../../gateway/durable-mutation.js";
import { queryOptions } from "../../gateway/gateway-port.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";

type Workspace = OutputOf<"workspace/list">["workspaces"][number];

export function WorkspacesPage() {
  const runtime = useRuntime();
  const [items, setItems] = useState<readonly Workspace[]>([]);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState<string>();
  const [refreshWarning, setRefreshWarning] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = async () => {
    const result = await runtime.gateway.request(
      "workspace/list",
      { version: 1 },
      queryOptions(),
    );
    setItems(result.workspaces);
  };
  useEffect(() => {
    void load().catch((reason) => setError(message(reason)));
  }, [runtime]);

  const mutate = async <Result,>(
    operation: () => Promise<Result>,
    success: string,
  ): Promise<boolean> => {
    setBusy(true);
    setReconciling(false);
    setError(undefined);
    setRefreshWarning(undefined);
    setNotice(undefined);
    const outcome = await completeWorkspaceMutation(operation, load);
    try {
      if (outcome.status === "failed") {
        setError(message(outcome.error));
        return false;
      }
      runtime.refreshTasks();
      setNotice(success);
      if (outcome.refreshError !== undefined) {
        setRefreshWarning(
          `操作已完成，但工作区列表刷新失败。当前列表可能不是最新状态；请重新进入此页面后核对。刷新错误：${message(outcome.refreshError)}`,
        );
      }
      return true;
    } finally {
      setBusy(false);
      setReconciling(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const completed = await mutate(
      () =>
        durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "workspace/add",
          payload: {
            version: 1,
            path,
            ...(label.trim().length === 0 ? {} : { label: label.trim() }),
          },
          onOutcomeUnknown: () => setReconciling(true),
        }),
      "工作区已添加。",
    );
    if (completed) {
      setPath("");
      setLabel("");
    }
  };

  const setDefault = (workspaceId: string) =>
    mutate(
      () =>
        durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "workspace/default/update",
          payload: { version: 1, workspaceId },
          onOutcomeUnknown: () => setReconciling(true),
        }),
      "默认工作区已更新。",
    );

  const remove = (workspace: Workspace) =>
    mutate(
      () =>
        durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "workspace/remove",
          payload: {
            version: 1,
            workspaceId: workspace.id,
            expectedRevision: workspace.revision,
          },
          onOutcomeUnknown: () => setReconciling(true),
        }),
      "工作区授权已移除，磁盘文件未被删除。",
    );

  return (
    <main className="page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">已授权目录</p>
          <h1>工作区</h1>
          <p>所有路径先 realpath，再校验是否位于授权根中。</p>
        </div>
      </header>
      <form className="inline-form" onSubmit={(event) => void add(event)}>
        <input
          aria-label="工作区路径"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/public/project"
          required
        />
        <input
          aria-label="工作区显示名称"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="显示名称（可选）"
        />
        <button className="primary" disabled={busy} type="submit">
          {busy ? "正在处理…" : "添加"}
        </button>
      </form>
      {reconciling ? (
        <StatusMessage tone="warning">
          正在确认工作区操作结果；不会自动重复提交。
        </StatusMessage>
      ) : null}
      {error === undefined ? null : (
        <StatusMessage tone="error">{error}</StatusMessage>
      )}
      {notice === undefined ? null : (
        <StatusMessage tone="success">{notice}</StatusMessage>
      )}
      {refreshWarning === undefined ? null : (
        <StatusMessage tone="warning">{refreshWarning}</StatusMessage>
      )}
      <section className="list-panel">
        {items.map((workspace) => (
          <article className="workspace-row" key={workspace.id}>
            <div>
              <strong>{workspace.label}</strong>
              <code>{workspace.path}</code>
            </div>
            {workspace.isDefault ? (
              <span className="badge">默认</span>
            ) : (
              <button
                disabled={busy}
                type="button"
                onClick={() => void setDefault(workspace.id)}
              >
                设为默认
              </button>
            )}
            <button
              disabled={busy}
              type="button"
              onClick={() => void remove(workspace)}
            >
              移除
            </button>
          </article>
        ))}
        {items.length === 0 ? (
          <div className="empty-state">
            <strong>还没有工作区</strong>
            <span>添加一个 Codex 可以访问的绝对路径。</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export async function completeWorkspaceMutation<Result>(
  operation: () => Promise<Result>,
  refresh: () => Promise<void>,
): Promise<
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "completed"; readonly refreshError?: unknown }
> {
  try {
    await operation();
  } catch (error) {
    return { status: "failed", error };
  }
  try {
    await refresh();
    return { status: "completed" };
  } catch (refreshError) {
    return { status: "completed", refreshError };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "工作区操作失败";
}
