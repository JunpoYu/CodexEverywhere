import type { OutputOf } from "@codex-everywhere/protocol/v2";

import type { OnboardingState } from "../../../actors/onboarding-actor.js";
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
    verifying: "校验中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[phase] ?? phase;
}
