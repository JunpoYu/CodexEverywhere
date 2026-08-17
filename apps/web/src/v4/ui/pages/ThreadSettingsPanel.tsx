import { useState, type FormEvent } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import { durableMutation } from "../../gateway/durable-mutation.js";
import { useRuntime } from "../runtime-context.js";

type ThreadSettings = OutputOf<"thread/open">["settings"];

export function ThreadSettingsPanel(input: {
  readonly threadId: string;
  readonly settings: ThreadSettings;
}) {
  const runtime = useRuntime();
  const [model, setModel] = useState(input.settings.model ?? "");
  const [effort, setEffort] = useState(input.settings.effort ?? "");
  const [sandbox, setSandbox] = useState(input.settings.sandbox ?? "");
  const [approvalPolicy, setApprovalPolicy] = useState(
    input.settings.approvalPolicy ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/settings/update",
        payload: {
          version: 1,
          threadId: input.threadId,
          expectedRevision: input.settings.revision,
          patch: {
            ...(model.trim().length === 0 ? {} : { model: model.trim() }),
            ...(effort.length === 0 ? {} : { effort }),
            ...(sandbox.length === 0
              ? {}
              : {
                  sandbox: sandbox as
                    "read-only" | "workspace-write" | "danger-full-access",
                }),
            ...(approvalPolicy.length === 0
              ? {}
              : {
                  approvalPolicy: approvalPolicy as
                    "untrusted" | "on-request" | "never",
                }),
          },
        },
      });
      runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务设置保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="thread-settings">
      <summary>本任务设置</summary>
      <form onSubmit={save}>
        <label>
          模型
          <input
            placeholder="继承默认模型"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label>
          推理强度
          <select
            value={effort}
            onChange={(event) => setEffort(event.target.value)}
          >
            <option value="">继承默认值</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </label>
        <label>
          Sandbox
          <select
            value={sandbox}
            onChange={(event) => setSandbox(event.target.value)}
          >
            <option value="">继承默认值</option>
            <option value="read-only">只读</option>
            <option value="workspace-write">工作区可写</option>
            <option value="danger-full-access">完全访问</option>
          </select>
        </label>
        <label>
          审批策略
          <select
            value={approvalPolicy}
            onChange={(event) => setApprovalPolicy(event.target.value)}
          >
            <option value="">继承默认值</option>
            <option value="untrusted">不信任</option>
            <option value="on-request">按需询问</option>
            <option value="never">从不询问</option>
          </select>
        </label>
        <button className="primary" disabled={busy} type="submit">
          保存
        </button>
        {error === undefined ? null : <p className="error">{error}</p>}
      </form>
    </details>
  );
}
