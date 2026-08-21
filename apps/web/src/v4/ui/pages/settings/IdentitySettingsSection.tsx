import type { FormEventHandler } from "react";
import type { OutputOf } from "@codex-everywhere/protocol/v2";

import styles from "./SettingsSections.module.css";

export function IdentitySettingsSection(input: {
  readonly auth: OutputOf<"auth/status"> | undefined;
  readonly confirmation: string;
  readonly disabled: boolean;
  readonly password: string;
  readonly onAddPasskey: () => void;
  readonly onConfirmationChange: (value: string) => void;
  readonly onPasswordChange: (value: string) => void;
  readonly onRotateRecoveryCodes: () => void;
  readonly onSavePassword: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <p className="eyebrow">Web 身份</p>
        <h2>登录与恢复</h2>
        <p>CE 密码独立于 SSH/Linux 密码。恢复码每次轮换后旧码立即失效。</p>
      </div>
      <div className={styles.actions}>
        <button
          disabled={input.disabled}
          type="button"
          onClick={input.onAddPasskey}
        >
          添加 Passkey
        </button>
        <button
          disabled={input.disabled}
          type="button"
          onClick={input.onRotateRecoveryCodes}
        >
          轮换恢复码
        </button>
      </div>
      <form className={styles.passwordForm} onSubmit={input.onSavePassword}>
        <label>
          新的 CE 密码
          <input
            autoComplete="new-password"
            minLength={9}
            type="password"
            value={input.password}
            onChange={(event) => input.onPasswordChange(event.target.value)}
            required
          />
        </label>
        <label>
          再次输入
          <input
            autoComplete="new-password"
            minLength={9}
            type="password"
            value={input.confirmation}
            onChange={(event) => input.onConfirmationChange(event.target.value)}
            required
          />
        </label>
        <button className="primary" disabled={input.disabled} type="submit">
          {input.auth?.passwordAvailable ? "更改 CE 密码" : "设置 CE 密码"}
        </button>
      </form>
    </section>
  );
}
