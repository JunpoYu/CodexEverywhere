import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
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
import { readCodexVersion } from "../../gateway/codex-version.js";
import { mutationOptions, queryOptions } from "../../gateway/gateway-port.js";
import { useActorState } from "../../actors/use-actor.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";
import { CodexRuntimeSettingsSection } from "./settings/CodexRuntimeSettingsSection.js";
import { IdentitySettingsSection } from "./settings/IdentitySettingsSection.js";
import { PreferencesSettingsForm } from "./settings/PreferencesSettingsForm.js";
import { RecoveryCodesDialog } from "./settings/RecoveryCodesDialog.js";
import {
  changedPreferences,
  hasPreferenceChanges,
  isPreferenceSaveInFlight,
  preferenceDraftFrom,
  resolvePreferenceConflict,
  type PreferenceDraft,
  type PreferenceFeedback,
  type PreferencePatch,
  type PreferenceSaveState,
  type Preferences,
} from "./settings/preferences-model.js";

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
  const [preferenceSaveState, setPreferenceSaveState] =
    useState<PreferenceSaveState>("idle");
  const pendingPreferenceConflictPatch = useRef<PreferencePatch | undefined>(
    undefined,
  );
  const [preferenceFeedback, setPreferenceFeedback] =
    useState<PreferenceFeedback>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const preferenceInFlight = isPreferenceSaveInFlight(preferenceSaveState);
  const preferenceLocked = preferenceSaveState !== "idle";

  useEffect(() => {
    const controller = new AbortController();
    const options = queryOptions(controller.signal);
    const reportFailure = (reason: unknown) => {
      if (!controller.signal.aborted) {
        setError((current) => current ?? message(reason));
      }
    };
    void runtime.gateway
      .request("preferences/read", { version: 1 }, options)
      .then((nextPreferences) => {
        if (controller.signal.aborted) return;
        setPreferences(nextPreferences);
        setPreferenceDraft(preferenceDraftFrom(nextPreferences));
      })
      .catch(reportFailure);
    void runtime.gateway
      .request("auth/status", { version: 1 }, options)
      .then((nextAuth) => {
        if (!controller.signal.aborted) setAuth(nextAuth);
      })
      .catch(reportFailure);
    void readCodexVersion(runtime.gateway, controller.signal)
      .then((nextVersion) => {
        if (!controller.signal.aborted) setCodexVersion(nextVersion);
      })
      .catch(reportFailure);
    return () => controller.abort();
  }, [runtime]);

  useEffect(() => {
    const phase = onboarding.installProgress?.phase;
    if (phase !== "completed" && phase !== "failed") return;
    const controller = new AbortController();
    void readCodexVersion(runtime.gateway, controller.signal)
      .then((nextVersion) => {
        if (!controller.signal.aborted) setCodexVersion(nextVersion);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [onboarding.installProgress?.phase, runtime]);

  const editPreferences = (patch: PreferencePatch) => {
    setPreferenceDraft((current) =>
      current === undefined ? current : { ...current, ...patch },
    );
    setPreferenceFeedback(undefined);
  };

  const refreshPreferenceConflict = async (patch: PreferencePatch) => {
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
      pendingPreferenceConflictPatch.current = undefined;
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
      setPreferenceSaveState("idle");
    } catch (refreshReason) {
      setPreferenceSaveState("refresh-failed");
      setPreferenceFeedback({
        tone: "error",
        message: `设置版本发生冲突，且重新同步失败：${message(refreshReason)}。尚未再次提交，请重新同步宿主机设置。`,
      });
    }
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
    let resetSaveState = true;
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
      pendingPreferenceConflictPatch.current = undefined;
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
        resetSaveState = false;
        pendingPreferenceConflictPatch.current = patch;
        await refreshPreferenceConflict(patch);
      } else {
        setPreferenceFeedback({ tone: "error", message: message(reason) });
      }
    } finally {
      if (resetSaveState) setPreferenceSaveState("idle");
    }
  };

  const retryPreferenceConflict = (event: MouseEvent<HTMLButtonElement>) => {
    // React flushes the reconciling state during this click, which changes the
    // button back to type=submit before the browser runs its default action.
    // Prevent that default so a recovery read can never become a stale retry.
    event.preventDefault();
    const patch = pendingPreferenceConflictPatch.current;
    if (patch !== undefined) void refreshPreferenceConflict(patch);
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

  const addPasskey = () => {
    void identityAction(
      () =>
        registerPasskey(
          runtime.gateway,
          runtime.host.deviceName,
          auth?.temporary === false,
        ),
      "Passkey 已添加。",
    );
  };

  const rotateCodes = () => {
    void identityAction(
      () => rotateRecoveryCodes(runtime.gateway),
      "新的恢复码已签发，请立即保存。",
    );
  };

  const installCodex = () => {
    void runLifecycle(
      () =>
        durableMutation({
          owner: runtime.scope,
          gateway: runtime.gateway,
          method: "setup/codex/install",
          payload: { version: 1 },
        }),
      "Codex 更新已提交；完成后会安全切换 app-server 并刷新模型目录",
    );
  };

  const restartAppServer = () => {
    void runLifecycle(async () => {
      await runtime.gateway.request(
        "setup/app-server/restart",
        { version: 1 },
        mutationOptions(),
      );
      runtime.onboarding.dispatch({ type: "RUNTIME_RESTARTED" });
    }, "app-server 已重启；当前任务将从权威状态重新打开").then((restarted) => {
      const threadId = runtime.thread.getSnapshot().threadId;
      if (restarted && threadId !== undefined) {
        runtime.thread.dispatch({ type: "OPEN", threadId });
      }
      if (restarted) runtime.models.dispatch({ type: "LOAD" });
    });
  };

  const logoutCodex = () => {
    if (
      !window.confirm("退出当前用户自己的 Codex 账号？活动任务会阻止此操作。")
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
  };

  return (
    <main aria-busy={busy || preferenceInFlight} className="page narrow-page">
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
        <PreferencesSettingsForm
          busy={busy}
          canRetryConflict={
            pendingPreferenceConflictPatch.current !== undefined
          }
          dirty={preferencesDirty}
          draft={preferenceDraft}
          feedback={preferenceFeedback}
          preferences={preferences}
          saveState={preferenceSaveState}
          onDiscard={() => {
            setPreferenceDraft(preferenceDraftFrom(preferences));
            setPreferenceFeedback(undefined);
          }}
          onEdit={editPreferences}
          onRetryConflict={retryPreferenceConflict}
          onSubmit={(event) => void savePreferences(event)}
        />
      )}

      <IdentitySettingsSection
        auth={auth}
        confirmation={confirmation}
        disabled={busy || preferenceLocked}
        password={password}
        onAddPasskey={addPasskey}
        onConfirmationChange={setConfirmation}
        onPasswordChange={setPassword}
        onRotateRecoveryCodes={rotateCodes}
        onSavePassword={savePassword}
      />
      <CodexRuntimeSettingsSection
        disabled={busy || preferenceLocked}
        onboarding={onboarding}
        version={codexVersion}
        onInstall={installCodex}
        onLogout={logoutCodex}
        onRestart={restartAppServer}
      />
      {error === undefined ? null : (
        <StatusMessage tone="error">{error}</StatusMessage>
      )}
      {notice === undefined ? null : (
        <StatusMessage tone="success">{notice}</StatusMessage>
      )}
      <RecoveryCodesDialog
        codes={recoveryCodes}
        onClose={() => setRecoveryCodes([])}
      />
    </main>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "设置保存失败";
}

function applyTheme(theme: Preferences["theme"]): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
