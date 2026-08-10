import type {
  AdminAuditEvent,
  AdminHostStatus,
  AdminRecoveryStartResult,
  AdminUserSummary,
} from "@codex-everywhere/protocol";

import {
  GatewayClient,
  GatewayReauthenticationRequired,
  TemporaryPasswordReauthenticationRequired,
  validatePairingDocument,
  type PairingDocument,
  type RelayHostDocument,
} from "./gateway-client.js";
import {
  CONNECTION_KEEPALIVE_INTERVAL_MS,
  CONNECTION_KEEPALIVE_TIMEOUT_MS,
  ConnectionRetryWakeup,
  isRetryableConnectionFailure,
  reconnectWithUnlimitedAttempts,
  shouldRecoverAfterHealthCheckFailure,
  shouldVerifyAfterVisibilityChange,
} from "./connection-recovery.js";
import { deleteHost, listHosts, type SavedHost } from "./storage.js";
import { initializeTheme } from "./theme.js";
import { mountPwaUpdatePrompt } from "./pwa-update.js";

const app = requiredElement<HTMLDivElement>("app");
initializeTheme();

let client: GatewayClient | undefined;
let reauthenticationClient: GatewayClient | undefined;
let unsubscribeClientConnection: (() => void) | undefined;
let connectionRecovery:
  | {
      client: GatewayClient;
      promise: Promise<void>;
      wakeup: ConnectionRetryWakeup;
    }
  | undefined;
let connectionVerification:
  { client: GatewayClient; promise: Promise<void> } | undefined;
let connectionKeepaliveTimer: number | undefined;
let users: AdminUserSummary[] = [];
let selectedSection: "overview" | "users" | "audit" | "settings" = "overview";

