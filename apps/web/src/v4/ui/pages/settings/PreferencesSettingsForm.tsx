import type { FormEventHandler, MouseEventHandler } from "react";

import { StatusMessage } from "../../components/StatusMessage.js";
import type {
  PreferenceDraft,
  PreferenceFeedback,
  PreferencePatch,
  PreferenceSaveState,
  Preferences,
} from "./preferences-model.js";
import styles from "./SettingsSections.module.css";

export function PreferencesSettingsForm(input: {
  readonly busy: boolean;
  readonly canRetryConflict: boolean;
  readonly dirty: boolean;
  readonly draft: PreferenceDraft;
  readonly feedback: PreferenceFeedback | undefined;
  readonly preferences: Preferences;
  readonly saveState: PreferenceSaveState;
  readonly onDiscard: () => void;
  readonly onEdit: (patch: PreferencePatch) => void;
  readonly onRetryConflict: MouseEventHandler<HTMLButtonElement>;
  readonly onSubmit: FormEventHandler<HTMLFormElement>;
}) {
  const inFlight =
    input.saveState === "saving" || input.saveState === "reconciling";
  const locked = input.saveState !== "idle";
  return (
    <form
      className={styles.preferenceForm}
      data-preferences-form
      data-pwa-draft={input.dirty ? "true" : undefined}
      onSubmit={input.onSubmit}
    >
      <section className={styles.preferenceList} aria-busy={inFlight}>
        <label>
          <span>
            <strong>主题</strong>
            <small>保存后应用跟随系统、浅色或深色主题</small>
          </span>
          <select
            disabled={locked || input.busy}
            value={input.draft.theme}
            onChange={(event) =>
              input.onEdit({
                theme: event.target.value as PreferenceDraft["theme"],
              })
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          <span>
            <strong>默认 Sandbox</strong>
            <small>新任务的文件访问边界，不影响已有任务</small>
          </span>
          <select
            disabled={locked || input.busy}
            value={input.draft.sandbox}
            onChange={(event) =>
              input.onEdit({
                sandbox: event.target.value as PreferenceDraft["sandbox"],
              })
            }
          >
            <option value="read-only">只读</option>
            <option value="workspace-write">工作区可写</option>
            <option value="danger-full-access">完全访问</option>
          </select>
        </label>
        <label>
          <span>
            <strong>默认审批策略</strong>
            <small>新任务请求外部副作用时的策略，不影响已有任务</small>
          </span>
          <select
            disabled={locked || input.busy}
            value={input.draft.approvalPolicy}
            onChange={(event) =>
              input.onEdit({
                approvalPolicy: event.target
                  .value as PreferenceDraft["approvalPolicy"],
              })
            }
          >
            <option value="untrusted">严格审批</option>
            <option value="on-request">按需询问</option>
            <option value="never">从不询问</option>
          </select>
        </label>
      </section>
      <div className={styles.saveBar}>
        <span role="status">
          {inFlight ? (
            input.saveState === "reconciling" ? (
              "正在确认宿主机保存结果…"
            ) : (
              "正在保存全局设置…"
            )
          ) : input.saveState === "refresh-failed" ? (
            <strong>同步失败 · 尚未再次提交</strong>
          ) : input.dirty ? (
            <strong>有未保存的更改</strong>
          ) : (
            `已保存 · revision ${input.preferences.revision}`
          )}
        </span>
        <div className={styles.saveActions}>
          <button
            disabled={locked || input.busy || !input.dirty}
            type="button"
            onClick={input.onDiscard}
          >
            撤销更改
          </button>
          <button
            className="primary"
            disabled={
              input.busy ||
              (input.saveState === "refresh-failed"
                ? !input.canRetryConflict
                : locked || !input.dirty)
            }
            type={input.saveState === "refresh-failed" ? "button" : "submit"}
            onClick={
              input.saveState === "refresh-failed"
                ? input.onRetryConflict
                : undefined
            }
          >
            {input.saveState === "refresh-failed"
              ? "重新同步宿主机设置"
              : input.saveState === "reconciling"
                ? "正在确认…"
                : input.saveState === "saving"
                  ? "正在保存…"
                  : "保存全局设置"}
          </button>
        </div>
      </div>
      {input.feedback === undefined ? null : (
        <StatusMessage tone={input.feedback.tone}>
          {input.feedback.message}
        </StatusMessage>
      )}
    </form>
  );
}
