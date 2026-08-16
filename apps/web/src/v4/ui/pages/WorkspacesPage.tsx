import { useEffect, useState, type FormEvent } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { durableMutation } from "../../gateway/durable-mutation.js";
import { queryOptions } from "../../gateway/gateway-port.js";
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
  const load = () =>
    void runtime.gateway
      .request("workspace/list", { version: 1 }, queryOptions())
      .then((result) => setItems(result.workspaces))
      .catch((reason) => setError(message(reason)));
  useEffect(load, [runtime]);

  const mutate = async <Result,>(
    operation: () => Promise<Result>,
  ): Promise<boolean> => {
    setBusy(true);
    setReconciling(false);
    setError(undefined);
    try {
      await operation();
      load();
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setBusy(false);
      setReconciling(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const completed = await mutate(() =>
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
    );
    if (completed) {
      setPath("");
      setLabel("");
    }
  };

  const setDefault = (workspaceId: string) =>
    mutate(() =>
      durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "workspace/default/update",
        payload: { version: 1, workspaceId },
        onOutcomeUnknown: () => setReconciling(true),
      }),
    );

  const remove = (workspace: Workspace) =>
    mutate(() =>
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
    );

  return (
    <main className="page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Authorized roots</p>
          <h1>工作区</h1>
          <p>所有路径先 realpath，再校验是否位于授权根中。</p>
        </div>
      </header>
      <form className="inline-form" onSubmit={(event) => void add(event)}>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/public/project"
          required
        />
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="显示名称（可选）"
        />
        <button className="primary" disabled={busy} type="submit">
          添加
        </button>
      </form>
      {reconciling ? (
        <p className="warning mutation-outcome-pending">
          正在确认工作区操作结果；不会自动重复提交。
        </p>
      ) : null}
      {error === undefined ? null : <p className="error">{error}</p>}
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
      </section>
    </main>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "工作区操作失败";
}