app.innerHTML = `
  <div class="admin-app">
    <header class="admin-topbar">
      <a class="admin-brand" href="/admin"><span class="brand-mark">CE</span><span><strong>CodexEverywhere</strong><small>HOST ADMIN</small></span></a>
      <div class="admin-top-actions"><span id="admin-connection" class="admin-connection" role="status" aria-live="polite" aria-atomic="true" aria-label="管理连接状态：未连接"><i aria-hidden="true"></i><b aria-hidden="true">×</b><span>未连接</span></span><a class="ghost admin-user-link" href="/">用户界面</a><button id="admin-logout" class="ghost" type="button" hidden>退出</button></div>
    </header>

    <main id="admin-login" class="admin-login-shell">
      <section class="admin-login-card">
        <div class="admin-login-heading"><p class="eyebrow">Host control plane</p><h1>宿主机管理</h1><p>管理现有 SSH 用户的 CodexEverywhere Web 访问。这里不能读取用户会话、工作区、文件或 Codex 凭据。</p></div>
        <div id="admin-saved-section" hidden><h2>已保存的管理员设备</h2><div id="admin-saved-hosts" class="admin-saved-hosts"></div><div class="admin-divider"><span>或</span></div></div>
        <form id="admin-login-form" autocomplete="on">
          <label>管理员标识<input id="admin-handle" name="username" autocomplete="username webauthn" placeholder="例如 hpc-admin" required /></label>
          <label>Relay 地址<input id="admin-relay" inputmode="url" spellcheck="false" autocomplete="off" /></label>
          <div class="admin-login-actions"><button id="admin-passkey-login" class="primary" type="button">使用 Passkey 登录</button><button id="admin-password-toggle" class="secondary" type="button">使用管理员密码</button></div>
          <div id="admin-password-panel" class="admin-password-panel" hidden>
            <label>管理员密码<input id="admin-password" name="password" type="password" autocomplete="current-password" /></label>
            <label class="check-row"><input id="admin-remember" type="checkbox" />在此浏览器保存管理员设备</label>
            <button id="admin-password-login" class="primary" type="submit">登录</button>
          </div>
        </form>
        <details class="admin-first-use"><summary>首次初始化管理员设备</summary><p>在 Controller 运行账号下执行 <code>ce admin web pair</code>，粘贴输出并注册第一个管理员 Passkey。</p><label>一次性配对资料<textarea id="admin-pairing-json" rows="7" spellcheck="false" autocomplete="off"></textarea></label><label>设备名称<input id="admin-pairing-device" value="管理员浏览器" autocomplete="off" /></label><button id="admin-pair" class="secondary" type="button">配对管理员设备</button></details>
        <p id="admin-login-error" class="error" role="alert"></p>
      </section>
    </main>

    <main id="admin-dashboard" class="admin-dashboard" hidden>
      <aside class="admin-sidebar">
        <div><p class="eyebrow">Administration</p><strong id="admin-server-label">宿主机</strong></div>
        <nav aria-label="管理页面"><button data-admin-section="overview" class="active">概览</button><button data-admin-section="users">用户</button><button data-admin-section="audit">审计</button><button data-admin-section="settings">安全设置</button></nav>
        <div class="admin-boundary"><strong>管理边界</strong><span>仅管理 Web 开通、停用、恢复和移除。SSH、Linux 账号及 Codex 数据不在此页面内。</span></div>
      </aside>
      <section class="admin-content">
        <div id="admin-dashboard-error" class="admin-inline-error" hidden></div>
        <section id="admin-overview-section" class="admin-section">
          <div class="admin-page-heading"><div><p class="eyebrow">Host status</p><h1>概览</h1></div><button id="admin-refresh" class="secondary" type="button">刷新</button></div>
          <div id="admin-password-warning" class="admin-warning" hidden><div><strong>尚未设置管理员密码</strong><span>当前可使用 Passkey 登录。你也可以在安全设置中添加独立管理员密码。</span></div><button data-open-settings class="secondary">设置密码</button></div>
          <div id="admin-metrics" class="admin-metrics"></div>
          <div class="admin-panel"><div class="admin-panel-heading"><div><h2>最近管理状态</h2><p>只显示访问状态，不连接任何用户的 Codex app-server。</p></div></div><div id="admin-recent-users"></div></div>
        </section>

        <section id="admin-users-section" class="admin-section" hidden>
          <div class="admin-page-heading"><div><p class="eyebrow">Existing Unix accounts</p><h1>用户</h1><p>只可按精确用户名检查 NSS，不枚举系统账号。</p></div></div>
          <form id="admin-user-inspect" class="admin-inspect-form"><input id="admin-inspect-name" autocomplete="off" placeholder="输入现有 SSH 用户名" /><button class="secondary" type="submit">检查用户</button></form>
          <div id="admin-inspect-result"></div>
          <div class="admin-panel"><div class="admin-panel-heading"><div><h2>已登记用户</h2><p>停用 Web 不会中断用户的 SSH、Codex TUI 或正在运行的任务。</p></div></div><div id="admin-users-table" class="admin-table-wrap"></div></div>
        </section>

        <section id="admin-audit-section" class="admin-section" hidden>
          <div class="admin-page-heading"><div><p class="eyebrow">Security log</p><h1>审计</h1><p>记录管理动作、目标、结果与时间，不记录用户业务数据。</p></div><button id="admin-refresh-audit" class="secondary" type="button">刷新</button></div>
          <div class="admin-panel"><div id="admin-audit-table" class="admin-table-wrap"></div></div>
        </section>

        <section id="admin-settings-section" class="admin-section" hidden>
          <div class="admin-page-heading"><div><p class="eyebrow">Administrator identity</p><h1>安全设置</h1><p>管理员 Passkey 和密码只属于此宿主机管理身份。</p></div></div>
          <div class="admin-settings-grid">
            <form id="admin-set-password" class="admin-panel" autocomplete="off"><h2>管理员密码</h2><p>采用 OPAQUE 注册；宿主机只保存 registration record，不保存可验证的密码哈希，也不会接触 SSH 密码。密码至少 9 个字符，并同时包含字母和数字。</p><label>新密码<input id="admin-new-password" type="password" autocomplete="new-password" minlength="9" required /></label><label>确认密码<input id="admin-confirm-password" type="password" autocomplete="new-password" minlength="9" required /></label><button class="primary" type="submit">设置或轮换密码</button><p id="admin-password-state" class="step-state"></p></form>
            <div class="admin-panel"><h2>Passkey 与恢复码</h2><p>可为当前管理员身份添加另一个 Passkey，或轮换本地恢复码。</p><div class="admin-stack-actions"><button id="admin-add-passkey" class="secondary" type="button">添加 Passkey</button><button id="admin-rotate-recovery" class="secondary" type="button">轮换恢复码</button></div></div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <dialog id="admin-secret-dialog" class="admin-secret-dialog"><div><div class="dialog-heading"><div><p class="eyebrow">One-time secret</p><h2 id="admin-secret-title">一次性凭据</h2></div><button id="admin-secret-close" class="icon-button" type="button">×</button></div><p id="admin-secret-help"></p><code id="admin-secret-value"></code><button id="admin-secret-copy" class="primary" type="button">复制</button><p id="admin-secret-copy-state" class="step-state"></p></div></dialog>
`;

