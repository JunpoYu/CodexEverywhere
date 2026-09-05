import type { OutputOf } from "@codex-everywhere/protocol/v2";

import type { OnboardingState } from "../../../actors/onboarding-actor.js";
import { StatusMessage } from "../../components/StatusMessage.js";
import styles from "./SettingsSections.module.css";

export function CodexRuntimeSettingsSection(input: {
  readonly disabled: boolean;
  readonly onboarding: Pick<OnboardingState, "installProgress" | "status">;
  readonly version: OutputOf<"setup/codex/version"> | undefined;
  readonly onInstall: () => void;
  readonly onLogout: () => void;
  readonly onRestart: () => void;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <p className="eyebrow">Codex 运行环境</p>
        <h2>安装与 app-server</h2>
        <p>
          当前版本 {input.version?.installedVersion ?? "未安装"}
          {input.version?.latestVersion === undefined
            ? ""
            : ` · 最新 ${input.version.latestVersion}`}
          {` · app-server ${input.onboarding.status?.appServerHealthy ? "健康" : "不可用"}`}
        </p>
      </div>
      {input.onboarding.installProgress === undefined ? null : (
        <p role="status">
          安装状态：
          {installPhaseLabel(input.onboarding.installProgress.phase)}
        </p>
      )}
      {input.version?.runtimeSwitchState === undefined ||
      input.version.runtimeSwitchState === "none" ? null : (
        <StatusMessage tone="warning">
          {input.version.runtimeSwitchState === "restart-required"
            ? "Codex 已更新，但 app-server 尚未切换到新版本。确认没有活动任务后点击重启。"
            : "上次 Codex 更新未完整结束。请重新执行更新，完成前 app-server 可能仍使用旧版本。"}
        </StatusMessage>
      )}
      <div className={styles.actions}>
        <button
          disabled={input.disabled}
          type="button"
          onClick={input.onInstall}
        >
          检查并更新 Codex
        </button>
        <button
          disabled={input.disabled}
          type="button"
          onClick={input.onRestart}
        >
          重启 app-server
        </button>
        <button
          disabled={
            input.disabled || !input.onboarding.status?.codexAuthenticated
          }
          type="button"
          onClick={input.onLogout}
        >
          退出 Codex 账号
        </button>
      </div>
    </section>
  );
}

function installPhaseLabel(phase: string): string {
  const labels: Readonly<Record<string, string>> = {
    preparing: "准备中",
    installing: "安装中",
    verifying: "校验并切换 app-server",
    completed: "已完成，模型目录已刷新",
    failed: "未完全应用，请确认没有活动任务后重试",
  };
  return labels[phase] ?? phase;
}
