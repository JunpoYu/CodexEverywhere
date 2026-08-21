import { useEffect, useRef, useState, type FormEvent } from "react";

import { durableMutation } from "../../gateway/durable-mutation.js";
import { useActorState } from "../../actors/use-actor.js";
import { Icon } from "../components/Icon.js";
import { ModalDialog } from "../components/ModalDialog.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";
import {
  changedThreadSettings,
  hasThreadSettingsChanges,
  resolveThreadSettingsConflict,
  settingsErrorMessage,
  settingsFailureRecovery,
  type ThreadSettings,
  type ThreadSettingsDraft,
  type ThreadSettingsPatch,
} from "./thread-settings-model.js";
import styles from "./ThreadSettingsPanel.module.css";

type SaveState =
  | "idle"
  | "saving"
  | "reconciling"
  | "saved"
  | "conflict"
  | "refreshing-conflict"
  | "refresh-failed"
  | "error";

export function ThreadSettingsPanel(input: {
  readonly onClose: () => void;
  readonly onSaved: (settings: ThreadSettings) => void;
  readonly threadId: string;
  readonly settings: ThreadSettings;
}) {
  const runtime = useRuntime();
  const thread = useActorState(runtime.thread);
  const [model, setModel] = useState(input.settings.model ?? "");
  const [effort, setEffort] = useState(input.settings.effort ?? "");
  const [sandbox, setSandbox] = useState(input.settings.sandbox ?? "");
  const [approvalPolicy, setApprovalPolicy] = useState(
    input.settings.approvalPolicy ?? "",
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const conflictPatch = useRef<ThreadSettingsPatch | undefined>(undefined);
  const draftThreadId = useRef(input.threadId);

  useEffect(() => {
    const threadChanged = draftThreadId.current !== input.threadId;
    draftThreadId.current = input.threadId;
    const pendingPatch = threadChanged ? undefined : conflictPatch.current;
    if (threadChanged) {
      conflictPatch.current = undefined;
      setSaveState("idle");
      setError(undefined);
      setWarning(undefined);
    }
    const resolution = resolveThreadSettingsConflict(
      input.settings,
      pendingPatch,
    );
    const next = resolution.draft;
    setModel(next.model);
    setEffort(next.effort);
    setSandbox(next.sandbox);
    setApprovalPolicy(next.approvalPolicy);
    if (pendingPatch !== undefined) {
      conflictPatch.current = resolution.remainingPatch;
      setSaveState("conflict");
      setError(undefined);
      setWarning(
        resolution.remainingPatch !== undefined
          ? "其他设备或 TUI 已修改设置。CE 已读取最新 revision，并在其上保留你的更改；请确认后再次保存。"
          : "其他设备或 TUI 已应用相同设置。CE 已同步宿主机最新值，无需再次保存。",
      );
    }
  }, [input.settings.revision, input.threadId]);

  useEffect(() => {
    if (
      saveState === "refreshing-conflict" &&
      thread.threadId === input.threadId &&
      thread.refreshing !== true &&
      thread.error !== undefined
    ) {
      setSaveState("refresh-failed");
      setError(
        "检测到设置版本冲突，但读取宿主机最新值失败。请先重新同步，不要重复提交。",
      );
    }
  }, [
    input.threadId,
    saveState,
    thread.error,
    thread.refreshing,
    thread.threadId,
  ]);

  const draft = { model, effort, sandbox, approvalPolicy };
  const patch = changedThreadSettings(input.settings, draft);
  const dirty = Object.keys(patch).length > 0;
  const busy =
    saveState === "saving" ||
    saveState === "reconciling" ||
    saveState === "refreshing-conflict";
  const locked = busy || saveState === "refresh-failed";

  const updateDraft = (change: Partial<ThreadSettingsDraft>) => {
    if (locked) return;
    const next = { ...draft, ...change };
    setModel(next.model);
    setEffort(next.effort);
    setSandbox(next.sandbox);
    setApprovalPolicy(next.approvalPolicy);
    const nextPatch = changedThreadSettings(input.settings, next);
    conflictPatch.current = hasThreadSettingsChanges(nextPatch)
      ? nextPatch
      : undefined;
    setSaveState("idle");
    setError(undefined);
    setWarning(undefined);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setSaveState("saving");
    setError(undefined);
    setWarning(undefined);
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
      conflictPatch.current = undefined;
      setSaveState("saved");
      input.onSaved(settings);
    } catch (reason) {
      const recovery = settingsFailureRecovery(reason);
      if (recovery === "rebase") {
        conflictPatch.current = patch;
        setSaveState("refreshing-conflict");
        runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
        return;
      }
      setSaveState("error");
      setError(settingsErrorMessage(reason));
      if (recovery === "refresh") {
        runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
      }
    }
  };

  const retryConflictRefresh = () => {
    if (conflictPatch.current === undefined) return;
    setSaveState("refreshing-conflict");
    setError(undefined);
    runtime.thread.dispatch({ type: "OPEN", threadId: input.threadId });
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

      <form
        className={styles.form}
        data-pwa-draft={dirty ? "true" : undefined}
        onSubmit={(event) => void save(event)}
      >
        <fieldset className={styles.group} disabled={locked}>
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
                onChange={(value) => updateDraft({ sandbox: value })}
              />
            ) : null}
            <Choice
              checked={sandbox === "read-only"}
              description="允许读取，但不允许修改文件"
              label="只读"
              name="sandbox"
              value="read-only"
              onChange={(value) => updateDraft({ sandbox: value })}
            />
            <Choice
              checked={sandbox === "workspace-write"}
              description="可修改工作区，工作区外仍受保护"
              label="工作区可写"
              name="sandbox"
              value="workspace-write"
              onChange={(value) => updateDraft({ sandbox: value })}
            />
            <Choice
              checked={sandbox === "danger-full-access"}
              description="可访问此 Linux 用户有权访问的全部路径"
              label="完全访问"
              name="sandbox"
              tone="danger"
              value="danger-full-access"
              onChange={(value) => updateDraft({ sandbox: value })}
            />
          </div>
        </fieldset>

        <fieldset className={styles.group} disabled={locked}>
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
                onChange={(value) => updateDraft({ approvalPolicy: value })}
              />
            ) : null}
            <Choice
              checked={approvalPolicy === "untrusted"}
              description="未受信任的操作需要你确认"
              label="严格审批"
              name="approval"
              value="untrusted"
              onChange={(value) => updateDraft({ approvalPolicy: value })}
            />
            <Choice
              checked={approvalPolicy === "on-request"}
              description="Codex 判断需要时再请求确认"
              label="按需询问"
              name="approval"
              value="on-request"
              onChange={(value) => updateDraft({ approvalPolicy: value })}
            />
            <Choice
              checked={approvalPolicy === "never"}
              description="不弹出审批；受限操作可能直接失败"
              label="从不询问"
              name="approval"
              tone="danger"
              value="never"
              onChange={(value) => updateDraft({ approvalPolicy: value })}
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
                disabled={locked}
                placeholder={input.settings.model ?? "保持当前模型"}
                value={model}
                onChange={(event) => updateDraft({ model: event.target.value })}
              />
            </label>
            <label>
              <span>推理强度</span>
              <small>较高强度通常更慢，并消耗更多 token。</small>
              <select
                disabled={locked}
                value={effort}
                onChange={(event) =>
                  updateDraft({ effort: event.target.value })
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
        {warning === undefined ? null : (
          <StatusMessage tone="warning">{warning}</StatusMessage>
        )}
        {error === undefined ? null : (
          <StatusMessage tone="error">{error}</StatusMessage>
        )}

        <footer className={styles.actions}>
          <span className={styles.changeState} aria-live="polite">
            {busy
              ? saveState === "reconciling"
                ? "正在确认宿主机结果…"
                : saveState === "refreshing-conflict"
                  ? "正在读取最新设置…"
                  : "正在保存…"
              : saveState === "refresh-failed"
                ? "需要重新同步后才能保存"
                : saveState === "conflict"
                  ? dirty
                    ? "已基于最新 revision 保留更改"
                    : "已同步宿主机最新设置"
                  : dirty
                    ? "有未保存的更改"
                    : saveState === "saved"
                      ? "已保存到宿主机"
                      : "没有未保存的更改"}
          </span>
          <button disabled={busy} type="button" onClick={close}>
            {dirty ? "放弃更改" : "关闭"}
          </button>
          {saveState === "refresh-failed" ? (
            <button
              className="primary"
              type="button"
              onClick={retryConflictRefresh}
            >
              重新同步
            </button>
          ) : (
            <button className="primary" disabled={!dirty || busy} type="submit">
              {saveState === "saving"
                ? "正在保存…"
                : saveState === "reconciling"
                  ? "正在确认…"
                  : saveState === "refreshing-conflict"
                    ? "正在同步…"
                    : "保存更改"}
            </button>
          )}
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