const loginView = requiredElement<HTMLElement>("admin-login");
const dashboard = requiredElement<HTMLElement>("admin-dashboard");
const loginError = requiredElement<HTMLElement>("admin-login-error");
const handleInput = requiredElement<HTMLInputElement>("admin-handle");
const relayInput = requiredElement<HTMLInputElement>("admin-relay");
const passwordInput = requiredElement<HTMLInputElement>("admin-password");
const rememberInput = requiredElement<HTMLInputElement>("admin-remember");
const connection = requiredElement<HTMLElement>("admin-connection");

relayInput.value = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/relay`;

requiredElement("admin-password-toggle").addEventListener("click", () => {
  const panel = requiredElement<HTMLElement>("admin-password-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) passwordInput.focus();
});
requiredElement("admin-passkey-login").addEventListener(
  "click",
  () => void loginWithPasskey(),
);
requiredElement<HTMLFormElement>("admin-login-form").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    void loginWithPassword();
  },
);
requiredElement("admin-pair").addEventListener("click", () => void pair());
requiredElement("admin-logout").addEventListener("click", () => logout());
requiredElement("admin-refresh").addEventListener(
  "click",
  () => void refreshDashboard(),
);
requiredElement("admin-refresh-audit").addEventListener(
  "click",
  () => void renderAudit(),
);
requiredElement<HTMLFormElement>("admin-user-inspect").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    void inspectUser();
  },
);
requiredElement<HTMLFormElement>("admin-set-password").addEventListener(
  "submit",
  (event) => {
    event.preventDefault();
    void setAdminPassword();
  },
);
requiredElement("admin-add-passkey").addEventListener(
  "click",
  () =>
    void runButtonAction(
      requiredElement<HTMLButtonElement>("admin-add-passkey"),
      "正在添加…",
      async () => {
        await requiredClient().addPasskey();
        toast("已添加管理员 Passkey");
      },
    ),
);
requiredElement("admin-rotate-recovery").addEventListener(
  "click",
  () =>
    void runButtonAction(
      requiredElement<HTMLButtonElement>("admin-rotate-recovery"),
      "正在轮换…",
      async () => {
        const codes = await requiredClient().rotateRecoveryCodes();
        showSecret(
          "新的管理员恢复码",
          "旧恢复码已全部失效。此恢复码只显示一次，请离线保存。",
          codes[0] ?? "",
        );
      },
    ),
);
requiredElement("admin-secret-close").addEventListener("click", () =>
  requiredElement<HTMLDialogElement>("admin-secret-dialog").close(),
);
requiredElement("admin-secret-copy").addEventListener(
  "click",
  () => void copySecret(),
);

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-admin-section]",
)) {
  button.addEventListener("click", () => {
    const section = button.dataset.adminSection;
    if (
      section === "overview" ||
      section === "users" ||
      section === "audit" ||
      section === "settings"
    )
      showSection(section);
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-open-settings]",
))
  button.addEventListener("click", () => showSection("settings"));

void renderSavedAdmins();
mountPwaUpdatePrompt();
document.addEventListener("visibilitychange", () => {
  if (shouldVerifyAfterVisibilityChange(document.hidden)) {
    wakeAdminConnectionRecovery();
    void verifyAdminConnection();
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    wakeAdminConnectionRecovery();
    void verifyAdminConnection();
  }
});
window.addEventListener("offline", () => {
  setAdminConnectionState("connecting", "网络状态变化，正在确认管理通道…");
  wakeAdminConnectionRecovery();
  void verifyAdminConnection();
});
window.addEventListener("online", () => {
  wakeAdminConnectionRecovery();
  void verifyAdminConnection();
});

async function pair(): Promise<void> {
  loginError.textContent = "";
  const button = requiredElement<HTMLButtonElement>("admin-pair");
  await runButtonAction(
    button,
    "正在配对…",
    async () => {
      const raw =
        requiredElement<HTMLTextAreaElement>("admin-pairing-json").value;
      const document = JSON.parse(raw) as PairingDocument;
      validatePairingDocument(document);
      if (document.principal !== "host-admin")
        throw new Error("这不是管理员 Controller 的配对资料");
      const result = await GatewayClient.pair(
        document,
        requiredElement<HTMLInputElement>(
          "admin-pairing-device",
        ).value.trim() || "管理员浏览器",
      );
      if (result.recoveryCodes[0])
        showSecret(
          "管理员恢复码",
          "只显示一次。请离线保存；它不能恢复普通用户的 Web 身份。",
          result.recoveryCodes[0],
        );
      await activate(result.client);
    },
    loginError,
  );
}

async function loginWithPasskey(): Promise<void> {
  loginError.textContent = "";
  const button = requiredElement<HTMLButtonElement>("admin-passkey-login");
  await runButtonAction(
    button,
    "正在验证…",
    async () => {
      const reauthentication = adminReauthenticationFor(requiredHandle());
      if (reauthentication) {
        await activate(
          await reauthentication.reauthenticateWithPasskey(
            rememberInput.checked,
          ),
        );
      } else {
        const target = await lookupAdmin();
        await activate(
          await GatewayClient.loginWithPasskey(target, {
            loginName: requiredHandle(),
            deviceName: "临时管理员浏览器",
            rememberDevice: false,
          }),
        );
      }
    },
    loginError,
  );
}

async function loginWithPassword(): Promise<void> {
  loginError.textContent = "";
  const button = requiredElement<HTMLButtonElement>("admin-password-login");
  await runButtonAction(
    button,
    "正在登录…",
    async () => {
      if (!passwordInput.value) throw new Error("请输入管理员密码");
      const handle = requiredHandle();
      const reauthentication = adminReauthenticationFor(handle);
      const next = reauthentication
        ? await reauthentication.reauthenticateWithPassword(
            passwordInput.value,
            rememberInput.checked,
          )
        : await GatewayClient.loginWithPassword(await lookupAdmin(), {
            loginName: handle,
            password: passwordInput.value,
            deviceName: rememberInput.checked
              ? "管理员浏览器"
              : "临时管理员浏览器",
            rememberDevice: rememberInput.checked,
          });
      passwordInput.value = "";
      await activate(next);
    },
    loginError,
  );
}

function adminReauthenticationFor(handle: string): GatewayClient | undefined {
  const candidate = reauthenticationClient;
  if (!candidate) return undefined;
  const expected = candidate.host.loginName ?? candidate.host.name;
  return expected === handle ? candidate : undefined;
}

async function lookupAdmin(): Promise<RelayHostDocument> {
  const relay = relayInput.value.trim();
  if (!relay) throw new Error("请输入 Relay 地址");
  return GatewayClient.lookupRelay(relay, requiredHandle(), "host-admin");
}

function requiredHandle(): string {
  const handle = handleInput.value.trim();
  if (!handle) throw new Error("请输入管理员标识");
  return handle;
}

async function activate(next: GatewayClient): Promise<void> {
  wakeAdminConnectionRecovery();
  clearAdminConnectionKeepalive();
  unsubscribeClientConnection?.();
  unsubscribeClientConnection = undefined;
  const previous = client;
  const reauthenticated =
    reauthenticationClient?.host.deviceId === next.host.deviceId
      ? reauthenticationClient
      : undefined;
  if (reauthenticated) reauthenticationClient = undefined;
  client = next;
  previous?.close();
  if (reauthenticated !== previous) reauthenticated?.close();
  unsubscribeClientConnection = next.onConnectionLost(() => {
    if (client !== next) return;
    setAdminConnectionState(
      navigator.onLine ? "connecting" : "offline",
      navigator.onLine ? "管理通道已断开" : "网络已断开",
    );
    if (document.hidden && !next.canReconnectSilently) return;
    window.setTimeout(() => {
      if (client === next) void recoverAdminConnection(next);
    }, 250);
  });
  scheduleAdminConnectionKeepalive(next);
  loginView.hidden = true;
  dashboard.hidden = false;
  requiredElement("admin-logout").hidden = false;
  setAdminConnectionState("online", "管理通道已连接");
  await refreshDashboard();
}

function logout(): void {
  wakeAdminConnectionRecovery();
  clearAdminConnectionKeepalive();
  unsubscribeClientConnection?.();
  unsubscribeClientConnection = undefined;
  client?.close();
  client = undefined;
  dashboard.hidden = true;
  loginView.hidden = false;
  requiredElement("admin-logout").hidden = true;
  setAdminConnectionState("offline", "未连接");
  void renderSavedAdmins();
}

function setAdminConnectionState(
  state: "online" | "offline" | "connecting",
  label: string,
): void {
  connection.classList.toggle("online", state === "online");
  connection.classList.toggle("connecting", state === "connecting");
  connection.querySelector("b")!.textContent =
    state === "online" ? "✓" : state === "connecting" ? "…" : "×";
  connection.querySelector("span")!.textContent = label;
  connection.setAttribute("aria-label", `管理连接状态：${label}`);
}

async function verifyAdminConnection(): Promise<void> {
  const current = client;
  if (
    !current ||
    (document.hidden && !current.canReconnectSilently) ||
    connectionRecovery?.client === current
  )
    return;
  const existing = connectionVerification;
  if (existing?.client === current) return existing.promise;
  const verify = async () => {
    try {
      await current.healthCheck(CONNECTION_KEEPALIVE_TIMEOUT_MS);
      if (client === current)
        setAdminConnectionState("online", "管理通道已连接");
    } catch (error) {
      if (client === current && shouldRecoverAfterHealthCheckFailure(error)) {
        await recoverAdminConnection(current);
      }
    }
  };
  const tracked = verify().finally(() => {
    if (connectionVerification?.promise === tracked)
      connectionVerification = undefined;
  });
  connectionVerification = { client: current, promise: tracked };
  return tracked;
}

async function recoverAdminConnection(previous: GatewayClient): Promise<void> {
  const existing = connectionRecovery;
  if (existing?.client === previous) return existing.promise;
  const wakeup = new ConnectionRetryWakeup();
  const recovery = async () => {
    try {
      const next = await reconnectWithUnlimitedAttempts({
        isCurrent: () => client === previous,
        canAttempt: () => !document.hidden || previous.canReconnectSilently,
        reconnect: () =>
          previous.reconnect({ canInteract: () => !document.hidden }),
        isRetryable: (error) =>
          (document.hidden &&
            error instanceof GatewayReauthenticationRequired) ||
          isRetryableConnectionFailure(error),
        wait: (delayMs) => wakeup.wait(delayMs),
        waitForAttempt: () => wakeup.wait(30_000),
        onBeforeAttempt: () =>
          setAdminConnectionState("connecting", "正在恢复管理通道…"),
      });
      if (!next) return;
      if (client !== previous) {
        next.close();
        return;
      }
      await activate(next);
      if (client === next) toast("管理通道已恢复");
    } catch (error) {
      if (client !== previous) return;
      if (error instanceof TemporaryPasswordReauthenticationRequired) {
        showAdminReauthentication(previous, true);
        return;
      }
      showAdminReauthentication(previous, false);
    }
  };
  const tracked = recovery().finally(() => {
    if (connectionRecovery?.promise === tracked) connectionRecovery = undefined;
  });
  connectionRecovery = { client: previous, promise: tracked, wakeup };
  return tracked;
}

function wakeAdminConnectionRecovery(): void {
  connectionRecovery?.wakeup.wake();
}

function scheduleAdminConnectionKeepalive(expectedClient: GatewayClient): void {
  clearAdminConnectionKeepalive();
  connectionKeepaliveTimer = window.setTimeout(() => {
    connectionKeepaliveTimer = undefined;
    void verifyAdminConnection().finally(() => {
      if (client === expectedClient)
        scheduleAdminConnectionKeepalive(expectedClient);
    });
  }, CONNECTION_KEEPALIVE_INTERVAL_MS);
}

function clearAdminConnectionKeepalive(): void {
  if (connectionKeepaliveTimer === undefined) return;
  window.clearTimeout(connectionKeepaliveTimer);
  connectionKeepaliveTimer = undefined;
}

function showAdminReauthentication(
  previous: GatewayClient,
  temporaryPassword: boolean,
): void {
  if (client !== previous) return;
  clearAdminConnectionKeepalive();
  unsubscribeClientConnection?.();
  unsubscribeClientConnection = undefined;
  reauthenticationClient = previous;
  client = undefined;
  dashboard.hidden = true;
  loginView.hidden = false;
  requiredElement("admin-logout").hidden = true;
  handleInput.value = previous.host.loginName ?? previous.host.name;
  rememberInput.checked = !temporaryPassword;
  setAdminConnectionState("offline", "请重新登录");
  loginError.textContent = temporaryPassword
    ? "临时管理员密码不会保存在浏览器中。请重新输入密码或使用 Passkey。"
    : "管理员设备授权或登录状态已失效。请使用 Passkey 或管理员密码重新登录。";
}

async function refreshDashboard(): Promise<void> {
  const error = requiredElement<HTMLElement>("admin-dashboard-error");
  error.hidden = true;
  try {
    const [status, userResult, authStatus] = await Promise.all([
      requiredClient().request<AdminHostStatus>("admin/host/status", {
        version: 1,
      }),
      requiredClient().request<{ version: 1; users: AdminUserSummary[] }>(
        "admin/users/list",
        { version: 1 },
      ),
      requiredClient().request<{ passwordEnabled: boolean }>("auth/status", {}),
    ]);
    users = userResult.users;
    renderOverview(status);
    renderUsers();
    requiredElement<HTMLElement>("admin-password-warning").hidden =
      authStatus.passwordEnabled;
    requiredElement("admin-server-label").textContent = status.serverName;
  } catch (caught) {
    error.textContent = errorMessage(caught);
    error.hidden = false;
  }
}

function renderOverview(status: AdminHostStatus): void {
  const metrics = requiredElement("admin-metrics");
  metrics.replaceChildren(
    metric(String(status.managedUsers), "已登记用户"),
    metric(String(status.enabledUsers), "已启用"),
    metric(String(status.disabledUsers), "已停用"),
    metric(String(status.pendingRemovals), "待移除"),
  );
  const recent = requiredElement("admin-recent-users");
  recent.replaceChildren();
  if (users.length === 0) {
    recent.append(
      emptyState("尚无已登记用户", "用户首次自行初始化后会出现在这里。"),
    );
    return;
  }
  const list = document.createElement("div");
  list.className = "admin-compact-users";
  for (const user of users.slice(0, 6)) list.append(userSummaryRow(user));
  recent.append(list);
}

function renderUsers(): void {
  const container = requiredElement("admin-users-table");
  container.replaceChildren();
  if (users.length === 0) {
    container.append(
      emptyState("没有已登记用户", "可检查一个现有 SSH 用户并手动登记。"),
    );
    return;
  }
  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML =
    "<thead><tr><th>用户</th><th>Web 状态</th><th>Agent</th><th>更新时间</th><th>操作</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const user of users) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    identity.append(
      text("strong", user.username),
      text("small", `UID ${user.uid}`),
    );
    const status = document.createElement("td");
    status.append(statusBadge(user));
    if (user.removeAfter)
      status.append(
        text("small", `计划于 ${formatTime(user.removeAfter)} 移除`),
      );
    const online = document.createElement("td");
    online.textContent = user.agentOnline ? "在线" : "离线";
    const updated = document.createElement("td");
    updated.textContent = formatTime(user.updatedAt);
    const actions = document.createElement("td");
    actions.className = "admin-row-actions";
    appendUserActions(actions, user);
    row.append(identity, status, online, updated, actions);
    body.append(row);
  }
  table.append(body);
  container.append(table);
}

function appendUserActions(
  container: HTMLElement,
  user: AdminUserSummary,
): void {
  if (user.status === "removing") {
    container.append(text("span", "正在由宿主机维护任务执行"));
    return;
  }
  if (user.status === "removal_pending") {
    container.append(actionButton("取消移除", "admin/removal/cancel", user));
    return;
  }
  if (user.status === "enabled") {
    container.append(
      actionButton("恢复 Web 身份", "admin/recovery/start", user),
      actionButton("停用 Web", "admin/user/disable", user),
      actionButton("计划移除", "admin/removal/schedule", user, true),
    );
    return;
  }
  container.append(actionButton("重新启用", "admin/user/enable", user));
}

function actionButton(
  label: string,
  method: string,
  user: AdminUserSummary,
  destructive = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = destructive ? "danger subtle" : "ghost subtle";
  button.textContent = label;
  button.addEventListener(
    "click",
    () =>
      void runButtonAction(
        button,
        "提交中…",
        async () => {
          if (
            method === "admin/removal/schedule" &&
            !window.confirm(
              `将在 24 小时后移除 ${user.username} 的 CodexEverywhere 状态。期间可以取消；不会删除 ~/.codex 或工作区。继续吗？`,
            )
          )
            return;
          const result = await requiredClient().request<
            AdminUserSummary | AdminRecoveryStartResult
          >(method, {
            version: 1,
            username: user.username,
            expectedRevision: user.revision,
          });
          if (method === "admin/recovery/start") {
            const recovery = result as AdminRecoveryStartResult;
            showSecret(
              `${user.username} 的临时恢复交接码`,
              `10 分钟内交给用户。用户在普通登录页的“恢复 Web 身份”中输入；兑换后会生成只有用户可见的新恢复码。`,
              recovery.handoffCode,
            );
          }
          await refreshDashboard();
        },
        requiredElement<HTMLElement>("admin-dashboard-error"),
      ),
  );
  return button;
}

async function inspectUser(): Promise<void> {
  const name =
    requiredElement<HTMLInputElement>("admin-inspect-name").value.trim();
  if (!name) return;
  const resultContainer = requiredElement("admin-inspect-result");
  resultContainer.replaceChildren(text("p", "正在检查…"));
  try {
    const result = await requiredClient().request<{
      eligibility: {
        eligible: boolean;
        reason?: string;
        account?: { username: string; uid: number; home: string };
      };
      managed?: AdminUserSummary;
    }>("admin/user/inspect", { version: 1, username: name });
    const card = document.createElement("div");
    card.className = "admin-inspect-result";
    if (!result.eligibility.eligible) {
      card.append(
        text("strong", "不可开通"),
        text("span", result.eligibility.reason ?? "该账号不符合条件"),
      );
    } else {
      card.append(
        text("strong", `${name} 可以使用 CodexEverywhere`),
        text(
          "span",
          `UID ${result.eligibility.account?.uid} · ${result.eligibility.account?.home}`,
        ),
      );
      if (!result.managed) {
        const register = document.createElement("button");
        register.className = "primary";
        register.textContent = "登记用户";
        register.addEventListener(
          "click",
          () =>
            void runButtonAction(register, "正在登记…", async () => {
              await requiredClient().request("admin/user/register", {
                version: 1,
                username: name,
              });
              resultContainer.replaceChildren();
              await refreshDashboard();
            }),
        );
        card.append(register);
      } else card.append(statusBadge(result.managed));
    }
    resultContainer.replaceChildren(card);
  } catch (caught) {
    resultContainer.replaceChildren(text("p", errorMessage(caught), "error"));
  }
}

async function renderAudit(): Promise<void> {
  const container = requiredElement("admin-audit-table");
  container.replaceChildren(text("p", "正在读取…"));
  try {
    const result = await requiredClient().request<{
      version: 1;
      events: AdminAuditEvent[];
    }>("admin/audit/list", { version: 1, limit: 200 });
    if (result.events.length === 0) {
      container.replaceChildren(
        emptyState("尚无管理操作", "管理动作会记录在这里。"),
      );
      return;
    }
    const table = document.createElement("table");
    table.className = "admin-table";
    table.innerHTML =
      "<thead><tr><th>时间</th><th>操作</th><th>目标</th><th>管理员设备</th><th>结果</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const event of result.events) {
      const row = document.createElement("tr");
      row.append(
        text("td", formatTime(event.createdAt)),
        text("td", actionLabel(event.action)),
        text("td", event.targetUsername ?? "—"),
        text("td", event.actor.replace("device:", "设备 ")),
        text("td", event.result === "succeeded" ? "成功" : "失败"),
      );
      body.append(row);
    }
    table.append(body);
    container.replaceChildren(table);
  } catch (caught) {
    container.replaceChildren(text("p", errorMessage(caught), "error"));
  }
}

async function setAdminPassword(): Promise<void> {
  const password = requiredElement<HTMLInputElement>("admin-new-password");
  const confirm = requiredElement<HTMLInputElement>("admin-confirm-password");
  const state = requiredElement<HTMLElement>("admin-password-state");
  const button =
    requiredElement<HTMLFormElement>(
      "admin-set-password",
    ).querySelector<HTMLButtonElement>("button")!;
  state.textContent = "";
  if (password.value !== confirm.value) {
    state.textContent = "两次输入的密码不一致";
    return;
  }
  await runButtonAction(
    button,
    "正在保存…",
    async () => {
      await requiredClient().setPassword(password.value);
      password.value = "";
      confirm.value = "";
      state.textContent = "管理员密码已设置。旧密码（如有）已失效。";
      requiredElement<HTMLElement>("admin-password-warning").hidden = true;
    },
    state,
  );
}

function showSection(section: typeof selectedSection): void {
  selectedSection = section;
  for (const candidate of ["overview", "users", "audit", "settings"] as const)
    requiredElement<HTMLElement>(`admin-${candidate}-section`).hidden =
      candidate !== section;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-admin-section]",
  ))
    button.classList.toggle("active", button.dataset.adminSection === section);
  if (section === "audit") void renderAudit();
}

async function renderSavedAdmins(): Promise<void> {
  const hosts = (await listHosts()).filter((host) => host.kind === "admin");
  const section = requiredElement<HTMLElement>("admin-saved-section");
  const container = requiredElement("admin-saved-hosts");
  container.replaceChildren();
  section.hidden = hosts.length === 0;
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "admin-saved-host";
    const info = document.createElement("div");
    info.append(
      text("strong", host.loginName ?? host.name),
      text("small", host.deviceName),
    );
    const connect = document.createElement("button");
    connect.className = "primary";
    connect.textContent = "继续";
    connect.addEventListener("click", () => {
      void runButtonAction(
        connect,
        "连接中…",
        async () => activate(await GatewayClient.connect(host)),
        loginError,
      );
    });
    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.textContent = "移除";
    remove.addEventListener("click", async () => {
      await deleteHost(host.id);
      await renderSavedAdmins();
    });
    row.append(info, connect, remove);
    container.append(row);
  }
}

function metric(value: string, label: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "admin-metric";
  card.append(text("strong", value), text("span", label));
  return card;
}

function userSummaryRow(user: AdminUserSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = "admin-compact-user";
  const identity = document.createElement("div");
  identity.append(
    text("strong", user.username),
    text("small", `UID ${user.uid}`),
  );
  row.append(
    identity,
    statusBadge(user),
    text("span", user.agentOnline ? "Agent 在线" : "Agent 离线"),
  );
  return row;
}

function statusBadge(user: AdminUserSummary): HTMLElement {
  const labels: Record<AdminUserSummary["status"], string> = {
    enabled: "已启用",
    disabled: "已停用",
    removal_pending: "等待移除",
    removing: "正在移除",
    removed: "已移除",
  };
  return text("span", labels[user.status], `admin-status ${user.status}`);
}

function emptyState(title: string, detail: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "admin-empty";
  element.append(text("strong", title), text("span", detail));
  return element;
}

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function runButtonAction(
  button: HTMLButtonElement,
  pendingLabel: string,
  operation: () => Promise<void>,
  errorTarget?: HTMLElement,
): Promise<void> {
  if (button.disabled) return;
  const original = button.textContent ?? "";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = pendingLabel;
  if (errorTarget) {
    errorTarget.textContent = "";
    if (errorTarget.id === "admin-dashboard-error") errorTarget.hidden = true;
  }
  try {
    await operation();
  } catch (caught) {
    if (errorTarget) {
      errorTarget.textContent = errorMessage(caught);
      errorTarget.hidden = false;
    } else toast(errorMessage(caught), true);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = original;
  }
}

function showSecret(title: string, help: string, value: string): void {
  requiredElement("admin-secret-title").textContent = title;
  requiredElement("admin-secret-help").textContent = help;
  requiredElement("admin-secret-value").textContent = value;
  requiredElement("admin-secret-copy-state").textContent = "";
  requiredElement<HTMLDialogElement>("admin-secret-dialog").showModal();
}

async function copySecret(): Promise<void> {
  const value = requiredElement("admin-secret-value").textContent ?? "";
  await navigator.clipboard.writeText(value);
  requiredElement("admin-secret-copy-state").textContent = "已复制";
}

function toast(message: string, failure = false): void {
  const item = document.createElement("div");
  item.className = `admin-toast${failure ? " failure" : ""}`;
  item.textContent = message;
  document.body.append(item);
  setTimeout(() => item.remove(), 4_000);
}

function requiredClient(): GatewayClient {
  if (!client) throw new Error("管理员通道未连接");
  return client;
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing administrator UI element: ${id}`);
  return element as T;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "admin/user/register": "登记用户",
    "admin/user/disable": "停用 Web",
    "admin/user/enable": "启用 Web",
    "admin/recovery/start": "发起身份恢复",
    "admin/removal/schedule": "计划移除",
    "admin/removal/cancel": "取消移除",
  };
  return labels[action] ?? action;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
