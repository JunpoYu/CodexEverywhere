import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type {
  GatewayEventPayload,
  OutputOf,
} from "@codex-everywhere/protocol/v2";

import { useActorState } from "../../actors/use-actor.js";
import { durableMutation } from "../../gateway/durable-mutation.js";
import { mutationOptions, queryOptions } from "../../gateway/gateway-port.js";
import { Icon } from "../components/Icon.js";
import { StatusMessage } from "../components/StatusMessage.js";
import { useRuntime } from "../runtime-context.js";

type LoginOperation = OutputOf<"setup/codex/login/start">;

export function SetupPage() {
  const runtime = useRuntime();
  const onboarding = useActorState(runtime.onboarding);
  const [login, setLogin] = useState<LoginOperation>();
  const [version, setVersion] = useState<OutputOf<"setup/codex/version">>();
  const [httpProxy, setHttpProxy] = useState("");
  const [httpsProxy, setHttpsProxy] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [codeCopied, setCodeCopied] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (onboarding.status?.codexAuthenticated) setLogin(undefined);
    if (!onboarding.status?.codexInstalled) return;
    void runtime.gateway
      .request("setup/codex/version", { version: 1 }, queryOptions())
      .then(setVersion)
      .catch(() => undefined);
  }, [onboarding.status, runtime]);

  useEffect(() => {
    if (
      login !== undefined &&
      onboarding.loginCompletion?.operationId === login.operationId
    ) {
      setLogin(undefined);
    }
  }, [login, onboarding.loginCompletion]);

  const mutate = async (operation: () => Promise<unknown>, inspect = true) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      if (inspect) runtime.onboarding.dispatch({ type: "INSPECT" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "初始化操作失败");
    } finally {
      setBusy(false);
    }
  };

  const configureProxy = (event: FormEvent) => {
    event.preventDefault();
    void mutate(() =>
      durableMutation({
        owner: runtime.scope,
        gateway: runtime.gateway,
        method: "setup/network/configure",
        payload: {
          version: 1,
          mode: "proxy",
          ...(httpProxy.trim().length === 0
            ? {}
            : { httpProxy: httpProxy.trim() }),
          httpsProxy: httpsProxy.trim(),
          ...(noProxy.trim().length === 0 ? {} : { noProxy: noProxy.trim() }),
        },
      }),
    );
  };

  return (
    <main aria-busy={busy} className="page narrow-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">首次初始化</p>
          <h1>设置 Codex</h1>
          <p>Agent 可在 Codex 尚未安装或登录时独立提供此流程。</p>
        </div>
      </header>
      <ol className="setup-steps">
        <Step
          title="网络"
          active={onboarding.step === "network"}
          complete={Boolean(onboarding.status?.networkConfigured)}
        >
          <p>代理仅写入宿主机配置，并只注入当前用户的 Codex 进程。</p>
          <div className="setup-actions">
            <button
              disabled={busy}
              type="button"
              onClick={() =>
                void mutate(() =>
                  durableMutation({
                    owner: runtime.scope,
                    gateway: runtime.gateway,
                    method: "setup/network/configure",
                    payload: { version: 1, mode: "direct" },
                  }),
                )
              }
            >
              使用直连
            </button>
          </div>
          <details className="proxy-setup">
            <summary>配置 Codex 出网代理</summary>
            <form onSubmit={configureProxy}>
              <label>
                HTTPS_PROXY
                <input
                  inputMode="url"
                  placeholder="http://proxy.example:8080"
                  value={httpsProxy}
                  onChange={(event) => setHttpsProxy(event.target.value)}
                  required
                />
              </label>
              <label>
                HTTP_PROXY（可选）
                <input
                  inputMode="url"
                  value={httpProxy}
                  onChange={(event) => setHttpProxy(event.target.value)}
                />
              </label>
              <label>
                NO_PROXY（可选）
                <input
                  value={noProxy}
                  onChange={(event) => setNoProxy(event.target.value)}
                />
              </label>
              <button className="primary" disabled={busy} type="submit">
                保存代理配置
              </button>
            </form>
          </details>
        </Step>
        <Step
          title="安装 Codex"
          active={onboarding.step === "install"}
          complete={Boolean(onboarding.status?.codexInstalled)}
        >
          <p>
            Codex CLI 安装在当前 Linux 用户的 <code>~/.local</code>。
          </p>
          {version === undefined ? null : (
            <small>
              已安装 {version.installedVersion ?? "未知版本"}
              {version.latestVersion === undefined
                ? ""
                : ` · 最新 ${version.latestVersion} · ${version.relation}`}
            </small>
          )}
          {onboarding.installProgress === undefined ? null : (
            <p role="status">
              安装状态：{installPhaseLabel(onboarding.installProgress.phase)}
            </p>
          )}
          <button
            disabled={
              busy ||
              (onboarding.installProgress !== undefined &&
                onboarding.installProgress.phase !== "completed" &&
                onboarding.installProgress.phase !== "failed")
            }
            type="button"
            onClick={() => {
              runtime.onboarding.dispatch({ type: "INSTALL_STARTED" });
              void mutate(
                () =>
                  durableMutation({
                    owner: runtime.scope,
                    gateway: runtime.gateway,
                    method: "setup/codex/install",
                    payload: { version: 1 },
                  }),
                false,
              );
            }}
          >
            {onboarding.status?.codexInstalled
              ? "检查并更新 Codex"
              : "安装 Codex"}
          </button>
        </Step>
        <Step
          title="ChatGPT / Codex 登录"
          active={onboarding.step === "codex-login"}
          complete={Boolean(onboarding.status?.codexAuthenticated)}
        >
          <p>
            使用官方 app-server 设备码流程；CE 不接收 <code>auth.json</code>。
          </p>
          <button
            disabled={busy || login !== undefined}
            type="button"
            onClick={() => {
              runtime.onboarding.dispatch({ type: "LOGIN_STARTED" });
              void mutate(async () => {
                setLogin(
                  await runtime.gateway.request(
                    "setup/codex/login/start",
                    { version: 1 },
                    mutationOptions(),
                  ),
                );
              }, false);
            }}
          >
            获取设备码
          </button>
          {login === undefined ? null : (
            <div className="device-code">
              <div>
                <span>设备验证码</span>
                <strong>{login.userCode}</strong>
              </div>
              <a href={login.verificationUri} target="_blank" rel="noreferrer">
                打开官方登录页面
              </a>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(login.userCode)
                    .then(() => setCodeCopied(true))
                }
              >
                {codeCopied ? "已复制" : "复制验证码"}
              </button>
              <small>
                有效期至 {new Date(login.expiresAt).toLocaleTimeString("zh-CN")}
              </small>
              <button
                type="button"
                onClick={() =>
                  void mutate(async () => {
                    await runtime.gateway.request(
                      "setup/codex/login/cancel",
                      { version: 1, operationId: login.operationId },
                      mutationOptions(),
                    );
                    setLogin(undefined);
                    setCodeCopied(false);
                  })
                }
              >
                取消登录
              </button>
            </div>
          )}
        </Step>
        <Step
          title="就绪"
          active={onboarding.step === "ready"}
          complete={onboarding.step === "ready"}
        >
          <p>Codex app-server 已准备好承载任务。</p>
          {onboarding.step === "ready" ? (
            <button
              className="primary"
              type="button"
              onClick={() => {
                runtime.tasks.dispatch({ type: "LOAD" });
                runtime.queue.dispatch({ type: "LOAD" });
                navigate("/tasks");
              }}
            >
              进入任务
            </button>
          ) : null}
        </Step>
      </ol>
      {busy ? (
        <StatusMessage tone="info">正在处理初始化操作，请稍候…</StatusMessage>
      ) : null}
      {onboarding.error === undefined ? null : (
        <StatusMessage tone="error">{onboarding.error}</StatusMessage>
      )}
      {error === undefined ? null : (
        <StatusMessage tone="error">{error}</StatusMessage>
      )}
    </main>
  );
}

function Step(input: {
  readonly title: string;
  readonly active: boolean;
  readonly complete: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <li className={input.active ? "active" : input.complete ? "complete" : ""}>
      <i>{input.complete ? <Icon name="check" /> : null}</i>
      <div>
        <h2>{input.title}</h2>
        {input.children}
      </div>
    </li>
  );
}

function installPhaseLabel(
  phase: GatewayEventPayload<"setup/codex/install/progress">["phase"],
): string {
  return {
    preparing: "准备中",
    installing: "安装中",
    verifying: "校验中",
    completed: "已完成",
    failed: "失败",
  }[phase];
}
