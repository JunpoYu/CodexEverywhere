import { useEffect, useState, type FormEvent } from "react";
import {
  GatewayRemoteError,
  type InputOf,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import {
  durableMutation,
  MutationNeedsReviewError,
} from "../../gateway/durable-mutation.js";
import { Icon } from "../components/Icon.js";
import { ModalDialog } from "../components/ModalDialog.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";
import styles from "./ThreadSettingsPanel.module.css";

type ThreadSettings = OutputOf<"thread/open">["settings"];
type ThreadSettingsPatch = InputOf<"thread/settings/update">["patch"];
type SaveState = "idle" | "saving" | "reconciling" | "saved" | "error";

export function ThreadSettingsPanel(input: {
  readonly onClose: () => void;
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
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string>();

  useEffect(() => {
    setModel(input.settings.model ?? "");
    setEffort(input.settings.effort ?? "");
    setSandbox(input.settings.sandbox ?? "");
    setApprovalPolicy(input.settings.approvalPolicy ?? "");
  }, [input.settings.revision]);

  const draft = { model, effort, sandbox, approvalPolicy };
  const patch = changedSettings(input.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const busy = saveState === "saving" || saveState === "reconciling";

  const updateDraft = (change: () => void) => {
    change();
    setSaveState("idle");
    setError(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setSaveState("saving");
    setError(undefined);
    try {
      const settings = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "thread/settings/update",
        payload: {
          version: 1,
          threadId: input.threadId,
          expectedRevision: input.settings.revision,
          patch,
        },
        onOutcomeUnknown: () => setSaveState("reconciling"),
      });
      runtime.thread.dispatch({
        type: "SETTINGS_UPDATED",
        threadId: input.threadId,
        settings,
      });
      setModel(settings.model ?? "");
      setEffort(settings.effort ?? "");
      setSandbox(settings.sandbox ?? "");
      setApprovalPolicy(settings.approvalPolicy ?? "");
      setSaveState("saved");
    } catch (reason) {
      setSaveState("error");
      setError(settingsError(reason));
      if (
        reason instanceof MutationNeedsReviewError ||
        (reason instanceof GatewayRemoteError &&
          reason.code === "CODEX_REQUEST_REJECTED")
      ) {
        runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
      }
    }
  };

  const close = () => {
    if (!busy) input.onClose();
  };

  return (
    <ModalDialog
      aria-describedby="thread-settings-description"
      aria-labelledby="thread-settings-title"
      className={`ce-dialog ${styles.dialog}`}
      {...(dirty ? {} : { onRequestClose: close })}
    >
      <header className={styles.header}>
        <div>
          <span className={styles.kicker}>仅影响当前任务</span>
          <h2 id="thread-settings-title">任务权限与运行设置</h2>
          <p id="thread-settings-description">
            修改会立即同步给 Codex；保存成功前不会假定设置已生效。
          </p>
        </div>
        <button
          aria-label="关闭任务设置"
          className={styles.close}
          disabled={busy || dirty}
          title={dirty ? "请使用“放弃更改”关闭" : undefined}
          type="button"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </header>

      <form className={styles.form} onSubmit={(event) => void save(event)}>
        <fieldset className={styles.group}>
          <legend>文件访问范围</legend>
          <p>决定 Codex 能够读取或修改哪些文件。</p>
          <div className={styles.options}>
            {input.settings.sandbox === undefined ? (
              <Choice
                checked={sandbox === ""}
                description="暂不覆盖 Codex 当前值"
                label="保持当前"
                name="sandbox"
                value=""
                onChange={(value) => updateDraft(() => setSandbox(value))}
              />
            ) : null}
            <Choice
              checked={sandbox === "read-only"}
              description="允许读取，但不允许修改文件"
              label="只读"
              name="sandbox"
              value="read-only"
              onChange={(value) => updateDraft(() => setSandbox(value))}
            />
            <Choice
              checked={sandbox === "workspace-write"}
              description="可修改工作区，工作区外仍受保护"
              label="工作区可写"
              name="sandbox"
              value="workspace-write"
              onChange={(value) => updateDraft(() => setSandbox(value))}
            />
            <Choice
              checked={sandbox === "danger-full-access"}
              description="可访问此 Linux 用户有权访问的全部路径"
              label="完全访问"
              name="sandbox"
              tone="danger"
              value="danger-full-access"
              onChange={(value) => updateDraft(() => setSandbox(value))}
            />
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend>审批策略</legend>
          <p>决定 Codex 在执行可能产生副作用的操作前何时询问你。</p>
          <div className={styles.options}>
            {input.settings.approvalPolicy === undefined ? (
              <Choice
                checked={approvalPolicy === ""}
                description="暂不覆盖 Codex 当前值"
                label="保持当前"
                name="approval"
                value=""
                onChange={(value) =>
                  updateDraft(() => setApprovalPolicy(value))
                }
              />
            ) : null}
            <Choice
              checked={approvalPolicy === "untrusted"}
              description="未受信任的操作需要你确认"
              label="严格审批"
              name="approval"
              value="untrusted"
              onChange={(value) => updateDraft(() => setApprovalPolicy(value))}
            />
            <Choice
              checked={approvalPolicy === "on-request"}
              description="Codex 判断需要时再请求确认"
              label="按需询问"
              name="approval"
              value="on-request"
              onChange={(value) => updateDraft(() => setApprovalPolicy(value))}
            />
            <Choice
              checked={approvalPolicy === "never"}
              description="不弹出审批；受限操作可能直接失败"
              label="从不询问"
              name="approval"
              tone="danger"
              value="never"
              onChange={(value) => updateDraft(() => setApprovalPolicy(value))}
            />
          </div>
        </fieldset>

        <details className={styles.advanced}>
          <summary>
            模型与推理强度 <Icon name="chevron-down" />
          </summary>
          <div>
            <label>
              <span>模型</span>
              <small>留空会保持当前模型。</small>
              <input
                placeholder={input.settings.model ?? "保持当前模型"}
                value={model}
                onChange={(event) =>
                  updateDraft(() => setModel(event.target.value))
                }
              />
            </label>
            <label>
              <span>推理强度</span>
              <small>较高强度通常更慢，并消耗更多 token。</small>
              <select
                value={effort}
                onChange={(event) =>
                  updateDraft(() => setEffort(event.target.value))
                }
              >
                {input.settings.effort === undefined ? (
                  <option value="">保持当前值</option>
                ) : null}
                <option value="low">低</option>
                <option value="medium">中</option>
                <option value="high">高</option>
                <option value="xhigh">很高</option>
                <option value="max">最大</option>
                <option value="ultra">Ultra</option>
              </select>
            </label>
          </div>
        </details>

        {sandbox === "danger-full-access" || approvalPolicy === "never" ? (
          <StatusMessage tone="warning">
            当前组合会减少保护或人工确认。请只在你信任任务内容和工作区时使用。
          </StatusMessage>
        ) : null}
        {saveState === "saved" ? (
          <StatusMessage tone="success">
            设置已保存，并已应用到当前任务。
          </StatusMessage>
        ) : null}
        {error === undefined ? null : (
          <StatusMessage tone="error">{error}</StatusMessage>
        )}

        <footer className={styles.actions}>
          <span className={styles.changeState} aria-live="polite">
            {busy
              ? saveState === "reconciling"
                ? "正在确认宿主机结果…"
                : "正在保存…"
              : dirty
                ? "有未保存的更改"
                : saveState === "saved"
                  ? "已保存到宿主机"
                  : "没有未保存的更改"}
          </span>
          <button disabled={busy} type="button" onClick={close}>
            {dirty ? "放弃更改" : "关闭"}
          </button>
          <button className="primary" disabled={!dirty || busy} type="submit">
            {saveState === "saving"
              ? "正在保存…"
              : saveState === "reconciling"
                ? "正在确认…"
                : "保存更改"}
          </button>
        </footer>
      </form>
    </ModalDialog>
  );
}

function Choice(input: {
  readonly checked: boolean;
  readonly description: string;
  readonly label: string;
  readonly name: string;
  readonly onChange: (value: string) => void;
  readonly tone?: "danger";
  readonly value: string;
}) {
  return (
    <label
      className={`${styles.choice} ${input.checked ? styles.selected : ""} ${input.tone === "danger" ? styles.danger : ""}`}
    >
      <input
        checked={input.checked}
        name={input.name}
        type="radio"
        value={input.value}
        onChange={(event) => input.onChange(event.target.value)}
      />
      <span>
        <strong>{input.label}</strong>
        <small>{input.description}</small>
      </span>
    </label>
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
    return "无法自动确认本次保存结果。CE 正在重新读取任务设置，请核对后再重试。";
  }
  if (
    reason instanceof GatewayRemoteError &&
    reason.code === "CODEX_REQUEST_REJECTED"
  ) {
    return "Codex 未接受这组设置。CE 已重新读取当前值；请调整组合后重试。";
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
