import { useEffect, useState, type FormEvent } from "react";

import { deleteHost, listHosts, type SavedHost } from "../../../storage.js";
import {
  connectSavedHost,
  createLoginHost,
  loginHost,
  pairHost,
  type HostLoginMethod,
} from "../../gateway/connect-host.js";
import { GatewayReauthenticationRequiredError } from "../../gateway/encrypted-transport.js";
import type { GatewayPort } from "../../gateway/gateway-port.js";
import { lookupHostProfile } from "../../gateway/host-discovery.js";
import { Icon } from "../components/Icon.js";
import { StatusMessage } from "../components/StatusMessage.js";
import styles from "./HostPage.module.css";

export function HostPage(input: {
  readonly onConnected: (
    gateway: GatewayPort,
    host: SavedHost,
    recoveryCodes?: readonly string[],
  ) => void;
  readonly onScenario: ((kind: "user" | "admin") => void) | undefined;
}) {
  const admin = location.pathname.startsWith("/admin");
  const [hosts, setHosts] = useState<readonly SavedHost[]>([]);
  const [loginName, setLoginName] = useState("");
  const [deviceName, setDeviceName] = useState("我的浏览器");
  const [relayEndpoint, setRelayEndpoint] = useState(defaultRelayEndpoint());
  const [directAddress, setDirectAddress] = useState("");
  const [rememberDevice, setRememberDevice] = useState(true);
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [pairing, setPairing] = useState("");
  const [reauthHost, setReauthHost] = useState<SavedHost>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void listHosts()
      .then((items) =>
        setHosts(
          items.filter((host) =>
            admin ? host.kind === "admin" : host.kind !== "admin",
          ),
        ),
      )
      .catch((reason) => setError(message(reason)));
  }, [admin]);

  const connect = async (host: SavedHost) => {
    setBusy(true);
    setError(undefined);
    try {
      input.onConnected(await connectSavedHost(host), host);
    } catch (reason) {
      if (reason instanceof GatewayReauthenticationRequiredError) {
        setReauthHost(host);
        setLoginName(host.loginName ?? host.name);
        setDeviceName(host.deviceName);
        setError("这台设备需要重新验证，请在下方选择登录方式。");
      } else {
        setError(message(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  const login = async (method: HostLoginMethod) => {
    const normalizedLogin = loginName.trim();
    const normalizedDeviceName = rememberDevice
      ? deviceName.trim() || "我的浏览器"
      : "临时浏览器";
    if (normalizedLogin.length === 0) {
      setError(admin ? "请输入管理员登录名" : "请输入 HPC 用户名");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const saved =
        reauthHost ??
        hosts.find((host) => (host.loginName ?? host.name) === normalizedLogin);
      const host =
        saved === undefined
          ? createLoginHost(
              await lookupHostProfile({
                loginName: normalizedLogin,
                principal: admin ? "host-admin" : "user",
                relayEndpoint,
                ...(directAddress.trim().length === 0
                  ? {}
                  : { directAddress: directAddress.trim() }),
              }),
              { loginName: normalizedLogin, deviceName: normalizedDeviceName },
            )
          : { ...saved, deviceName: normalizedDeviceName };
      const result = await loginHost(host, {
        method,
        deviceName: normalizedDeviceName,
        rememberDevice,
        ...(method === "password" ? { password } : {}),
        ...(method === "recovery" ? { recoveryCode } : {}),
      });
      setPassword("");
      setRecoveryCode("");
      input.onConnected(result.gateway, result.host, result.recoveryCodes);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const result = await pairHost(pairing, deviceName.trim() || "我的浏览器");
      input.onConnected(result.gateway, result.host, result.recoveryCodes);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={styles.page}>
      <section aria-busy={busy} className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>CE</span>
          <div>
            <strong>CodexEverywhere</strong>
            <small>{admin ? "HOST ADMIN" : "CODEX ON HPC"}</small>
          </div>
        </div>
        <div className={styles.heading}>
          <p className="eyebrow">Gateway API v2</p>
          <h1>{admin ? "连接宿主机管理端" : "继续你的 Codex 任务"}</h1>
          <p>
            Noise 会话在浏览器和目标宿主机之间端到端加密；Relay 不读取业务内容。
          </p>
        </div>

        {hosts.length > 0 ? (
          <div className={styles.savedHosts}>
            <h2>已保存设备</h2>
            {hosts.map((host) => (
              <div className={styles.savedHost} key={host.id}>
                <button
                  disabled={busy}
                  type="button"
                  onClick={() => void connect(host)}
                >
                  <strong>{host.name}</strong>
                  <span>
                    {host.transport === "direct" ? "Direct" : "Relay"}
                  </span>
                </button>
                <button
                  className={styles.deleteButton}
                  aria-label={`删除 ${host.name}`}
                  disabled={busy}
                  type="button"
                  onClick={() => {
                    void deleteHost(host.id).then(() =>
                      setHosts((current) =>
                        current.filter((item) => item.id !== host.id),
                      ),
                    );
                  }}
                >
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <section className={styles.loginPanel} aria-labelledby="login-title">
          <h2 id="login-title">在这台设备登录</h2>
          <label>
            {admin ? "管理员登录名" : "HPC 用户名"}
            <input
              autoComplete="username webauthn"
              value={loginName}
              onChange={(event) => {
                setLoginName(event.target.value);
                setReauthHost(undefined);
              }}
            />
          </label>
          <button
            className="primary"
            disabled={busy}
            type="button"
            onClick={() => void login("passkey")}
          >
            {busy ? "正在建立安全连接…" : "使用 Passkey 继续"}
          </button>
          <details className={styles.alternatives}>
            <summary>使用 CE 密码、恢复码或临时模式</summary>
            <label>
              CodexEverywhere 密码
              <input
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button
              disabled={busy || password.length === 0}
              type="button"
              onClick={() => void login("password")}
            >
              使用 CE 密码登录
            </button>
            <label>
              恢复码
              <input
                autoComplete="one-time-code"
                spellCheck={false}
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
              />
            </label>
            <button
              disabled={busy || recoveryCode.trim().length === 0}
              type="button"
              onClick={() => void login("recovery")}
            >
              恢复 Web 身份
            </button>
            <label className={styles.checkbox}>
              <input
                checked={rememberDevice}
                type="checkbox"
                onChange={(event) => setRememberDevice(event.target.checked)}
              />
              记住这台设备
            </label>
            <p className={styles.persistenceNote}>
              {rememberDevice
                ? "登录成功后保存设备密钥，用于以后直接连接。"
                : "临时模式：设备密钥、会话票据和业务数据均不写入浏览器存储。"}
            </p>
            {rememberDevice ? (
              <label>
                设备名称
                <input
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </label>
            ) : null}
          </details>
          {reauthHost === undefined ? (
            <details className={styles.connectionDetails}>
              <summary>连接地址</summary>
              <label>
                Relay WebSocket
                <input
                  inputMode="url"
                  spellCheck={false}
                  value={relayEndpoint}
                  onChange={(event) => setRelayEndpoint(event.target.value)}
                />
              </label>
              <label>
                Direct HTTPS（可选，优先）
                <input
                  inputMode="url"
                  placeholder="https://hpc.example.com"
                  value={directAddress}
                  onChange={(event) => setDirectAddress(event.target.value)}
                />
              </label>
            </details>
          ) : null}
        </section>

        <details className={styles.firstUse}>
          <summary>第一次使用？开始初始化</summary>
          <form
            className={styles.pairForm}
            onSubmit={(event) => void pair(event)}
          >
            <h2>首次配对</h2>
            <p>
              在目标账号运行{" "}
              {admin ? (
                <code>ce admin web pair</code>
              ) : (
                <code>ce device pair</code>
              )}
              ， 粘贴一次性资料。
            </p>
            <label>
              配对资料
              <textarea
                rows={7}
                value={pairing}
                spellCheck={false}
                onChange={(event) => setPairing(event.target.value)}
                required
              />
            </label>
            <label>
              设备名称
              <input
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
                required
              />
            </label>
            <button className="primary" disabled={busy} type="submit">
              {busy ? "正在建立安全连接…" : "配对并继续"}
            </button>
          </form>
        </details>

        {input.onScenario === undefined ? null : (
          <div className={styles.scenarioActions}>
            <span>开发与测试</span>
            <button
              type="button"
              onClick={() => input.onScenario?.(admin ? "admin" : "user")}
            >
              打开 ScenarioGateway
            </button>
          </div>
        )}
        {error === undefined ? null : (
          <div className={styles.feedback}>
            <StatusMessage tone="error">{error}</StatusMessage>
          </div>
        )}
      </section>
    </main>
  );
}

function defaultRelayEndpoint(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/relay`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "连接失败";
}
