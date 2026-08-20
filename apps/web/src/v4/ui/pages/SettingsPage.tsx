import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  GatewayRemoteError,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import {
  registerPasskey,
  registerPassword,
  rotateRecoveryCodes,
} from "../../gateway/connect-host.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { mutationOptions, queryOptions } from "../../gateway/gateway-port.js";
import { useActorState } from "../../actors/use-actor.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { ModalDialog } from "../components/ModalDialog.js";
import { useRuntime } from "../runtime-context.js";

type Preferences = OutputOf<"preferences/read">;
export type PreferenceDraft = Pick<
  Preferences,
  "theme" | "sandbox" | "approvalPolicy"
>;
type PreferencePatch = Partial<PreferenceDraft>;
type PreferenceFeedback = {
  readonly tone: "success" | "error" | "warning";
  readonly message: string;
};

export function SettingsPage() {
  const runtime = useRuntime();
  const onboarding = useActorState(runtime.onboarding);
  const navigate = useNavigate();
  const [preferences, setPreferences] = useState<Preferences>();
  const [preferenceDraft, setPreferenceDraft] = useState<PreferenceDraft>();
  const [auth, setAuth] = useState<OutputOf<"auth/status">>();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>([]);
  const [codexVersion, setCodexVersion] =
    useState<OutputOf<"setup/codex/version">>();
  const [busy, setBusy] = useState(false);
  const [preferenceSaveState, setPreferenceSaveState] = useState<
    "idle" | "saving" | "reconciling"
  >("idle");
  const [preferenceFeedback, setPreferenceFeedback] =
    useState<PreferenceFeedback>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const preferenceBusy = preferenceSaveState !== "idle";

  useEffect(() => {
    void Promise.all([
      runtime.gateway.request(
        "preferences/read",
        { version: 1 },
        queryOptions(),
      ),
      runtime.gateway.request("auth/status", { version: 1 }, queryOptions()),
      runtime.gateway.request(
        "setup/codex/version",
        { version: 1 },
        queryOptions(),
      ),
    ])
      .then(([nextPreferences, nextAuth, nextVersion]) => {
        setPreferences(nextPreferences);
        setPreferenceDraft(preferenceDraftFrom(nextPreferences));
        setAuth(nextAuth);
        setCodexVersion(nextVersion);
      })
      .catch((reason) => setError(message(reason)));
  }, [runtime]);

  const editPreferences = (patch: PreferencePatch) => {
    setPreferenceDraft((current) =>
      current === undefined ? current : { ...current, ...patch },
    );
    setPreferenceFeedback(undefined);
  };

  const savePreferences = async (event: FormEvent) => {
    event.preventDefault();
    const current = preferences;
    const draft = preferenceDraft;
    if (current === undefined || draft === undefined) return;
    const patch = changedPreferences(current, draft);
    if (!hasPreferenceChanges(patch)) return;
    setPreferenceSaveState("saving");
    setPreferenceFeedback(undefined);
    try {
      const result = await durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "preferences/update",
        payload: { version: 1, expectedRevision: current.revision, patch },
        onOutcomeUnknown: () => setPreferenceSaveState("reconciling"),
      });
      setPreferences(result);
      setPreferenceDraft(preferenceDraftFrom(result));
      if (patch.theme !== undefined) applyTheme(patch.theme);
      setPreferenceFeedback({
        tone: "success",
        message: "全局设置已保存；新任务将使用这些默认权限。",
      });
    } catch (reason) {
      if (
        reason instanceof GatewayRemoteError &&
        reason.code === "REVISION_CONFLICT"
      ) {
        setPreferenceSaveState("reconciling");
        try {
          const latest = await runtime.gateway.request(
            "preferences/read",
            { version: 1 },
            queryOptions(),
          );
          const resolution = resolvePreferenceConflict(latest, patch);
          setPreferences(latest);
          setPreferenceDraft(resolution.draft);
          if (resolution.remainingPatch.theme === undefined) {
            applyTheme(latest.theme);
          }
          setPreferenceFeedback(
            hasPreferenceChanges(resolution.remainingPatch)
              ? {
                  tone: "warning",
                  message:
                    "其他设备修改了全局设置。已同步最新版本并保留你的改动，请确认后再次保存。",
                }
              : {
                  tone: "success",
                  message:
                    "其他设备已应用相同设置；已同步宿主机最新版本，无需再次保存。",
                },
          );
        } catch (refreshReason) {
          setPreferenceFeedback({
            tone: "error",
            message: `设置版本发生冲突，且重新同步失败：${message(refreshReason)}`,
          });
        }
      } else {
        setPreferenceFeedback({ tone: "error", message: message(reason) });
      }
    } finally {
      setPreferenceSaveState("idle");
    }
  };

  const preferencePatch =
    preferences === undefined || preferenceDraft === undefined
      ? {}
      : changedPreferences(preferences, preferenceDraft);
  const preferencesDirty = hasPreferenceChanges(preferencePatch);

  const identityAction = async (
    action: () => Promise<readonly string[]>,
    success: string,
  ): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const codes = await action();
      if (codes.length > 0) setRecoveryCodes(codes);
      setAuth(
        await runtime.gateway.request(
          "auth/status",
          { version: 1 },
          queryOptions(),
        ),
      );
      setNotice(success);
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const savePassword = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    void identityAction(
      () =>
        registerPassword(
          runtime.gateway,
          runtime.host,
          password,
          auth?.temporary === false,
        ),
      "CE 密码已更新。",
    ).then((saved) => {
      if (saved) {
        setPassword("");
        setConfirmation("");
      }
    });
  };

  const runLifecycle = async (
    operation: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation();
      setNotice(success);
      runtime.onboarding.dispatch({ type: "INSPECT" });
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <main aria-busy={busy || preferenceBusy} className="page narrow-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">个人偏好</p>
          <h1>设置</h1>
          <p>任务权限与 Web 身份保存在运行 Codex 的宿主机。</p>
        </div>
      </header>
      {auth?.temporary ? (
        <StatusMessage tone="warning">
          当前为临时登录；CE 不会把设备密钥、会话票据或业务缓存写入浏览器存储。
        </StatusMessage>
      ) : null}
      {preferences === undefined || preferenceDraft === undefined ? (
        <span className="spinner" />
      ) : (
        <form
          className="preference-form"
          data-pwa-draft={preferencesDirty ? "true" : undefined}
          onSubmit={(event) => void savePreferences(event)}
        >
          <section className="settings-list" aria-busy={preferenceBusy}>
            <label>
              <span>
                <strong>主题</strong>
                <small>保存后应用跟随系统、浅色或深色主题</small>
              </span>
              <select
                disabled={preferenceBusy || busy}
                value={preferenceDraft.theme}
                onChange={(event) =>
                  editPreferences({
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
                disabled={preferenceBusy || busy}
                value={preferenceDraft.sandbox}
                onChange={(event) =>
                  editPreferences({
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
                disabled={preferenceBusy || busy}
                value={preferenceDraft.approvalPolicy}
                onChange={(event) =>
                  editPreferences({
                    approvalPolicy: event.target
                      .value as PreferenceDraft["approvalPolicy"],
                  })
                }
              >
                <option value="untrusted">不信任</option>
                <option value="on-request">按需询问</option>
                <option value="never">从不询问</option>
              </select>
            </label>
          </section>
          <div className="settings-save-bar">
            <span role="status">
              {preferenceBusy ? (
                preferenceSaveState === "reconciling" ? (
                  "正在确认宿主机保存结果…"
                ) : (
                  "正在保存全局设置…"
                )
              ) : preferencesDirty ? (
                <strong>有未保存的更改</strong>
              ) : (
                `已保存 · revision ${preferences.revision}`
              )}
            </span>
            <div className="settings-save-actions">
              <button
                disabled={preferenceBusy || busy || !preferencesDirty}
                type="button"
                onClick={() => {
                  setPreferenceDraft(preferenceDraftFrom(preferences));
                  setPreferenceFeedback(undefined);
                }}
              >
                撤销更改
              </button>
              <button
                className="primary"
                disabled={preferenceBusy || busy || !preferencesDirty}
                type="submit"
              >
                {preferenceSaveState === "reconciling"
                  ? "正在确认…"
                  : preferenceSaveState === "saving"
                    ? "正在保存…"
                    : "保存全局设置"}
              </button>
            </div>
          </div>
          {preferenceFeedback === undefined ? null : (
            <StatusMessage tone={preferenceFeedback.tone}>
              {preferenceFeedback.message}
            </StatusMessage>
          )}
        </form>
      )}

      <section className="settings-security">
        <div>
          <p className="eyebrow">Web 身份</p>
          <h2>登录与恢复</h2>
          <p>CE 密码独立于 SSH/Linux 密码。恢复码每次轮换后旧码立即失效。</p>
        </div>
        <div className="identity-actions">
          <button
            disabled={busy || preferenceBusy}
            type="button"
            onClick={() =>
              void identityAction(
                () =>
                  registerPasskey(
                    runtime.gateway,
                    runtime.host.deviceName,
                    auth?.temporary === false,
                  ),
                "Passkey 已添加。",
              )
            }
          >
            添加 Passkey
          </button>
          <button
            disabled={busy || preferenceBusy}
            type="button"
            onClick={() =>
              void identityAction(
                () => rotateRecoveryCodes(runtime.gateway),
                "新的恢复码已签发，请立即保存。",
              )
            }
          >
            轮换恢复码
          </button>
        </div>
        <form className="password-form" onSubmit={savePassword}>
          <label>
            新的 CE 密码
            <input
              autoComplete="new-password"
              minLength={9}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <label>
            再次输入
            <input
              autoComplete="new-password"
              minLength={9}
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
            />
          </label>
          <button
            className="primary"
            disabled={busy || preferenceBusy}
            type="submit"
          >
            {auth?.passwordAvailable ? "更改 CE 密码" : "设置 CE 密码"}
          </button>
        </form>
      </section>
      <section className="settings-security">
        <div>
          <p className="eyebrow">Codex 运行环境</p>
          <h2>安装与 app-server</h2>
          <p>
            当前版本 {codexVersion?.installedVersion ?? "未安装"}
            {codexVersion?.latestVersion === undefined
              ? ""
              : ` · 最新 ${codexVersion.latestVersion}`}
            {` · app-server ${onboarding.status?.appServerHealthy ? "健康" : "不可用"}`}
          </p>
        </div>
        {onboarding.installProgress === undefined ? null : (
          <p role="status">
            安装状态：{installPhaseLabel(onboarding.installProgress.phase)}
          </p>
        )}
        <div className="identity-actions">
          <button
            disabled={busy || preferenceBusy}
            type="button"
            onClick={() =>
              void runLifecycle(
                () =>
                  durableMutation({
                    owner: runtime.scope,
                    gateway: runtime.gateway,
                    method: "setup/codex/install",
                    payload: { version: 1 },
                  }),
                "Codex 更新已提交；安装完成后状态会自动刷新",
              )
            }
          >
            检查并更新 Codex
          </button>
          <button
            disabled={busy || preferenceBusy}
            type="button"
            onClick={() =>
              void runLifecycle(
                () =>
                  runtime.gateway.request(
                    "setup/app-server/restart",
                    { version: 1 },
                    mutationOptions(),
                  ),
                "app-server 已重启；当前任务将从权威状态重新打开",
              ).then((restarted) => {
                const threadId = runtime.thread.getSnapshot().threadId;
                if (restarted && threadId !== undefined) {
                  runtime.thread.dispatch({ type: "OPEN", threadId });
                }
              })
            }
          >
            重启 app-server
          </button>
          <button
            disabled={
              busy || preferenceBusy || !onboarding.status?.codexAuthenticated
            }
            type="button"
            onClick={() => {
              if (
                !window.confirm(
                  "退出当前用户自己的 Codex 账号？活动任务会阻止此操作。",
                )
              ) {
                return;
              }
              void runLifecycle(
                () =>
                  durableMutation({
                    owner: runtime.scope,
                    gateway: runtime.gateway,
                    method: "setup/codex/logout",
                    payload: { version: 1 },
                  }),
                "已退出 Codex 账号",
              ).then((loggedOut) => {
                if (loggedOut) navigate("/setup");
              });
            }}
          >
            退出 Codex 账号
          </button>
        </div>
      </section>
      {error === undefined ? null : (
        <StatusMessage tone="error">{error}</StatusMessage>
      )}
      {notice === undefined ? null : (
        <StatusMessage tone="success">{notice}</StatusMessage>
      )}
      {recoveryCodes.length === 0 ? null : (
        <ModalDialog
          className="ce-dialog"
          aria-labelledby="settings-recovery-title"
        >
          <h2 id="settings-recovery-title">请立即保存新的恢复码</h2>
          <p>这些恢复码只显示一次，旧恢复码已经失效。</p>
          <pre data-one-time-secret>{recoveryCodes.join("\n")}</pre>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(recoveryCodes.join("\n"))
              }
            >
              复制
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => setRecoveryCodes([])}
            >
              我已保存
            </button>
          </div>
        </ModalDialog>
      )}
    </main>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "设置保存失败";
}

export function preferenceDraftFrom(preferences: Preferences): PreferenceDraft {
  return {
    theme: preferences.theme,
    sandbox: preferences.sandbox,
    approvalPolicy: preferences.approvalPolicy,
  };
}

export function changedPreferences(
  current: Preferences,
  draft: PreferenceDraft,
): PreferencePatch {
  return {
    ...(draft.theme === current.theme ? {} : { theme: draft.theme }),
    ...(draft.sandbox === current.sandbox ? {} : { sandbox: draft.sandbox }),
    ...(draft.approvalPolicy === current.approvalPolicy
      ? {}
      : { approvalPolicy: draft.approvalPolicy }),
  };
}

export function rebasePreferenceDraft(
  latest: Preferences,
  patch: PreferencePatch,
): PreferenceDraft {
  return { ...preferenceDraftFrom(latest), ...patch };
}

export function resolvePreferenceConflict(
  latest: Preferences,
  submittedPatch: PreferencePatch,
): {
  readonly draft: PreferenceDraft;
  readonly remainingPatch: PreferencePatch;
} {
  const draft = rebasePreferenceDraft(latest, submittedPatch);
  return { draft, remainingPatch: changedPreferences(latest, draft) };
}

function hasPreferenceChanges(patch: PreferencePatch): boolean {
  return Object.keys(patch).length > 0;
}

function applyTheme(theme: Preferences["theme"]): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function installPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    preparing: "准备中",
    installing: "安装中",
    verifying: "校验中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[phase] ?? phase;
}
