import { useState, type FormEvent } from "react";
import {
  GatewayRemoteError,
  type InputOf,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import {
  durableMutation,
  MutationNeedsReviewError,
} from "../../gateway/durable-mutation.js";
import { useRuntime } from "../runtime-context.js";

type ThreadSettings = OutputOf<"thread/open">["settings"];
type ThreadSettingsPatch = InputOf<"thread/settings/update">["patch"];

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
      const patch = changedSettings(input.settings, {
        model,
        effort,
        sandbox,
        approvalPolicy,
      });
      if (Object.keys(patch).length === 0) return;
      await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/settings/update",
        payload: {
          version: 1,
          threadId: input.threadId,
          expectedRevision: input.settings.revision,
          patch,
        },
      });
      runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
    } catch (reason) {
      runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
      setError(settingsError(reason));
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
            <option value="max">max</option>
            <option value="ultra">ultra</option>
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
        {error === undefined ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}

export function changedSettings(
  current: ThreadSettings,
  draft: {
    readonly model: string;
    readonly effort: string;
    readonly sandbox: string;
    readonly approvalPolicy: string;
  },
): ThreadSettingsPatch {
  const model = draft.model.trim();
  return {
    ...(model.length > 0 && model !== current.model ? { model } : {}),
    ...(draft.effort.length > 0 && draft.effort !== current.effort
      ? { effort: draft.effort }
      : {}),
    ...(isSandbox(draft.sandbox) && draft.sandbox !== current.sandbox
      ? { sandbox: draft.sandbox }
      : {}),
    ...(isApprovalPolicy(draft.approvalPolicy) &&
    draft.approvalPolicy !== current.approvalPolicy
      ? { approvalPolicy: draft.approvalPolicy }
      : {}),
  };
}

function settingsError(reason: unknown): string {
  if (reason instanceof MutationNeedsReviewError) {
    return `${reason.message} 已重新同步当前设置，请核对后再操作。`;
  }
  if (
    reason instanceof GatewayRemoteError &&
    reason.code === "CODEX_REQUEST_REJECTED"
  ) {
    return "Codex 拒绝了本次设置更新；当前设置已重新同步。";
  }
  return reason instanceof Error ? reason.message : "任务设置保存失败";
}

function isSandbox(
  value: string,
): value is "read-only" | "workspace-write" | "danger-full-access" {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

function isApprovalPolicy(
  value: string,
): value is "untrusted" | "on-request" | "never" {
  return value === "untrusted" || value === "on-request" || value === "never";
}
