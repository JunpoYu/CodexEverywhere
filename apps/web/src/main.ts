import type {
  AskForApproval,
  Model,
  SandboxPolicy,
  ThreadReadResponse,
  ThreadForkResponse,
  ThreadListParams,
  ThreadResumeResponse,
  ThreadSettings,
  ThreadStartResponse,
  ThreadStatus,
  ThreadTokenUsage,
  Turn,
  TurnStartResponse,
  TurnsPage,
  UserInput,
} from "@codex-everywhere/codex-app-server-schema/v2";
import type { ReasoningEffort } from "@codex-everywhere/codex-app-server-schema";
import {
  CODEX_INSTALL_PROGRESS_EVENT,
  GATEWAY_CAPABILITIES,
  IDEMPOTENCY_OUTCOME_INDETERMINATE,
  type CodexAuthImportResult,
  type CodexVersionStatus,
  type EventEnvelope,
  type SessionPermissionDefaults,
} from "@codex-everywhere/protocol";

import {
  GatewayClient,
  GatewayReauthenticationRequired,
  GatewayResponseError,
  GatewayRequestOutcomeUnknownError,
  TemporaryPasswordReauthenticationRequired,
  isGatewayRequestOutcomeUnknown,
  type HostDocument,
  type PairingDocument,
} from "./gateway-client.js";
import { ApprovalSubmissionTracker } from "./approval-submission.js";
import {
  ComposerTurnSnapshotReader,
  composerOperationOutcome,
  composerReconciliationAction,
  composerTurnSnapshotCoversOperation,
  type ComposerOperationKind,
} from "./composer-outcome.js";
import { createCoalescedTask } from "./coalesced-task.js";
import {
  CONNECTION_KEEPALIVE_INTERVAL_MS,
  CONNECTION_KEEPALIVE_TIMEOUT_MS,
  ConnectionRetryWakeup,
  isRetryableConnectionFailure,
  reconnectWithUnlimitedAttempts,
  shouldRecoverAfterHealthCheckFailure,
  shouldVerifyAfterVisibilityChange,
} from "./connection-recovery.js";
import { ConversationOutlineView } from "./conversation-outline.js";
import {
  codexVersionFromCliOutput,
  codexVersionPresentation,
} from "./codex-version.js";
import {
  codexLoginEventAction,
  shouldRenderInThreadTimeline,
} from "./event-routing.js";
import {
  shouldDismissDialogFromBackdrop,
  shouldPreventDialogCancel,
} from "./dialog-behavior.js";
import {
  CODEX_INSTALL_STEP_COUNT,
  codexInstallProgressPresentation,
} from "./install-progress.js";
import {
  devicePersistenceMode,
  rememberDeviceForLogin,
  type WebLoginMethod,
} from "./login-preferences.js";
import {
  approvalPresentation,
  contextUsagePresentation,
  mcpElicitationResponse,
  sandboxModeForPolicy,
} from "./session-controls.js";
import { savedHostDisplayName, savedHostLoginName } from "./saved-host-view.js";
import {
  offersSideCommandCompletion,
  parseWebComposerCommand,
  sideRecoveryDisposition,
  sideVisibleTurns,
} from "./side-command.js";
import { deleteHost, listHosts, saveHost, type SavedHost } from "./storage.js";
import {
  initializeTheme,
  normalizeThemePreference,
  themePreferenceLabel,
} from "./theme.js";
import {
  isTurn,
  queuedMessageText,
  threadSendMode,
  ThreadTimelineView,
} from "./thread-view.js";
import {
  mergeThreadPages,
  requestThreadList,
  threadListErrorMessage,
} from "./thread-list.js";
import {
  HISTORY_PAGE_SIZE,
  mergeEphemeralCompletedTurn,
  newestPageInReadingOrder,
  readEphemeralThreadRepairSnapshot,
  readThreadRepairSnapshot,
  readEphemeralThreadHistory,
  retainRepairHistoryCursor,
  resumeThreadHistory,
  threadHistorySyncStrategy,
  type OpenThreadHistory,
  type ThreadHistoryMode,
} from "./thread-history.js";
import {
  clearUnresolvedThreadStartMarker,
  hasUnresolvedThreadStartMarker,
  markThreadStartUnresolved,
} from "./thread-start-marker.js";
import { mountPwaUpdatePrompt } from "./pwa-update.js";
import {
  steerableQueueItemIds,
  type QueueSteerItemStatus,
} from "./queue-steer-visibility.js";
import {
  GatewayMutationRecoveryPendingError,
  requestRecoverableGatewayMutation,
} from "./recoverable-mutation.js";
import {
  dismissTuiHandoffHint,
  isTuiHandoffHintDismissed,
  setTuiHandoffVisibility,
  tuiHandoffCommand,
  tuiPickerCommand,
} from "./tui-handoff.js";
import {
  ALL_WORKSPACES,
  groupThreadsByCwd,
  threadsInWorkspace,
  workspaceContainsCwd,
  workspaceForCwd,
  workspaceRelativeCwd,
} from "./workspace-view.js";

const APP_SERVER_RESTART_REQUEST_TIMEOUT_MS = 90_000;

type ThreadSummary = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  status: unknown;
  updatedAt: number;
};

type ThreadListPage = {
  data: ThreadSummary[];
  nextCursor?: string | null;
};

type SetupStatus = {
  networkConfigured: boolean;
  networkMode: "direct" | "proxy";
  codex: { installed: boolean; binary?: string; version?: string };
  appServerRunning: boolean;
};

type AccountStatus = {
  account: null | { type: string; email?: string | null };
  requiresOpenaiAuth: boolean;
};

type WorkspaceProfile = {
  roots: string[];
  defaultRoot?: string;
};

type WorkspaceBrowseResponse = {
  path: string;
  home: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
  truncated: boolean;
};

type QueueItem = {
  id: string;
  threadId: string;
  turnPayload: Record<string, unknown>;
  status: QueueSteerItemStatus;
};

type PendingComposerOperation = {
  kind: ComposerOperationKind;
  operationId: string;
  idempotencyKey: string;
  deviceId: string;
  threadId: string;
  input: UserInput[];
  text: string;
  reconciliationStartedAt: number;
  authoritativeChecks: number;
  reconciliationBoundaryTurnId?: string;
  manualReviewRequired: boolean;
  manualReviewReason?:
    "history-unavailable" | "host-indeterminate" | "side-unavailable";
};

type PendingThreadStartOperation = {
  operationId: string;
  idempotencyKey: string;
  deviceId: string;
  threadPayload: Record<string, unknown>;
  prompt: string;
  effort: string;
  previousThreadId?: string;
  outcomeUnknown: boolean;
  manualReviewRequired: boolean;
};

type ThreadRuntimeSettings = {
  model: string;
  effort: ReasoningEffort | null;
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
};

type ActiveSideSession = {
  threadId: string;
  parent: ThreadSummary;
  inheritedThroughTurnId: string;
  appServerInstanceId: string;
  fallbackDetail: ThreadResumeResponse;
  firstSideTurnId?: string;
};

type SideThreadForkResponse = ThreadForkResponse & {
  sideFork: {
    version: 1;
    inheritedThroughTurnId: string | null;
    appServerInstanceId: string;
  };
};

type NodeStatus = {
  appServerInstanceId?: string;
};

type PendingSideForkOperation = {
  idempotencyKey: string;
  deviceId: string;
  parent: ThreadSummary;
  prompt: string;
  inheritedThroughTurnId: string;
  outcomeUnknown: boolean;
  manualReviewRequired: boolean;
};

class SideCapabilityUnavailableAfterRecovery extends Error {}

const app = requiredElement<HTMLDivElement>("app");
const themeController = initializeTheme();
const threadStartMarkerStorage = availableSessionStorage();
let threadStartSafetyMarkerArmed = hasUnresolvedThreadStartMarker(
  threadStartMarkerStorage,
);
let threadStartReloadReviewRequired = threadStartSafetyMarkerArmed;
let client: GatewayClient | undefined;
let temporaryReauthenticationClient: GatewayClient | undefined;
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
let activeThreadId: string | undefined;
let activeThreadCwd: string | undefined;
let selectedWorkspaceScope: string | undefined;
let workspaceRoots: string[] = [];
let defaultWorkspaceRoot: string | undefined;
let threadsCache: ThreadSummary[] = [];
let threadListNextCursor: string | null = null;
let threadListArchived = false;
let threadListLoadingMore = false;
let threadListRequestEpoch = 0;
let savedHostsCache: SavedHost[] = [];
let codexModels: Model[] = [];
let provisionStatus: SetupStatus | undefined;
let appServerRestartRequired = false;
let pendingCodexLoginId: string | undefined;
let codexLoginMonitorGeneration = 0;
let codexLoginFinalizing = false;
let selectedCodexAuthFile: File | undefined;
let openThreadSequence = 0;
let activeThreadStatus: ThreadStatus | undefined;
let activeTurnId: string | undefined;
let activeNewestTurnId: string | undefined;
let threadSyncTimer: number | undefined;
let threadSyncInFlight = false;
let threadHistoryInitializationSequence: number | undefined;
let activeHistoryNextCursor: string | undefined;
let activeHistoryPaginationExhausted = false;
let activeHistoryExhaustedNewestTurnId: string | undefined;
let activeHistoryMode: ThreadHistoryMode = "none";
let olderHistoryLoading = false;
let lastRealtimeEventAt = 0;
let activeThreadSettings: ThreadRuntimeSettings | undefined;
let activeThreadTokenUsage: ThreadTokenUsage | undefined;
let activeSideSession: ActiveSideSession | undefined;
let threadSettingsPendingNextTurn = false;
let directoryPickerTarget: "session" | "workspace" = "session";
let directoryBrowseState: WorkspaceBrowseResponse | undefined;
let directoryBrowseSequence = 0;
const pendingRequestIds = new Set<string>();
const approvalSubmissions = new ApprovalSubmissionTracker();
const threadUnsubscribeOperations = new Map<string, Promise<void>>();
const threadDirectoryOpenState = new Map<string, boolean>();
let composerSubmitting = false;
const queuedItems = new Map<string, QueueItem>();
const pendingComposerOperations = new Map<string, PendingComposerOperation>();
const inFlightComposerOperations = new Set<string>();
const composerReconciliations = new Set<string>();
const composerTurnSnapshotReader = new ComposerTurnSnapshotReader();
let pendingComposerReconciliationTimer: number | undefined;
let pendingThreadStartOperation: PendingThreadStartOperation | undefined;
let threadStartReconciliation: Promise<void> | undefined;
let pendingSideForkOperation: PendingSideForkOperation | undefined;
let sideForkReconciliation: Promise<void> | undefined;
const restoringArchivedThreads = new Set<string>();
let expandedApprovalId: string | undefined;
let sessionPermissionDefaults: SessionPermissionDefaults = {
  version: 1,
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
};
const runCoalescedRefresh = createCoalescedTask(performRefresh);
const THREAD_LIST_PAGE_SIZE = 100;
const COMPOSER_RECONCILIATION_INTERVAL_MS = 1_500;

app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">C</span><div><strong>CodexEverywhere</strong><small>Your Codex, anywhere</small></div></div>
    <div class="connection"><span id="connection-status" class="connection-badge" role="status" aria-live="polite" aria-atomic="true" aria-label="连接状态：未连接"><span id="status-dot" class="dot offline" aria-hidden="true"></span><span id="status-symbol" class="connection-symbol" aria-hidden="true">×</span><span id="status-text">未连接</span></span><button id="settings-button" class="settings-button" type="button" aria-label="打开设置" hidden><span aria-hidden="true">⚙</span><strong>设置</strong></button></div>
  </header>
  <section id="setup" class="setup-shell">
    <div class="setup-card auth-card">
      <div id="login-view">
        <p class="eyebrow">欢迎回来</p>
        <h1>连接你的 Codex</h1>
        <p class="lede">输入 HPC 用户名，使用 Passkey 即可继续。</p>
        <section id="saved-section" class="saved-section" hidden>
          <span class="section-label">已保存的设备</span>
          <div id="saved-hosts" class="saved-hosts"></div>
          <div class="divider"><span>或使用新设备登录</span></div>
        </section>
        <label>HPC 用户名<input id="login-name" autocomplete="username webauthn" placeholder="例如 alice" maxlength="64" /></label>
        <button id="login-passkey" class="primary wide-action">使用 Passkey 继续</button>
        <details id="alternative-login" class="alternative-login">
          <summary>使用专用密码或临时设备</summary>
          <label>CodexEverywhere 专用密码<input id="login-password-input" type="password" autocomplete="current-password" placeholder="不是 SSH 密码" /></label>
          <label class="checkbox"><input id="remember-device" type="checkbox" />记住这台设备</label>
          <label id="device-name-field" hidden>设备名称<input id="device-name" value="我的浏览器" maxlength="128" /></label>
          <p id="device-persistence-note" class="privacy-note">临时登录：不会保存设备密钥或设备名称。</p>
          <button id="login-password-button" class="secondary wide-action">使用专用密码登录</button>
          <div class="divider"><span>账户恢复</span></div>
          <label>恢复码或管理员交接码<input id="login-recovery-input" autocomplete="one-time-code" spellcheck="false" placeholder="XXXXX-XXXXX… 或 CEAR-…" /></label>
          <button id="login-recovery-button" class="ghost wide-action">恢复 Web 身份</button>
        </details>
        <details class="advanced-login">
          <summary>Direct 高级连接</summary>
          <p class="lede">仅在不使用 Relay 且知道宿主机 HTTPS 入口时填写。</p>
          <label>Direct 宿主机<input id="direct-endpoint" type="url" inputmode="url" placeholder="https://hpc.example.com" maxlength="2048" /></label>
        </details>
        <div class="first-use-link">第一次使用？<button id="open-first-use" class="text-button">开始初始化</button></div>
      </div>
      <div id="pairing-view" hidden>
        <button id="back-to-login" class="back-button">← 返回登录</button>
        <p class="eyebrow">首次使用 · 1 / 2</p>
        <h1>连接你的 Linux 账号</h1>
        <p class="lede">这一步只做一次，用来在宿主机上建立你的第一个安全 Web 身份。</p>
        <ol class="onboarding-list">
          <li><span>1</span><div><strong>在 HPC 终端生成配对资料</strong><small class="pairing-prerequisite">只要这个 Linux 账号可以正常 SSH 登录，首次执行就会自动完成初始化，不需要管理员逐个开通。</small><div class="pairing-command-row"><input id="pairing-command" value="ce device pair" readonly aria-label="初始化指令" /><button id="copy-pairing-command" type="button" class="ghost">复制初始化指令</button></div><small id="copy-pairing-command-status" class="copy-status" aria-live="polite"></small></div></li>
          <li><span>2</span><div><strong>粘贴完整输出</strong><small>配对资料是一次性的，并且会过期。</small></div></li>
        </ol>
        <label>配对资料<textarea id="pairing-json" rows="8" spellcheck="false" placeholder='{ "version": 1, "endpoint": "wss://…" }'></textarea></label>
        <label>这台设备的名称<input id="pairing-device-name" value="我的浏览器" maxlength="128" /></label>
        <button id="pair-button" class="primary wide-action">验证并继续</button>
        <p class="privacy-note">下一步将创建 Passkey，并只向你展示一次恢复码。</p>
      </div>
      <p id="setup-error" class="error" role="alert"></p>
    </div>
  </section>
  <section id="provisioning" class="setup-shell" hidden>
    <div class="setup-card provisioning-card">
      <p class="eyebrow">首次使用 · 2 / 2</p>
      <h1>准备你的 Codex</h1>
      <p class="lede">安装、代理和登录都发生在你的 Linux 账号中。Relay 看不到这些配置。</p>
      <div class="wizard-progress" aria-label="初始化进度"><span id="progress-network" class="active">网络</span><i></i><span id="progress-install">安装</span><i></i><span id="progress-login">登录</span></div>
      <div class="provision-stage">
        <section id="provision-network" class="step-card">
          <strong class="step-title">选择 Codex 的联网方式</strong>
          <p class="lede">这个设置只影响 Codex，不影响浏览器通过 Direct 或 Relay 连接宿主机。</p>
          <label>Codex 访问方式<select id="network-mode"><option value="direct">直接访问</option><option value="proxy">使用代理</option></select></label>
          <div id="proxy-fields" hidden>
            <p class="lede">填写 Codex 宿主机能够访问的代理；浏览器本机的 <code>127.0.0.1</code> 通常不可用。</p>
            <label>HTTPS 代理<input id="https-proxy" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="http://proxy.example:7890" /></label>
            <label>HTTP 代理（可选）<input id="http-proxy" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="默认与 HTTPS 相同" /></label>
            <label>SOCKS / ALL_PROXY（可选）<input id="all-proxy" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="socks5h://proxy.example:7891" /></label>
            <label>不使用代理（可选）<input id="no-proxy" autocomplete="off" placeholder="internal.example,.cluster.local" /></label>
          </div>
          <button id="save-network" class="primary wide-action">保存并继续</button>
          <small id="network-state" class="step-state"></small>
        </section>
        <section id="provision-install" class="step-card" hidden>
          <strong class="step-title">检测、安装与更新 Codex</strong>
          <p class="lede">系统会使用当前用户已有的任意可运行版本。你也可以在 <code>~/.local</code> 安装 npm 最新稳定版，不需要 root，也不会修改其他位置的安装。</p>
          <div class="actions"><button id="back-to-network" class="ghost">返回</button><button id="install-codex" class="primary">开始安装</button><button id="continue-after-install" class="primary" hidden>继续</button></div>
          <div id="codex-install-progress" class="install-progress" role="status" aria-live="polite" hidden>
            <div class="install-progress-heading"><strong id="install-progress-label">正在启动安装</strong><span id="install-progress-count">0 / 4</span></div>
            <div id="install-progress-track" class="install-progress-track" role="progressbar" aria-label="Codex 安装阶段进度" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"><i id="install-progress-fill"></i></div>
            <div id="install-progress-steps" class="install-progress-steps" aria-hidden="true"><span>准备</span><span>下载与安装</span><span>验证</span><span>完成</span></div>
            <small id="install-progress-detail">正在向宿主机发起安装请求</small>
          </div>
          <small id="install-state" class="step-state"></small>
        </section>
        <section id="provision-login" class="step-card" hidden>
          <strong class="step-title">登录你的 Codex 账号</strong>
          <p class="lede">通过官方设备码流程授权这台 HPC。ChatGPT 登录发生在官方页面，授权结果由 Codex 保存到你的 <code>~/.codex</code>。</p>
          <button id="login-codex" class="primary wide-action" disabled>生成官方登录代码</button>
          <div id="device-code" class="codex-device-login" hidden>
            <div class="codex-login-header">
              <span class="codex-login-mark" aria-hidden="true">C</span>
              <div><small>ChatGPT / Codex</small><strong>授权此 HPC 使用你的账号</strong></div>
              <span class="codex-login-badge">官方设备码</span>
            </div>
            <ol class="codex-login-steps">
              <li>
                <span class="codex-login-step-number">1</span>
                <div><strong>打开 ChatGPT 登录页面</strong><small>在新页面登录你自己的账号；CodexEverywhere 不会看到密码。</small><a id="verification-link" class="codex-login-link" target="_blank" rel="noopener noreferrer"><span>打开官方登录页面</span><b aria-hidden="true">↗</b></a></div>
              </li>
              <li>
                <span class="codex-login-step-number">2</span>
                <div><strong>输入一次性代码</strong><small>如果官方页面没有自动填入，请复制下面的代码。</small><div class="codex-user-code-row"><input id="user-code" readonly autocomplete="one-time-code" spellcheck="false" aria-label="Codex 一次性登录代码" /><button id="copy-user-code" type="button" class="secondary">复制代码</button></div><small id="copy-user-code-status" class="copy-status" aria-live="polite"></small></div>
              </li>
            </ol>
            <div id="codex-login-waiting" class="codex-login-waiting" role="status" aria-live="polite">
              <span class="codex-login-spinner" aria-hidden="true"></span>
              <div><strong id="codex-login-waiting-title">等待授权完成</strong><small id="codex-login-waiting-detail">保持本页打开；系统每 2 秒自动检测登录状态</small></div>
            </div>
            <div class="codex-login-privacy"><span aria-hidden="true">✓</span><small>授权凭据仅由官方 Codex 写入当前 Linux 用户的 <code>~/.codex</code>，不会保存到 Relay 或浏览器。</small></div>
          </div>
          <details id="codex-auth-import" class="codex-auth-import">
            <summary>已在本机登录 Codex？使用 <code>auth.json</code></summary>
            <div class="codex-auth-import-body">
              <p>Codex 的标准登录文件位于下面的固定位置。将它安全复制到当前 HPC 用户即可继续。</p>
              <div class="codex-auth-default-path">
                <div><small>Codex 标准路径</small><code>~/.codex/auth.json</code></div>
                <button id="copy-codex-auth-path" type="button" class="ghost">复制文件夹路径</button>
              </div>
              <small id="copy-codex-auth-path-status" class="copy-status" aria-live="polite"></small>
              <div class="codex-auth-macos-help">
                <strong>macOS：在弹出的文件窗口按 <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd></strong>
                <span>出现“前往文件夹”输入框后，粘贴 <code>~/.codex/</code> 并按回车，再选中 <code>auth.json</code> 点击“打开”。</span>
              </div>
              <button id="use-default-codex-auth" type="button" class="secondary wide-action">使用默认 auth.json</button>
              <small class="codex-auth-picker-hint">提示：也可以在文件窗口按 <kbd>⌘</kbd><kbd>⇧</kbd><kbd>.</kbd> 临时显示以“.”开头的隐藏目录。</small>
              <div class="codex-auth-choice"><span>文件在其他位置？</span></div>
              <button id="choose-other-codex-auth" type="button" class="codex-auth-other-button wide-action"><span>选择其他 auth.json</span><small>浏览文件</small></button>
              <input id="codex-auth-file" class="codex-auth-file-input" type="file" accept=".json,application/json" aria-label="选择 Codex auth.json" />
              <small id="codex-auth-file-state" aria-live="polite">尚未读取文件</small>
              <button id="import-codex-auth" type="button" class="secondary wide-action" disabled>安全导入并继续</button>
              <p class="codex-auth-warning"><strong>这是登录凭据。</strong>文件只在本页内存中读取，经端到端加密连接直接写入当前 Linux 用户；不会上传到 Relay、持久化到浏览器或回显内容。</p>
            </div>
          </details>
          <small id="login-state" class="step-state"></small>
        </section>
      </div>
      <p id="provision-error" class="error" role="alert"></p>
    </div>
  </section>
  <main id="workspace" class="workspace-shell" hidden>
    <aside class="sidebar">
      <div class="sidebar-heading"><div class="sidebar-title"><span>会话</span><small id="thread-count"></small></div><div><button id="refresh-button" class="icon-button subtle" title="刷新" aria-label="刷新会话">↻</button><button id="new-session-button" class="new-session-button" title="新建会话"><span>＋</span> 新会话</button></div></div>
      <div class="workspace-scope">
        <div class="workspace-scope-heading"><label for="workspace-scope-select">会话范围</label><button id="manage-sidebar-workspaces" class="workspace-manage-button compact" type="button" title="管理工作区"><span aria-hidden="true">⚙</span> 管理工作区</button></div>
        <select id="workspace-scope-select" aria-label="筛选左侧会话的工作区"></select>
        <small id="workspace-scope-description">只筛选左侧列表，不会修改已经打开的会话目录。</small>
        <button id="show-active-workspace" class="workspace-scope-mismatch" type="button" hidden></button>
      </div>
      <div class="thread-search"><span aria-hidden="true">⌕</span><input id="thread-search" type="search" placeholder="搜索会话或目录" aria-label="搜索会话" /><kbd>⌘ K</kbd></div>
      <div class="thread-archive-filter" role="group" aria-label="会话归档状态"><button id="show-current-threads" type="button" aria-pressed="true">最近会话</button><button id="show-archived-threads" type="button" aria-pressed="false">已归档</button></div>
      <div id="thread-list" class="thread-list"></div>
      <div class="thread-list-footer"><button id="load-more-threads" type="button" hidden>加载更多</button><small id="thread-list-state" aria-live="polite"></small></div>
    </aside>
    <section id="conversation-content" class="content">
      <div class="thread-header"><button id="back-to-sessions" class="back-to-sessions" type="button" aria-label="返回会话列表">←</button><div class="thread-heading"><p id="thread-kind-label" class="eyebrow">Codex session</p><h2 id="thread-title">选择一个会话</h2><small class="thread-cwd-line"><span>当前会话目录</span><code id="thread-cwd"></code></small></div><div class="thread-controls"><div class="codex-status"><strong id="thread-state" class="pill idle" role="status" aria-live="polite">空闲</strong></div><div class="thread-actions"><button id="thread-outline-button" class="thread-outline-action compact-action" type="button" aria-controls="conversation-outline" aria-expanded="false" hidden><span aria-hidden="true">☷</span> 大纲</button><button id="tui-handoff-button" class="ssh-handoff-action compact-action" type="button" title="通过 SSH 在官方 TUI 中继续同一个会话" hidden><span aria-hidden="true">›_</span> SSH 接力</button></div></div></div>
      <aside id="ssh-handoff-banner" class="ssh-handoff-banner" aria-label="SSH 接力提示" hidden>
        <div class="ssh-handoff-banner-copy"><span class="ssh-terminal-mark" aria-hidden="true">›_</span><div><strong>也可以通过 SSH 访问同一个会话</strong><span>登录运行 Codex 的 HPC 后，用 <code>ce tui</code> 继续；Web、SSH TUI 可随时切换，当前任务不会中断。</span></div></div>
        <div class="ssh-handoff-banner-actions"><button id="ssh-handoff-banner-button" type="button">查看方法 <span aria-hidden="true">→</span></button><button id="dismiss-ssh-handoff-banner" class="ssh-handoff-banner-dismiss" type="button" title="以后不再显示这条说明">不再提示</button></div>
      </aside>
      <aside id="side-session-banner" class="side-session-banner" aria-label="Side 临时支线" hidden>
        <div class="side-session-banner-copy"><span class="side-session-mark" aria-hidden="true">⑂</span><div><strong><span>Side</span> 临时支线</strong><small id="side-session-parent">继承自主会话</small><p>这里继承主会话上下文，但不会进入会话列表；刷新或离开后无法恢复，回复也不会自动合并回主会话。</p></div></div>
        <button id="return-from-side" class="side-session-return" type="button"><span aria-hidden="true">←</span> 返回主会话</button>
      </aside>
      <aside id="side-fork-outcome-review" class="thread-start-outcome-review composer-outcome-review" role="status" hidden><strong>Side 创建结果待确认</strong><p id="side-fork-outcome-review-copy">连接中断后无法立即确认临时支线是否已创建。系统会保留原操作编号继续确认，不会用新编号重复分叉。</p><div class="actions"><button id="retry-side-fork-outcome" class="secondary" type="button">使用原操作编号重试</button><button id="abandon-side-fork-outcome" class="ghost danger" type="button">我已核对，放弃待确认</button></div></aside>
      <div id="timeline" class="timeline"><div class="empty empty-session"><strong>从一个任务开始</strong><span>选择左侧会话，或者新建一个 Codex 会话。</span><button id="empty-new-session" class="primary">新建会话</button></div></div>
      <button id="jump-to-latest" class="jump-to-latest" type="button" title="回到正在生成的最新回复" hidden><span aria-hidden="true">↓</span> 回到最新消息</button>
      <aside id="conversation-outline" class="conversation-outline" aria-label="对话大纲" hidden>
        <header><div><strong>对话大纲</strong><small>按你的消息快速定位</small></div><span id="conversation-outline-count">0 条</span><button id="close-conversation-outline" class="icon-button conversation-outline-dismiss" type="button" aria-label="关闭对话大纲" title="关闭对话大纲"></button></header>
        <nav id="conversation-outline-list" aria-label="你发送的消息"></nav>
      </aside>
      <div class="composer">
        <aside id="composer-approvals" class="composer-approvals" aria-label="待审批操作" hidden>
          <header><div><span class="approval-indicator" aria-hidden="true">!</span><strong>待审批</strong><span id="composer-approval-count">0 项</span></div><small id="composer-approval-note">当前任务正在等待你的操作</small></header>
          <div id="composer-approval-list" class="composer-approval-list"></div>
        </aside>
        <aside id="composer-queue" class="composer-queue" aria-label="待发送消息" hidden>
          <header id="composer-queue-header" role="button" tabindex="0" aria-expanded="true"><div><span class="queue-indicator" aria-hidden="true"></span><strong>待发送</strong><span id="composer-queue-count">0 条</span></div><small id="composer-queue-note">当前任务结束后依次发送</small></header>
          <div id="composer-queue-list" class="composer-queue-list"></div>
        </aside>
        <aside id="composer-outcome-review" class="thread-start-outcome-review composer-outcome-review" role="status" hidden><strong>发送结果需要人工核对</strong><p id="composer-outcome-review-copy">旧版 app-server 的完整历史读取连续失败，系统已停止自动重试发送。原消息可能已经提交，请刷新当前会话核对；只有确认可以承担重复消息风险后，才能放弃待确认记录。</p><div class="actions"><button id="inspect-composer-outcome" class="secondary" type="button">刷新并核对当前会话</button><button id="abandon-composer-outcome" class="ghost danger" type="button">我已核对，放弃待确认</button></div></aside>
        <div class="composer-shell">
          <div id="side-command-completion" class="side-command-completion" role="listbox" aria-label="命令补全" hidden><button id="complete-side-command" type="button" role="option"><code>/side</code><span><strong>开启 Side 临时支线</strong><small>继承当前上下文，但不写入会话列表</small></span><kbd>Tab</kbd></button></div>
          <textarea id="message-input" rows="1" placeholder="给 Codex 发送消息，或输入 /side 开启临时支线…" aria-autocomplete="list" aria-controls="side-command-completion" aria-expanded="false" disabled></textarea>
          <div class="composer-footer">
            <div class="composer-footer-leading">
              <div id="composer-session-meta" class="composer-session-meta" aria-label="会话配置和上下文" hidden>
                <button id="thread-permission-summary" class="session-meta-item permission-meta" type="button" title="修改这个会话后续轮次的权限"><span class="session-meta-icon" aria-hidden="true">◇</span><span id="thread-info-permissions">—</span><small id="thread-permission-pending" hidden>下一轮</small></button>
                <button id="thread-model-summary" class="session-meta-item model-meta" type="button" title="修改模型和推理强度"><span id="thread-info-model">—</span><span class="session-meta-separator" aria-hidden="true">·</span><span id="thread-info-effort">—</span></button>
                <div id="thread-context-summary" class="session-context unknown" role="progressbar" aria-label="上下文用量尚不可用" aria-valuemin="0" aria-valuemax="100" aria-valuetext="尚未收到上下文用量" tabindex="0">
                  <span id="thread-context-ring" class="context-ring" aria-hidden="true"></span>
                  <span class="context-copy"><strong id="thread-context-window">—</strong><small id="thread-context-percent">上下文</small></span>
                </div>
              </div>
              <span class="composer-hint">Enter 发送 · Shift + Enter 换行</span>
            </div>
            <div class="composer-actions"><button id="queue-message" class="ghost queue-action" disabled>加入队列</button><button id="interrupt-turn" class="stop-action" type="button" title="停止当前 Codex 任务" hidden><span aria-hidden="true">■</span><strong>停止</strong></button><button id="send-message" class="primary send-action" disabled><span>发送</span><kbd>↵</kbd></button></div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <dialog id="settings-dialog" class="settings-dialog">
    <div>
      <div class="dialog-heading settings-dialog-heading"><div><p class="eyebrow">Preferences</p><h2>设置</h2><p class="lede">管理这个 Linux 用户的 CodexEverywhere、Codex 和新会话默认值。</p></div><button id="close-settings" class="icon-button" type="button" aria-label="关闭设置">×</button></div>
      <div class="settings-center-grid">
        <section class="settings-center-section settings-defaults-section">
          <div class="settings-section-heading"><span class="settings-section-icon" aria-hidden="true">◇</span><div><strong>新会话默认权限</strong><small>保存在宿主机，仅用于以后从 Web 创建的会话</small></div></div>
          <div class="settings-default-fields"><label>文件与命令权限<select id="default-session-sandbox"><option value="read-only">只读</option><option value="workspace-write">可写当前工作目录</option><option value="danger-full-access">完全访问（危险）</option></select></label><label>审批策略<select id="default-session-approval"><option value="on-request">按需审批</option><option value="untrusted">仅不受信任命令需审批</option><option value="never">不请求审批</option></select></label></div>
          <div class="settings-default-actions"><p id="default-session-permissions-state" class="field-note" role="status" aria-live="polite"></p><button id="save-default-session-permissions" class="primary" type="button">保存默认权限</button></div>
        </section>
        <section class="settings-center-section">
          <div class="settings-section-heading"><span class="settings-section-icon" aria-hidden="true">◐</span><div><strong>外观</strong><small>只保存在当前浏览器</small></div></div>
          <label class="settings-inline-field">主题<select id="theme-preference" class="theme-preference" aria-label="外观主题"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
        </section>
        <section class="settings-center-section">
          <div class="settings-section-heading"><span class="settings-section-icon" aria-hidden="true">⌂</span><div><strong>工作目录</strong><small>管理允许访问的目录和新会话默认目录</small></div></div>
          <button id="settings-workspaces" class="settings-link-button" type="button"><span><strong>管理工作目录</strong><small>添加、移除或选择默认目录</small></span><b aria-hidden="true">›</b></button>
        </section>
        <section class="settings-center-section">
          <div class="settings-section-heading"><span class="settings-section-icon codex-icon" aria-hidden="true">C</span><div><strong>Codex</strong><small>管理宿主机上的运行环境</small></div></div>
          <div class="settings-link-list"><button id="settings-network" class="settings-link-button" type="button"><span><strong>网络</strong><small>直连、代理和出网配置</small></span><b aria-hidden="true">›</b></button><button id="settings-codex-version" class="settings-link-button" type="button"><span><strong>版本</strong><small>查看当前版本并安装更新</small></span><b aria-hidden="true">›</b></button></div>
        </section>
        <section class="settings-center-section settings-identity-section">
          <div class="settings-section-heading"><span class="settings-section-icon" aria-hidden="true">⌁</span><div><strong>Web 身份与恢复</strong><small>只用于登录 CodexEverywhere，不是 SSH 或 ChatGPT 凭据</small></div></div>
          <div class="settings-identity-actions"><button id="add-passkey-button" class="secondary" hidden>添加 Passkey</button><button id="set-password-button" class="secondary" hidden>设置密码</button><button id="recovery-codes-button" class="ghost" hidden>轮换恢复码</button></div>
        </section>
      </div>
      <p id="settings-error" class="error" role="alert"></p>
    </div>
  </dialog>
  <dialog id="new-session-dialog" class="new-session-dialog">
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">New session</p><h2>启动 Codex 会话</h2></div><button id="cancel-new-session" class="icon-button" type="button" aria-label="关闭">×</button></div>
      <label>工作目录<div class="workspace-picker"><select id="workspace-select" aria-label="Codex 启动目录"></select><button id="browse-session-directory" class="ghost" type="button">浏览子目录</button><button id="manage-workspaces" class="workspace-manage-button" type="button"><span aria-hidden="true">⚙</span> 管理工作区</button></div></label>
      <label>第一条消息<textarea id="new-prompt" rows="5" placeholder="描述你希望 Codex 完成的任务…"></textarea></label>
      <div class="launch-options"><label>模型<select id="new-session-model"><option value="">Codex 默认</option></select></label><label>推理强度<select id="new-session-effort"><option value="">模型默认</option></select></label></div>
      <details class="session-advanced"><summary><span>本次会话权限</span><small id="new-session-permission-summary">可写工作目录 · 按需审批</small></summary><div class="launch-options"><label>沙箱<select id="new-session-sandbox"><option value="read-only">只读</option><option value="workspace-write">可写工作目录</option><option value="danger-full-access">完全访问</option></select></label><label>审批策略<select id="new-session-approval"><option value="untrusted">仅信任命令免审批</option><option value="on-request">按需审批</option><option value="never">从不询问</option></select></label></div><p class="field-note">已填入全局默认值；这里的修改只影响本次新会话。</p></details>
      <p id="new-session-error" class="error" role="alert"></p>
      <div id="thread-start-outcome-review" class="thread-start-outcome-review" hidden><p>上次页面在会话创建结果明确前关闭或刷新，或 Agent 在结果落盘前重启；原会话可能已经存在。同一标签页只保存不含消息、目录或身份信息的待核对标记。系统不会按目录或时间猜测，也不会自动重放。请先刷新并核对会话列表；只有确认可以承担重复会话风险后，才能放弃本次待确认记录。</p><div class="actions"><button id="inspect-thread-start-outcome" class="secondary" type="button">刷新并查看会话列表</button><button id="abandon-thread-start-outcome" class="ghost danger" type="button">我已核对，放弃待确认</button></div></div>
      <button id="start-task" class="primary wide-action">创建并发送</button>
    </div>
  </dialog>
  <dialog id="password-dialog">
    <form id="password-form">
      <p class="eyebrow">Web 登录</p>
      <h2>设置 CodexEverywhere 专用密码</h2>
      <p class="lede">它不能用于 SSH。密码至少 9 个字符，并同时包含字母和数字。</p>
      <label>新密码<input id="new-password" type="password" autocomplete="new-password" minlength="9" required /></label>
      <label>再次输入<input id="confirm-password" type="password" autocomplete="new-password" minlength="9" required /></label>
      <p id="password-error" class="error" role="alert"></p>
      <p id="password-status" class="step-state" role="status" aria-live="polite"></p>
      <div class="actions"><button id="save-password" type="submit" class="primary">保存密码</button><button id="cancel-password" type="button" class="ghost">取消</button></div>
    </form>
  </dialog>
  <dialog id="recovery-dialog" class="recovery-dialog">
    <div>
      <p class="eyebrow">账户恢复</p>
      <h2>保存你的恢复码</h2>
      <p class="lede">这是唯一一次明文显示。请复制到密码管理器或安全的离线位置。</p>
      <label>恢复码
        <div class="recovery-code-row">
          <input id="recovery-code-output" readonly spellcheck="false" aria-label="恢复码" />
          <button id="copy-recovery-code" type="button" class="secondary">复制恢复码</button>
        </div>
      </label>
      <p id="copy-recovery-status" class="copy-status" aria-live="polite"></p>
      <div class="recovery-warning">以后无法再次查看这个恢复码。若丢失，管理员可以签发一个 10 分钟有效的临时交接码；旧恢复码会立即失效，管理员不会看到你兑换后生成的新恢复码。</div>
      <button id="close-recovery-dialog" type="button" class="primary wide-action">我已保存</button>
    </div>
  </dialog>
  <dialog id="workspace-dialog" class="workspace-dialog">
    <div>
      <p class="eyebrow">宿主机目录</p>
      <h2>管理 Codex 工作目录</h2>
      <p class="lede">填写 HPC 上已经存在的绝对目录。新任务会默认使用你选定的目录。</p>
      <div class="workspace-add-row">
        <input id="workspace-path-input" placeholder="例如 /public/home/alice/my-project" spellcheck="false" />
        <button id="browse-workspace-path" type="button" class="ghost">浏览…</button>
        <button id="add-workspace" type="button" class="primary">添加</button>
      </div>
      <p id="workspace-error" class="error" role="alert"></p>
      <div id="workspace-root-list" class="workspace-root-list"></div>
      <button id="close-workspace-dialog" type="button" class="secondary wide-action">完成</button>
    </div>
  </dialog>
  <dialog id="directory-picker-dialog" class="directory-picker-dialog">
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">Host directories</p><h2 id="directory-picker-title">选择工作目录</h2></div><button id="close-directory-picker" class="icon-button" type="button" aria-label="关闭">×</button></div>
      <p id="directory-picker-help" class="lede">从宿主机目录逐层选择，不需要记住完整路径。</p>
      <div id="directory-shortcuts" class="directory-shortcuts"></div>
      <div class="directory-current"><button id="directory-parent" class="ghost" type="button">↑ 上一级</button><code id="directory-current-path"></code></div>
      <div id="directory-list" class="directory-list" aria-live="polite"></div>
      <p id="directory-picker-note" class="field-note"></p>
      <p id="directory-picker-error" class="error" role="alert"></p>
      <div class="actions dialog-actions"><button id="cancel-directory-picker" type="button" class="ghost">取消</button><button id="select-directory" type="button" class="primary">使用此目录</button></div>
    </div>
  </dialog>
  <dialog id="network-settings-dialog" class="network-settings-dialog">
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">Codex settings</p><h2>Codex 网络</h2></div><button id="close-network-settings" class="icon-button" type="button" aria-label="关闭">×</button></div>
      <p class="lede">仅影响宿主机上的 Codex，不改变浏览器使用 Direct 或 Relay 连接的方式。</p>
      <div class="restart-warning"><strong>修改后会重启 Codex</strong><span>正在运行的 turn 会被中断。请在会话空闲时修改；页面会在重启后自动重新连接。</span></div>
      <label>访问方式<select id="settings-network-mode"><option value="direct">直接访问</option><option value="proxy">使用代理</option></select></label>
      <div id="settings-proxy-fields" hidden>
        <p class="field-note">出于安全考虑，已保存的代理地址不会回显。修改代理时请重新填写完整地址。</p>
        <label>HTTPS 代理<input id="settings-https-proxy" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://proxy.example:7890" /></label>
        <label>HTTP 代理（可选）<input id="settings-http-proxy" type="text" inputmode="url" autocomplete="off" spellcheck="false" /></label>
        <label>SOCKS / ALL_PROXY（可选）<input id="settings-all-proxy" type="text" inputmode="url" autocomplete="off" spellcheck="false" /></label>
        <label>不使用代理（可选）<input id="settings-no-proxy" autocomplete="off" placeholder="internal.example,.cluster.local" /></label>
      </div>
      <p id="network-settings-state" class="step-state"></p>
      <p id="network-settings-error" class="error" role="alert"></p>
      <div class="actions dialog-actions"><button id="cancel-network-settings" class="ghost" type="button">取消</button><button id="save-network-settings" class="primary" type="button">保存并重启 Codex</button></div>
    </div>
  </dialog>
  <dialog id="codex-version-dialog" class="network-settings-dialog">
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">Codex runtime</p><h2>Codex 版本</h2></div><button id="close-codex-version" class="icon-button" type="button" aria-label="关闭">×</button></div>
      <p class="lede">CodexEverywhere 接受当前账号中任何能够正常运行并报告版本的 Codex。更新会在你的 <code>~/.local</code> 中安装 npm 最新稳定版，不修改其他位置或共享安装。</p>
      <div class="restart-warning"><strong>安装更新不会立即中断任务</strong><span>如果 app-server 正在运行，安装完成后由你决定何时重启并应用；重启会中断正在执行的 turn。</span></div>
      <div class="codex-version-comparison" aria-live="polite">
        <section><span>当前安装版本</span><strong id="codex-version-current">检测中…</strong><small id="codex-version-binary">正在检查可执行文件</small></section>
        <section><span>npm 最新稳定版</span><strong id="codex-version-latest">检测中…</strong><small>来自 <code>@openai/codex@latest</code></small></section>
      </div>
      <p id="codex-version-state" class="step-state" role="status" aria-live="polite"></p>
      <p id="codex-version-error" class="error" role="alert"></p>
      <div class="actions dialog-actions"><button id="cancel-codex-version" class="ghost" type="button">关闭</button><button id="apply-codex-update" class="secondary" type="button" hidden>重启并应用</button><button id="update-codex" class="primary" type="button">安装或更新到最新版</button></div>
    </div>
  </dialog>
  <dialog id="thread-settings-dialog" class="thread-settings-dialog">
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">Session settings</p><h2>会话设置</h2></div><button id="close-thread-settings" class="icon-button" type="button" aria-label="关闭">×</button></div>
      <p class="lede">使用 Codex app-server 原生设置。修改会从下一轮消息开始生效，并成为这个会话后续轮次的默认值。</p>
      <div class="thread-settings-groups">
        <section id="thread-settings-model-section" class="thread-settings-section"><div><strong>模型行为</strong><small>选择模型及其推理强度</small></div><div class="thread-settings-fields"><label>模型<select id="thread-model"></select></label><label>推理强度<select id="thread-effort"></select></label></div></section>
        <section id="thread-settings-permission-section" class="thread-settings-section permission-section"><div><strong>执行权限</strong><small>决定后续轮次可访问的范围和审批方式</small></div><div class="thread-settings-fields"><label>文件与命令权限<select id="thread-sandbox"><option value="readOnly">只读</option><option value="workspaceWrite">可写当前工作目录</option><option value="dangerFullAccess">完全访问（危险）</option></select></label><label>审批策略<select id="thread-approval"><option value="on-request">按需审批</option><option value="untrusted">仅不受信任命令需审批</option><option value="never">不请求审批</option></select></label></div></section>
      </div>
      <div id="thread-settings-notice" class="restart-warning" hidden><strong>下一轮生效</strong><span>当前 turn 不会被中断；如果正在运行，新消息会带着这些设置进入队列。</span></div>
      <p id="thread-settings-error" class="error" role="alert"></p>
      <div class="actions dialog-actions"><button id="cancel-thread-settings" class="ghost" type="button">取消</button><button id="save-thread-settings" class="primary" type="button">保存设置</button></div>
    </div>
  </dialog>
  <dialog id="tui-handoff-dialog" class="tui-handoff-dialog">
    <div>
      <div class="dialog-heading"><div><p class="eyebrow">SSH handoff</p><h2>通过 SSH 继续同一个会话</h2></div><button id="close-tui-handoff" class="icon-button" type="button" aria-label="关闭">×</button></div>
      <p class="lede">不需要在 Web 中重新创建任务。像平时一样 SSH 登录运行 Codex 的 HPC，再执行下面的 <code>ce tui</code> 命令即可接管当前会话。</p>
      <ol class="tui-handoff-steps">
        <li><span>1</span><div><strong>SSH 登录 HPC</strong><small>使用你平时的 SSH 主机、用户名和认证方式。</small></div></li>
        <li><span>2</span><div><strong>复制并运行接力命令</strong><small>推荐直接进入当前会话；也可以打开历史会话选择器。</small></div></li>
        <li><span>3</span><div><strong>在官方 Codex TUI 中继续</strong><small>Web 可以关闭或稍后再打开，正在运行的任务不会因此停止。</small></div></li>
      </ol>
      <div class="tui-handoff-option exact">
        <div class="tui-option-heading"><strong>推荐：直接进入当前会话</strong><span>复制后运行</span></div>
        <p>命令包含当前 thread ID，粘贴后直接进入，不经过选择器。</p>
        <div class="tui-command-row">
          <input id="tui-handoff-command" readonly spellcheck="false" aria-label="直接进入当前会话的 TUI 命令" />
          <button id="copy-tui-command" type="button" class="secondary">复制命令</button>
        </div>
        <p id="copy-tui-status" class="copy-status" aria-live="polite"></p>
      </div>
      <div class="tui-handoff-option picker">
        <div class="tui-option-heading"><strong>以后直接从终端选择</strong><span>无需打开 Web</span></div>
        <p>只要记住 <code>ce tui &lt;路径&gt;</code>。运行后会打开官方会话恢复选择器，再选择这个目录下要继续的历史会话；只有显式使用 <code>--new</code> 才会新建会话。</p>
        <div class="tui-command-row">
          <input id="tui-picker-command" readonly spellcheck="false" aria-label="打开 TUI 会话恢复选择器的命令" />
          <button id="copy-tui-picker-command" type="button" class="ghost tui-copy-secondary">复制简短命令</button>
        </div>
        <p id="copy-tui-picker-status" class="copy-status" aria-live="polite"></p>
      </div>
      <div class="tui-exit-guidance">
        <strong>忙碌时也可以安全离开</strong>
        <span>在 TUI 中输入 <code>/quit</code> 或 <code>/exit</code>，只会关闭 TUI 客户端，宿主机上的当前任务会继续运行。</span>
        <span><strong>不要按 <kbd>Esc</kbd></strong>，它会中断当前任务。如果终端失去响应，可先按 Enter，再输入 <code>~.</code> 断开 SSH。</span>
      </div>
    </div>
  </dialog>
  <div id="toast-region" class="toast-region" aria-live="polite" aria-atomic="true"></div>
`;

const setup = requiredElement<HTMLElement>("setup");
const provisioning = requiredElement<HTMLElement>("provisioning");
const workspace = requiredElement<HTMLElement>("workspace");
const pairingJson = requiredElement<HTMLTextAreaElement>("pairing-json");
const pairingDeviceName = requiredElement<HTMLInputElement>(
  "pairing-device-name",
);
const loginName = requiredElement<HTMLInputElement>("login-name");
const directEndpointInput =
  requiredElement<HTMLInputElement>("direct-endpoint");
const loginPasswordInput = requiredElement<HTMLInputElement>(
  "login-password-input",
);
const loginRecoveryInput = requiredElement<HTMLInputElement>(
  "login-recovery-input",
);
const deviceName = requiredElement<HTMLInputElement>("device-name");
const deviceNameField = requiredElement<HTMLElement>("device-name-field");
const devicePersistenceNote = requiredElement<HTMLElement>(
  "device-persistence-note",
);
const rememberDevice = requiredElement<HTMLInputElement>("remember-device");
const pairingCommandOutput =
  requiredElement<HTMLInputElement>("pairing-command");
const copyPairingCommandStatus = requiredElement<HTMLElement>(
  "copy-pairing-command-status",
);
const alternativeLogin =
  requiredElement<HTMLDetailsElement>("alternative-login");
const setupError = requiredElement<HTMLElement>("setup-error");
const timeline = requiredElement<HTMLElement>("timeline");
const jumpToLatestButton = requiredElement<HTMLButtonElement>("jump-to-latest");
const conversationContent = requiredElement<HTMLElement>(
  "conversation-content",
);
const conversationOutline = requiredElement<HTMLElement>(
  "conversation-outline",
);
const conversationOutlineList = requiredElement<HTMLElement>(
  "conversation-outline-list",
);
const conversationOutlineCount = requiredElement<HTMLElement>(
  "conversation-outline-count",
);
const threadOutlineButton = requiredElement<HTMLButtonElement>(
  "thread-outline-button",
);
const threadList = requiredElement<HTMLElement>("thread-list");
const showCurrentThreadsButton = requiredElement<HTMLButtonElement>(
  "show-current-threads",
);
const showArchivedThreadsButton = requiredElement<HTMLButtonElement>(
  "show-archived-threads",
);
const loadMoreThreadsButton =
  requiredElement<HTMLButtonElement>("load-more-threads");
const threadListState = requiredElement<HTMLElement>("thread-list-state");
const workspaceSelect = requiredElement<HTMLSelectElement>("workspace-select");
const workspaceScopeSelect = requiredElement<HTMLSelectElement>(
  "workspace-scope-select",
);
const messageInput = requiredElement<HTMLTextAreaElement>("message-input");
const sideCommandCompletion = requiredElement<HTMLElement>(
  "side-command-completion",
);
const composerApprovals = requiredElement<HTMLElement>("composer-approvals");
const composerApprovalList = requiredElement<HTMLElement>(
  "composer-approval-list",
);
const composerApprovalCount = requiredElement<HTMLElement>(
  "composer-approval-count",
);
const composerApprovalNote = requiredElement<HTMLElement>(
  "composer-approval-note",
);
const composerQueue = requiredElement<HTMLElement>("composer-queue");
const composerQueueHeader = requiredElement<HTMLElement>(
  "composer-queue-header",
);
const composerQueueList = requiredElement<HTMLElement>("composer-queue-list");
const composerQueueCount = requiredElement<HTMLElement>("composer-queue-count");
const composerQueueNote = requiredElement<HTMLElement>("composer-queue-note");
const sendMessage = requiredElement<HTMLButtonElement>("send-message");
const queueMessage = requiredElement<HTMLButtonElement>("queue-message");
const networkMode = requiredElement<HTMLSelectElement>("network-mode");
const installCodexButton = requiredElement<HTMLButtonElement>("install-codex");
const loginCodexButton = requiredElement<HTMLButtonElement>("login-codex");
const userCodeOutput = requiredElement<HTMLInputElement>("user-code");
const copyUserCodeStatus = requiredElement<HTMLElement>(
  "copy-user-code-status",
);
const codexAuthFileInput = requiredElement<HTMLInputElement>("codex-auth-file");
const useDefaultCodexAuthButton = requiredElement<HTMLButtonElement>(
  "use-default-codex-auth",
);
const chooseOtherCodexAuthButton = requiredElement<HTMLButtonElement>(
  "choose-other-codex-auth",
);
const copyCodexAuthPathButton = requiredElement<HTMLButtonElement>(
  "copy-codex-auth-path",
);
const importCodexAuthButton =
  requiredElement<HTMLButtonElement>("import-codex-auth");
const recoveryDialog = requiredElement<HTMLDialogElement>("recovery-dialog");
const passwordDialog = requiredElement<HTMLDialogElement>("password-dialog");
const passwordForm = requiredElement<HTMLFormElement>("password-form");
const passwordInput = requiredElement<HTMLInputElement>("new-password");
const passwordConfirmation =
  requiredElement<HTMLInputElement>("confirm-password");
const passwordError = requiredElement<HTMLElement>("password-error");
const passwordStatus = requiredElement<HTMLElement>("password-status");
const savePasswordButton = requiredElement<HTMLButtonElement>("save-password");
const cancelPasswordButton =
  requiredElement<HTMLButtonElement>("cancel-password");
const recoveryCodeOutput = requiredElement<HTMLInputElement>(
  "recovery-code-output",
);
const copyRecoveryStatus = requiredElement<HTMLElement>("copy-recovery-status");
const workspaceDialog = requiredElement<HTMLDialogElement>("workspace-dialog");
const directoryPickerDialog = requiredElement<HTMLDialogElement>(
  "directory-picker-dialog",
);
const newSessionDialog =
  requiredElement<HTMLDialogElement>("new-session-dialog");
const settingsDialog = requiredElement<HTMLDialogElement>("settings-dialog");
const networkSettingsDialog = requiredElement<HTMLDialogElement>(
  "network-settings-dialog",
);
const codexVersionDialog = requiredElement<HTMLDialogElement>(
  "codex-version-dialog",
);
const threadSettingsDialog = requiredElement<HTMLDialogElement>(
  "thread-settings-dialog",
);
const tuiHandoffDialog =
  requiredElement<HTMLDialogElement>("tui-handoff-dialog");
const tuiHandoffButton =
  requiredElement<HTMLButtonElement>("tui-handoff-button");
const tuiHandoffBanner = requiredElement<HTMLElement>("ssh-handoff-banner");
const tuiHandoffBannerButton = requiredElement<HTMLButtonElement>(
  "ssh-handoff-banner-button",
);
const dismissTuiHandoffBannerButton = requiredElement<HTMLButtonElement>(
  "dismiss-ssh-handoff-banner",
);
const tuiHandoffCommandOutput = requiredElement<HTMLInputElement>(
  "tui-handoff-command",
);
const copyTuiStatus = requiredElement<HTMLElement>("copy-tui-status");
const tuiPickerCommandOutput =
  requiredElement<HTMLInputElement>("tui-picker-command");
const copyTuiPickerStatus = requiredElement<HTMLElement>(
  "copy-tui-picker-status",
);
const themePreferenceSelect =
  requiredElement<HTMLSelectElement>("theme-preference");
themePreferenceSelect.value = themeController.getPreference();
themePreferenceSelect.addEventListener("change", () => {
  const preference = normalizeThemePreference(themePreferenceSelect.value);
  themeController.setPreference(preference);
  showToast(`外观已切换为${themePreferenceLabel(preference)}`);
});
const timelineView = new ThreadTimelineView(timeline, {
  onLoadOlder: () => void loadOlderHistory(),
  onFollowLatestChanged: (following) => {
    jumpToLatestButton.hidden = following || !activeThreadId;
  },
});
const conversationOutlineView = new ConversationOutlineView(
  timeline,
  conversationContent,
  conversationOutline,
  conversationOutlineList,
  conversationOutlineCount,
  threadOutlineButton,
);
jumpToLatestButton.addEventListener("click", () => timelineView.followLatest());
composerQueueHeader.addEventListener(
  "click",
  toggleComposerQueueDuringApproval,
);
composerQueueHeader.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  toggleComposerQueueDuringApproval();
});
requiredElement("inspect-composer-outcome").addEventListener(
  "click",
  () => void inspectManualComposerOutcome(),
);
requiredElement("abandon-composer-outcome").addEventListener(
  "click",
  abandonManualComposerOutcome,
);

requiredElement("pair-button").addEventListener("click", () => void pair());
requiredElement("open-first-use").addEventListener("click", showFirstUse);
requiredElement("back-to-login").addEventListener("click", showLogin);
requiredElement("copy-pairing-command").addEventListener(
  "click",
  () => void copyPairingCommand(),
);
pairingCommandOutput.addEventListener("click", () =>
  pairingCommandOutput.select(),
);
requiredElement("login-passkey").addEventListener(
  "click",
  () =>
    void runLoginButtonAction(
      requiredElement<HTMLButtonElement>("login-passkey"),
      "正在验证…",
      loginWithPasskey,
    ),
);
requiredElement("login-password-button").addEventListener(
  "click",
  () => void loginWithPassword(),
);
requiredElement("login-recovery-button").addEventListener(
  "click",
  () => void recoverWebCredentials(),
);
rememberDevice.addEventListener("change", renderDevicePersistence);
loginName.addEventListener("input", renderDevicePersistence);
requiredElement("settings-button").addEventListener(
  "click",
  () => void openSettingsCenter(),
);
requiredElement("close-settings").addEventListener("click", () =>
  settingsDialog.close(),
);
requiredElement("save-default-session-permissions").addEventListener(
  "click",
  () => void saveDefaultSessionPermissions(),
);
requiredElement("set-password-button").addEventListener("click", () => {
  settingsDialog.close();
  openPasswordDialog();
});
requiredElement("add-passkey-button").addEventListener("click", () => {
  settingsDialog.close();
  void addPasskey();
});
requiredElement("recovery-codes-button").addEventListener("click", () => {
  settingsDialog.close();
  void rotateRecoveryCodes();
});
requiredElement("copy-recovery-code").addEventListener(
  "click",
  () => void copyRecoveryCode(),
);
requiredElement("close-recovery-dialog").addEventListener("click", () => {
  recoveryCodeOutput.value = "";
  copyRecoveryStatus.textContent = "";
  recoveryDialog.close();
});
recoveryDialog.addEventListener("cancel", (event) => event.preventDefault());
recoveryCodeOutput.addEventListener("click", () => recoveryCodeOutput.select());
cancelPasswordButton.addEventListener("click", closePasswordDialog);
passwordDialog.addEventListener("cancel", (event) => event.preventDefault());
passwordForm.addEventListener("submit", (event) => void savePassword(event));
requiredElement("refresh-button").addEventListener(
  "click",
  () => void refresh(),
);
requiredElement("new-session-button").addEventListener(
  "click",
  () => void openNewSession(),
);
requiredElement("empty-new-session").addEventListener(
  "click",
  () => void openNewSession(),
);
requiredElement("cancel-new-session").addEventListener("click", () =>
  pendingThreadStartOperation?.manualReviewRequired
    ? newSessionDialog.close()
    : pendingThreadStartOperation
      ? showToast("正在确认会话创建结果，暂时不能关闭", "error")
      : newSessionDialog.close(),
);
requiredElement("thread-search").addEventListener("input", () =>
  renderThreads(threadsCache),
);
showCurrentThreadsButton.addEventListener(
  "click",
  () => void selectThreadArchiveView(false),
);
showArchivedThreadsButton.addEventListener(
  "click",
  () => void selectThreadArchiveView(true),
);
loadMoreThreadsButton.addEventListener("click", () => void loadMoreThreads());
workspaceScopeSelect.addEventListener("change", selectWorkspaceScope);
requiredElement("manage-sidebar-workspaces").addEventListener("click", () => {
  workspaceDialog.showModal();
  renderWorkspaceManager();
});
requiredElement("show-active-workspace").addEventListener(
  "click",
  showActiveThreadWorkspace,
);
requiredElement("back-to-sessions").addEventListener(
  "click",
  () => void leaveActiveThreadView(),
);
requiredElement("return-from-side").addEventListener(
  "click",
  () => void returnToSideParent(),
);
requiredElement("retry-side-fork-outcome").addEventListener(
  "click",
  () => void resumePendingSideForkOperation(),
);
requiredElement("abandon-side-fork-outcome").addEventListener(
  "click",
  abandonPendingSideForkOperation,
);
requiredElement("complete-side-command").addEventListener("click", () => {
  completeSideCommand();
});

function completeSideCommand(): void {
  messageInput.value = "/side ";
  autoResize(messageInput);
  renderSideCommandCompletion();
  messageInput.focus();
}
threadOutlineButton.addEventListener("click", () =>
  conversationOutlineView.toggle(),
);
requiredElement("close-conversation-outline").addEventListener("click", () =>
  conversationOutlineView.collapse(),
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") conversationOutlineView.dismissOverlay();
});
requiredElement("manage-workspaces").addEventListener("click", () => {
  workspaceDialog.showModal();
  renderWorkspaceManager();
});
requiredElement("browse-session-directory").addEventListener(
  "click",
  () => void openDirectoryPicker("session"),
);
requiredElement("browse-workspace-path").addEventListener(
  "click",
  () => void openDirectoryPicker("workspace"),
);
requiredElement("settings-workspaces").addEventListener("click", () => {
  settingsDialog.close();
  workspaceDialog.showModal();
  renderWorkspaceManager();
});
requiredElement("settings-network").addEventListener("click", () => {
  settingsDialog.close();
  void openNetworkSettings();
});
requiredElement("settings-codex-version").addEventListener("click", () => {
  settingsDialog.close();
  void openCodexVersionSettings();
});
requiredElement("settings-network-mode").addEventListener(
  "change",
  renderSettingsNetworkFields,
);
requiredElement("close-network-settings").addEventListener("click", () =>
  networkSettingsDialog.close(),
);
requiredElement("cancel-network-settings").addEventListener("click", () =>
  networkSettingsDialog.close(),
);
requiredElement("save-network-settings").addEventListener(
  "click",
  () => void saveNetworkSettings(),
);
for (const id of ["close-codex-version", "cancel-codex-version"]) {
  requiredElement(id).addEventListener("click", () =>
    codexVersionDialog.close(),
  );
}
requiredElement("update-codex").addEventListener(
  "click",
  () => void updateCodexFromSettings(),
);
requiredElement("apply-codex-update").addEventListener(
  "click",
  () => void applyCodexUpdate(),
);
requiredElement("close-workspace-dialog").addEventListener("click", () =>
  workspaceDialog.close(),
);
for (const id of ["close-directory-picker", "cancel-directory-picker"]) {
  requiredElement(id).addEventListener("click", closeDirectoryPicker);
}
directoryPickerDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDirectoryPicker();
});
requiredElement("directory-parent").addEventListener("click", () => {
  if (directoryBrowseState?.parent)
    void browseDirectory(directoryBrowseState.parent);
});
requiredElement("select-directory").addEventListener(
  "click",
  selectCurrentDirectory,
);
requiredElement("add-workspace").addEventListener(
  "click",
  () => void addWorkspace(),
);
workspaceSelect.addEventListener("change", () => {
  if (workspaceRoots.includes(workspaceSelect.value))
    void setDefaultWorkspace();
});
requiredElement("new-session-model").addEventListener("change", () =>
  renderReasoningEfforts(),
);
for (const id of ["new-session-sandbox", "new-session-approval"]) {
  requiredElement(id).addEventListener("change", renderNewSessionPermissions);
}
requiredElement("start-task").addEventListener("click", () => void startTask());
requiredElement("inspect-thread-start-outcome").addEventListener(
  "click",
  () => void inspectIndeterminateThreadStart(),
);
requiredElement("abandon-thread-start-outcome").addEventListener(
  "click",
  abandonIndeterminateThreadStart,
);
window.addEventListener("beforeunload", warnBeforeUnresolvedMutationUnload);
sendMessage.addEventListener("click", () => void continueThread());
queueMessage.addEventListener("click", () => void queueForThread());
requiredElement("interrupt-turn").addEventListener(
  "click",
  () => void interruptActiveTurn(),
);
tuiHandoffButton.addEventListener("click", openTuiHandoff);
tuiHandoffBannerButton.addEventListener("click", openTuiHandoff);
dismissTuiHandoffBannerButton.addEventListener("click", () => {
  dismissTuiHandoffHint(window.localStorage);
  tuiHandoffBanner.hidden = true;
});
requiredElement("close-tui-handoff").addEventListener("click", () =>
  tuiHandoffDialog.close(),
);
requiredElement("copy-tui-command").addEventListener(
  "click",
  () => void copyTuiHandoffCommand(),
);
requiredElement("copy-tui-picker-command").addEventListener(
  "click",
  () => void copyTuiPickerCommand(),
);
tuiHandoffCommandOutput.addEventListener("click", () =>
  tuiHandoffCommandOutput.select(),
);
tuiPickerCommandOutput.addEventListener("click", () =>
  tuiPickerCommandOutput.select(),
);
requiredElement("thread-permission-summary").addEventListener(
  "click",
  () => void openThreadSettings("permissions"),
);
requiredElement("thread-model-summary").addEventListener(
  "click",
  () => void openThreadSettings("model"),
);
requiredElement("close-thread-settings").addEventListener("click", () =>
  threadSettingsDialog.close(),
);
requiredElement("cancel-thread-settings").addEventListener("click", () =>
  threadSettingsDialog.close(),
);
requiredElement("save-thread-settings").addEventListener(
  "click",
  saveThreadSettings,
);
requiredElement("thread-model").addEventListener(
  "change",
  renderThreadReasoningEfforts,
);
messageInput.addEventListener("input", () => {
  autoResize(messageInput);
  renderSideCommandCompletion();
});
messageInput.addEventListener("keydown", (event) => {
  if (
    !sideCommandCompletion.hidden &&
    (event.key === "Tab" ||
      (event.key === "Enter" && !event.shiftKey && !event.isComposing))
  ) {
    event.preventDefault();
    completeSideCommand();
    return;
  }
  if (event.key === "Escape" && !sideCommandCompletion.hidden) {
    event.preventDefault();
    sideCommandCompletion.hidden = true;
    messageInput.setAttribute("aria-expanded", "false");
    return;
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!sendMessage.disabled) void continueThread();
});
requiredElement<HTMLTextAreaElement>("new-prompt").addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void startTask();
  },
);
for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && shouldDismissDialogFromBackdrop(dialog.id))
      dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (shouldPreventDialogCancel(dialog.id)) event.preventDefault();
  });
}
window.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (workspace.hidden) return;
    event.preventDefault();
    requiredElement<HTMLInputElement>("thread-search").focus();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    if (workspace.hidden) return;
    event.preventDefault();
    void openNewSession();
    return;
  }
  if (event.key === "/" && !editing && !workspace.hidden) {
    event.preventDefault();
    requiredElement<HTMLInputElement>("thread-search").focus();
  }
});
networkMode.addEventListener("change", renderNetworkFields);
requiredElement("save-network").addEventListener(
  "click",
  () => void saveNetworkConfiguration(),
);
requiredElement("back-to-network").addEventListener("click", () =>
  showProvisionStep("network"),
);
installCodexButton.addEventListener("click", () => void installCodex());
requiredElement("continue-after-install").addEventListener(
  "click",
  () => void continueAfterCodexCheck(),
);
loginCodexButton.addEventListener("click", () => void loginCodex());
codexAuthFileInput.addEventListener("change", selectCodexAuthFile);
useDefaultCodexAuthButton.addEventListener("click", () =>
  openCodexAuthFilePicker("default"),
);
chooseOtherCodexAuthButton.addEventListener("click", () =>
  openCodexAuthFilePicker("other"),
);
copyCodexAuthPathButton.addEventListener(
  "click",
  () => void copyCodexAuthPath(),
);
importCodexAuthButton.addEventListener("click", () => void importCodexAuth());
requiredElement("copy-user-code").addEventListener(
  "click",
  () => void copyCodexUserCode(),
);
userCodeOutput.addEventListener("click", () => userCodeOutput.select());

void renderSavedHosts();
mountPwaUpdatePrompt();
renderDevicePersistence();
document.addEventListener("visibilitychange", () => {
  if (shouldVerifyAfterVisibilityChange(document.hidden)) {
    wakeConnectionRecovery();
    void verifyActiveConnection();
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    wakeConnectionRecovery();
    void verifyActiveConnection();
  }
});
window.addEventListener("offline", () => {
  // navigator.onLine is only a hint: Direct/LAN WebSockets can remain usable
  // even when the browser reports no Internet route.
  setStatus("connecting", "网络状态变化，正在确认连接…");
  wakeConnectionRecovery();
  void verifyActiveConnection();
});
window.addEventListener("online", () => {
  wakeConnectionRecovery();
  void verifyActiveConnection();
});
if (
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("preview") === "codex-login"
) {
  setup.hidden = true;
  workspace.hidden = true;
  provisioning.hidden = false;
  showProvisionStep("login");
  loginCodexButton.hidden = true;
  loginCodexButton.disabled = true;
  requiredElement<HTMLAnchorElement>("verification-link").href =
    "https://auth.openai.com/";
  userCodeOutput.value = "ABCD-EFGH";
  requiredElement("device-code").hidden = false;
  requiredElement("login-state").textContent =
    "登录代码已生成，请按上方两步完成授权";
  setCodexLoginWaiting(
    "waiting",
    "等待授权完成",
    "保持本页打开；系统每 2 秒自动检测登录状态",
  );
}
if (import.meta.env.DEV) {
  const preview = new URLSearchParams(window.location.search).get("preview");
  if (
    preview === "workspace" ||
    preview === "new-session" ||
    preview === "codex-version"
  ) {
    setup.hidden = true;
    provisioning.hidden = true;
    workspace.hidden = false;
    workspaceScopeSelect.replaceChildren(
      option("全部工作区", "__all__"),
      option("~/CodexEverywhere", "/Users/demo/CodexEverywhere"),
    );
    workspaceSelect.replaceChildren(
      option("~/CodexEverywhere", "/Users/demo/CodexEverywhere"),
    );
    requiredElement("thread-count").textContent = "2";
    if (preview === "new-session") newSessionDialog.showModal();
    if (preview === "codex-version") {
      renderCodexVersionSettings({
        version: 1,
        installed: true,
        installedVersion: "0.151.0",
        binary: "/Users/demo/.local/bin/codex",
        latestVersion: "0.152.0",
        relation: "older",
      });
      codexVersionDialog.showModal();
    }
  }
}
async function pair(): Promise<void> {
  setupError.textContent = "";
  try {
    const document = JSON.parse(pairingJson.value) as PairingDocument;
    const result = await GatewayClient.pair(
      document,
      pairingDeviceName.value.trim() || "我的浏览器",
    );
    if (result.recoveryCodes.length > 0) {
      showRecoveryCodes(result.recoveryCodes);
    }
    await activate(result.client);
  } catch (error) {
    setupError.textContent = errorMessage(error);
  }
}

function showFirstUse(): void {
  setupError.textContent = "";
  copyPairingCommandStatus.textContent = "";
  requiredElement("login-view").hidden = true;
  requiredElement("pairing-view").hidden = false;
}

function showLogin(): void {
  setupError.textContent = "";
  requiredElement("pairing-view").hidden = true;
  requiredElement("login-view").hidden = false;
}

async function loginWithPasskey(): Promise<void> {
  setupError.textContent = "";
  const name = loginName.value.trim();
  if (!name) {
    setupError.textContent = "请输入登录名";
    return;
  }
  setStatus("connecting", "正在查找 HPC Agent…");
  try {
    const remember = shouldRememberDevice("passkey");
    const reauthentication = temporaryReauthenticationFor(name);
    if (reauthentication) {
      await activate(
        await reauthentication.reauthenticateWithPasskey(remember),
      );
    } else {
      const host = await lookupHost(name);
      await activate(
        await GatewayClient.loginWithPasskey(host, {
          loginName: name,
          deviceName: loginDeviceName(host, remember, "临时浏览器"),
          rememberDevice: remember,
        }),
      );
    }
  } catch (error) {
    setStatus("offline", "登录失败");
    setupError.textContent = errorMessage(error);
  }
}

async function loginWithPassword(): Promise<void> {
  setupError.textContent = "";
  const name = loginName.value.trim();
  const password = loginPasswordInput.value;
  if (!name || !password) {
    setupError.textContent = "请输入登录名和 CodexEverywhere 密码";
    return;
  }
  setStatus("connecting", "正在查找 HPC Agent…");
  try {
    const remember = shouldRememberDevice("password");
    const reauthentication = temporaryReauthenticationFor(name);
    if (reauthentication) {
      await activate(
        await reauthentication.reauthenticateWithPassword(password, remember),
      );
    } else {
      const host = await lookupHost(name);
      await activate(
        await GatewayClient.loginWithPassword(host, {
          loginName: name,
          password,
          deviceName: loginDeviceName(host, remember, "临时浏览器"),
          rememberDevice: remember,
        }),
      );
    }
  } catch (error) {
    setStatus("offline", "登录失败");
    setupError.textContent = errorMessage(error);
  } finally {
    loginPasswordInput.value = "";
  }
}

function temporaryReauthenticationFor(
  login: string,
): GatewayClient | undefined {
  const candidate = temporaryReauthenticationClient;
  if (!candidate) return undefined;
  const expected = candidate.host.loginName ?? candidate.host.name;
  return expected === login ? candidate : undefined;
}

async function recoverWebCredentials(): Promise<void> {
  setupError.textContent = "";
  const name = loginName.value.trim();
  const recoveryCode = loginRecoveryInput.value.trim();
  if (!name || !recoveryCode) {
    setupError.textContent = "请输入登录名和恢复码或管理员交接码";
    return;
  }
  setStatus("connecting", "正在恢复 Web 身份…");
  try {
    const host = await lookupHost(name);
    const remember = shouldRememberDevice("recovery");
    const result = await GatewayClient.recover(host, {
      loginName: name,
      recoveryCode,
      deviceName: loginDeviceName(host, remember, "恢复设备"),
      rememberDevice: remember,
    });
    loginRecoveryInput.value = "";
    showRecoveryCodes(result.recoveryCodes);
    await activate(result.client);
  } catch (error) {
    setStatus("offline", "恢复失败");
    setupError.textContent = errorMessage(error);
  }
}

function shouldRememberDevice(method: WebLoginMethod): boolean {
  return rememberDeviceForLogin(method, {
    alternativeLoginOpen: alternativeLogin.open,
    checkboxChecked: rememberDevice.checked,
  });
}

function loginDeviceName(
  host: Pick<HostDocument, "nodeId">,
  remember: boolean,
  temporaryName: string,
): string {
  if (!remember) return temporaryName;
  const savedName = savedHostsCache
    .find((saved) => saved.nodeId === host.nodeId)
    ?.deviceName.trim();
  return savedName || deviceName.value.trim() || "我的浏览器";
}

function renderDevicePersistence(): void {
  const existing = savedDeviceForLoginName(loginName.value.trim());
  const mode = devicePersistenceMode(
    rememberDevice.checked,
    existing?.deviceName,
  );
  deviceNameField.hidden = mode !== "new";
  if (mode === "temporary") {
    devicePersistenceNote.textContent =
      "临时登录：不会保存设备密钥或设备名称。";
    return;
  }
  if (mode === "existing") {
    devicePersistenceNote.textContent = `此浏览器已有设备“${existing?.deviceName}”，将沿用原名称。`;
    return;
  }
  devicePersistenceNote.textContent =
    "登录成功后会在此浏览器保存设备密钥；设备名称用于以后识别它。";
}

function savedDeviceForLoginName(name: string): SavedHost | undefined {
  if (!name) return undefined;
  return savedHostsCache.find(
    (host) => (host.loginName?.trim() || host.name.trim()) === name,
  );
}

async function lookupHost(name: string) {
  const directEndpoint = directEndpointInput.value.trim();
  if (directEndpoint) return GatewayClient.discoverDirect(directEndpoint);
  const relayEndpoint = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/relay`;
  return GatewayClient.lookupRelay(relayEndpoint, name);
}

async function savePassword(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  passwordError.textContent = "";
  passwordStatus.textContent = "";
  if (!client) {
    passwordError.textContent = "请先登录";
    return;
  }
  if (passwordInput.value.length < 9) {
    passwordError.textContent = "密码至少需要 9 个字符";
    return;
  }
  if (
    !/[A-Za-z]/u.test(passwordInput.value) ||
    !/[0-9]/u.test(passwordInput.value)
  ) {
    passwordError.textContent = "密码需要同时包含字母和数字";
    return;
  }
  if (passwordInput.value !== passwordConfirmation.value) {
    passwordError.textContent = "两次输入的密码不一致";
    return;
  }
  savePasswordButton.disabled = true;
  savePasswordButton.textContent = "正在保存…";
  cancelPasswordButton.disabled = true;
  try {
    await client.setPassword(passwordInput.value);
    passwordInput.value = "";
    passwordConfirmation.value = "";
    passwordStatus.textContent =
      "专用密码设置成功。浏览器可能询问是否保存密码，你可以自行选择。";
    savePasswordButton.hidden = true;
    cancelPasswordButton.textContent = "完成";
    appendTimeline(
      "system",
      "密码已更新",
      "现在可以在临时设备上使用专用密码登录。",
    );
  } catch (error) {
    passwordError.textContent = errorMessage(error);
  } finally {
    savePasswordButton.disabled = false;
    if (!savePasswordButton.hidden) savePasswordButton.textContent = "保存密码";
    cancelPasswordButton.disabled = false;
  }
}

function openPasswordDialog(): void {
  resetPasswordDialog();
  passwordDialog.showModal();
  passwordInput.focus();
}

function closePasswordDialog(): void {
  resetPasswordDialog();
  passwordDialog.close();
}

function resetPasswordDialog(): void {
  passwordForm.reset();
  passwordError.textContent = "";
  passwordStatus.textContent = "";
  savePasswordButton.hidden = false;
  savePasswordButton.disabled = false;
  savePasswordButton.textContent = "保存密码";
  cancelPasswordButton.disabled = false;
  cancelPasswordButton.textContent = "取消";
}

async function addPasskey(): Promise<void> {
  if (!client) return;
  try {
    await client.addPasskey();
    appendTimeline(
      "system",
      "Passkey 已添加",
      "新设备现在可以使用这个 Passkey 登录。",
    );
  } catch (error) {
    appendTimeline("error", "添加 Passkey 失败", errorMessage(error));
  }
}

async function rotateRecoveryCodes(): Promise<void> {
  if (!client) return;
  if (!window.confirm("生成新恢复码后，所有旧恢复码会立即失效。是否继续？"))
    return;
  try {
    showRecoveryCodes(await client.rotateRecoveryCodes());
  } catch (error) {
    appendTimeline("error", "生成恢复码失败", errorMessage(error));
  }
}

function showRecoveryCodes(codes: string[]): void {
  const code = codes[0];
  if (!code) return;
  recoveryCodeOutput.value = code;
  copyRecoveryStatus.textContent = "";
  if (!recoveryDialog.open) recoveryDialog.showModal();
  recoveryCodeOutput.focus();
  recoveryCodeOutput.select();
}

async function copyRecoveryCode(): Promise<void> {
  const code = recoveryCodeOutput.value;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    copyRecoveryStatus.textContent =
      "已复制。请粘贴到密码管理器或安全的离线位置。";
  } catch {
    recoveryCodeOutput.focus();
    recoveryCodeOutput.select();
    copyRecoveryStatus.textContent =
      "浏览器未允许自动复制，恢复码已选中，请使用系统复制。";
  }
}

function openTuiHandoff(): void {
  if (!activeThreadId || !activeThreadCwd || activeSideSession) return;
  tuiHandoffCommandOutput.value = tuiHandoffCommand(
    activeThreadCwd,
    activeThreadId,
  );
  tuiPickerCommandOutput.value = tuiPickerCommand(activeThreadCwd);
  copyTuiStatus.textContent = "";
  copyTuiPickerStatus.textContent = "";
  tuiHandoffDialog.showModal();
  tuiHandoffCommandOutput.focus();
  tuiHandoffCommandOutput.select();
}

function setTuiHandoffVisible(visible: boolean): void {
  const effectiveVisible = visible && !activeSideSession;
  setTuiHandoffVisibility([tuiHandoffButton], effectiveVisible);
  setTuiHandoffVisibility(
    [tuiHandoffBanner],
    effectiveVisible && !isTuiHandoffHintDismissed(window.localStorage),
  );
}

async function copyTuiHandoffCommand(): Promise<void> {
  await copyCommand(
    tuiHandoffCommandOutput,
    copyTuiStatus,
    "命令已复制，可以直接进入当前会话。",
  );
}

async function copyTuiPickerCommand(): Promise<void> {
  await copyCommand(
    tuiPickerCommandOutput,
    copyTuiPickerStatus,
    "简短命令已复制；运行后请在选择器中选择要恢复的会话。",
  );
}

async function copyPairingCommand(): Promise<void> {
  await copyCommand(
    pairingCommandOutput,
    copyPairingCommandStatus,
    "初始化指令已复制，可粘贴到 HPC 终端执行。",
  );
}

async function copyCommand(
  output: HTMLInputElement,
  status: HTMLElement,
  successMessage: string,
): Promise<void> {
  const command = output.value;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    status.textContent = successMessage;
  } catch {
    output.focus();
    output.select();
    status.textContent = "浏览器未允许自动复制，命令已选中，请使用系统复制。";
  }
}

async function connectSaved(host: SavedHost): Promise<void> {
  setupError.textContent = "";
  setStatus("connecting", "正在建立加密连接…");
  try {
    const nextClient = await GatewayClient.connect(host);
    if (
      nextClient.host.loginName !== host.loginName ||
      nextClient.host.name !== host.name
    ) {
      try {
        await saveHost(nextClient.host);
      } catch {
        // A storage migration must not prevent an otherwise valid login.
      }
    }
    await activate(nextClient);
  } catch (error) {
    setStatus("offline", "连接失败");
    setupError.textContent = errorMessage(error);
  }
}

async function runLoginButtonAction(
  button: HTMLButtonElement,
  pendingLabel: string,
  operation: () => Promise<void>,
): Promise<void> {
  if (button.disabled) return;
  const originalLabel = button.textContent ?? "";
  button.disabled = true;
  button.classList.add("button-pending");
  button.setAttribute("aria-busy", "true");
  button.textContent = pendingLabel;
  try {
    await operation();
  } finally {
    button.disabled = false;
    button.classList.remove("button-pending");
    button.removeAttribute("aria-busy");
    button.textContent = originalLabel;
  }
}

async function activate(nextClient: GatewayClient): Promise<void> {
  const reauthenticatedClient =
    temporaryReauthenticationClient?.host.deviceId === nextClient.host.deviceId
      ? temporaryReauthenticationClient
      : undefined;
  const sideToRestore = reauthenticatedClient
    ? { session: activeSideSession, thread: activeThreadSnapshot() }
    : undefined;
  stopThreadSync();
  stopCodexLoginMonitoring();
  clearSelectedCodexAuthFile();
  ++openThreadSequence;
  activeThreadId = undefined;
  activeThreadCwd = undefined;
  activeThreadStatus = undefined;
  activeTurnId = undefined;
  activeNewestTurnId = undefined;
  activeHistoryNextCursor = undefined;
  activeHistoryPaginationExhausted = false;
  activeHistoryExhaustedNewestTurnId = undefined;
  activeHistoryMode = "none";
  olderHistoryLoading = false;
  activeThreadSettings = undefined;
  activeThreadTokenUsage = undefined;
  activeSideSession = undefined;
  if (sideToRestore?.session && sideToRestore.thread) {
    activeSideSession = sideToRestore.session;
    activeThreadId = sideToRestore.thread.id;
    activeThreadCwd = sideToRestore.thread.cwd;
    activeThreadStatus = sideToRestore.thread.status;
  }
  threadSettingsPendingNextTurn = false;
  sessionPermissionDefaults = {
    version: 1,
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  };
  pendingRequestIds.clear();
  approvalSubmissions.clear();
  clearApprovalTray();
  queuedItems.clear();
  renderComposerQueue();
  conversationOutlineView.setThreadActive(false);
  jumpToLatestButton.hidden = true;
  renderComposerSessionMeta();
  const previousClient = client;
  if (reauthenticatedClient) temporaryReauthenticationClient = undefined;
  bindActiveClient(nextClient);
  if (reauthenticatedClient !== previousClient) reauthenticatedClient?.close();
  appServerRestartRequired = false;
  setup.hidden = true;
  provisioning.hidden = true;
  workspace.hidden = true;
  requiredElement("recovery-codes-button").hidden = false;
  requiredElement("add-passkey-button").hidden = false;
  requiredElement("set-password-button").hidden = false;
  requiredElement("settings-button").hidden = false;
  await continueAfterHostAuthentication();
  if (client === nextClient && sideToRestore?.session && sideToRestore.thread) {
    const restored = await openThread(sideToRestore.thread, {
      preserveTimeline: true,
    });
    await fallbackFromUnavailableSide(
      nextClient,
      sideToRestore.thread,
      sideToRestore.session,
      restored,
    );
  }
}

function bindActiveClient(nextClient: GatewayClient): void {
  wakeConnectionRecovery();
  clearConnectionKeepalive();
  unsubscribeClientConnection?.();
  unsubscribeClientConnection = undefined;
  const previousClient = client;
  client = nextClient;
  previousClient?.close();
  unsubscribeClientConnection = nextClient.onConnectionLost(() => {
    if (
      client !== nextClient ||
      (document.hidden && !nextClient.canReconnectSilently)
    )
      return;
    window.setTimeout(() => {
      if (client === nextClient) void recoverConnection(nextClient);
    }, 250);
  });
  scheduleConnectionKeepalive(nextClient);
  nextClient.onEvent(renderEvent);
  setStatus(
    "online",
    nextClient.transport === "direct"
      ? "Direct · 端到端加密"
      : "Relay · 端到端加密",
  );
}

async function verifyActiveConnection(): Promise<void> {
  const currentClient = client;
  if (
    !currentClient ||
    (document.hidden && !currentClient.canReconnectSilently) ||
    connectionRecovery?.client === currentClient
  )
    return;
  const existing = connectionVerification;
  if (existing?.client === currentClient) return existing.promise;
  const verify = async () => {
    try {
      await currentClient.healthCheck(CONNECTION_KEEPALIVE_TIMEOUT_MS);
      if (client === currentClient) {
        setStatus(
          "online",
          currentClient.transport === "direct"
            ? "Direct · 端到端加密"
            : "Relay · 端到端加密",
        );
      }
    } catch (error) {
      if (
        client === currentClient &&
        shouldRecoverAfterHealthCheckFailure(error)
      ) {
        await recoverConnection(currentClient);
      }
    }
  };
  const tracked = verify().finally(() => {
    if (connectionVerification?.promise === tracked)
      connectionVerification = undefined;
  });
  connectionVerification = { client: currentClient, promise: tracked };
  return tracked;
}

async function recoverConnection(previous: GatewayClient): Promise<void> {
  const existing = connectionRecovery;
  if (existing?.client === previous) return existing.promise;
  const thread = activeThreadSnapshot();
  const side = activeSideSession;
  const wakeup = new ConnectionRetryWakeup();
  const recovery = async () => {
    try {
      const nextClient = await reconnectWithUnlimitedAttempts({
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
        onBeforeAttempt: (attempt, delayMs) => {
          setStatus(
            "connecting",
            attempt === 0
              ? "连接已失效，正在重新连接…"
              : `连接暂不可用，${formatRetryDelay(delayMs)}后继续重试…`,
          );
        },
      });
      if (!nextClient) return;
      if (client !== previous) {
        nextClient.close();
        return;
      }
      stopThreadSync();
      ++openThreadSequence;
      bindActiveClient(nextClient);
      if (client !== nextClient) return;
      const threadToRestore = activeThreadSnapshot() ?? thread;
      if (threadToRestore) {
        const restored = await openThread(threadToRestore, {
          preserveTimeline: true,
        });
        if (side)
          await fallbackFromUnavailableSide(
            nextClient,
            threadToRestore,
            side,
            restored,
          );
      } else await refresh();
      showToast("连接已恢复", "success");
    } catch (error) {
      if (client !== previous) return;
      if (error instanceof TemporaryPasswordReauthenticationRequired) {
        showHostReauthentication(previous, true);
        return;
      }
      showHostReauthentication(previous, false);
    }
  };
  const tracked = recovery().finally(() => {
    if (connectionRecovery?.promise === tracked) connectionRecovery = undefined;
  });
  connectionRecovery = { client: previous, promise: tracked, wakeup };
  return tracked;
}

async function fallbackFromUnavailableSide(
  targetClient: GatewayClient,
  attemptedThread: ThreadSummary,
  expectedSide: ActiveSideSession,
  restored: boolean,
): Promise<void> {
  if (
    restored ||
    client !== targetClient ||
    activeSideSession !== expectedSide ||
    expectedSide.threadId !== attemptedThread.id ||
    activeThreadId !== attemptedThread.id
  )
    return;
  let status: NodeStatus;
  try {
    status = await targetClient.request<NodeStatus>("node/status", {});
  } catch {
    // A second transport failure or temporary app-server problem is not
    // evidence that an ephemeral thread vanished. Retain its only handle and
    // let the normal connection supervisor retry.
    return;
  }
  if (
    client !== targetClient ||
    activeSideSession !== expectedSide ||
    activeThreadId !== attemptedThread.id ||
    sideRecoveryDisposition(
      expectedSide.appServerInstanceId,
      status.appServerInstanceId,
    ) !== "vanished"
  )
    return;
  await returnFromUnavailableSide(expectedSide);
}

async function returnFromUnavailableSide(
  expectedSide: ActiveSideSession,
): Promise<void> {
  if (
    activeSideSession !== expectedSide ||
    activeThreadId !== expectedSide.threadId
  )
    return;
  markUnavailableSideOperationsForReview(expectedSide.threadId);
  stopThreadSync();
  activeSideSession = undefined;
  renderSideSessionChrome();
  showToast("Side 临时支线无法重新打开，已返回主会话", "error");
  await openThread(expectedSide.parent);
  renderComposerOutcomeReview();
  updateComposerSubmitAvailability();
}

function markUnavailableSideOperationsForReview(threadId: string): void {
  for (const operation of pendingComposerOperations.values()) {
    if (operation.threadId !== threadId) continue;
    operation.manualReviewRequired = true;
    operation.manualReviewReason = "side-unavailable";
    composerReconciliations.delete(operation.operationId);
    composerTurnSnapshotReader.forget(operation.operationId);
  }
  stopPendingComposerReconciliationIfIdle();
}

function activeThreadSnapshot(): ThreadSummary | undefined {
  if (!activeThreadId || !activeThreadCwd) return undefined;
  const cached = threadsCache.find(
    (candidate) => candidate.id === activeThreadId,
  );
  return {
    id: activeThreadId,
    name: cached?.name ?? null,
    preview:
      cached?.preview ?? requiredElement("thread-title").textContent ?? "",
    cwd: activeThreadCwd,
    status: activeThreadStatus ?? cached?.status ?? { type: "idle" },
    updatedAt: cached?.updatedAt ?? Date.now(),
  };
}

function wakeConnectionRecovery(): void {
  connectionRecovery?.wakeup.wake();
}

function scheduleConnectionKeepalive(expectedClient: GatewayClient): void {
  clearConnectionKeepalive();
  connectionKeepaliveTimer = window.setTimeout(() => {
    connectionKeepaliveTimer = undefined;
    void verifyActiveConnection().finally(() => {
      if (client === expectedClient)
        scheduleConnectionKeepalive(expectedClient);
    });
  }, CONNECTION_KEEPALIVE_INTERVAL_MS);
}

function clearConnectionKeepalive(): void {
  if (connectionKeepaliveTimer === undefined) return;
  window.clearTimeout(connectionKeepaliveTimer);
  connectionKeepaliveTimer = undefined;
}

function formatRetryDelay(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${milliseconds} 毫秒`
    : `${milliseconds / 1_000} 秒`;
}

function showHostReauthentication(
  previous: GatewayClient,
  temporaryPassword: boolean,
): void {
  if (client !== previous) return;
  clearConnectionKeepalive();
  unsubscribeClientConnection?.();
  unsubscribeClientConnection = undefined;
  temporaryReauthenticationClient = previous;
  client = undefined;
  stopThreadSync();
  stopCodexLoginMonitoring();
  provisioning.hidden = true;
  workspace.hidden = true;
  setup.hidden = false;
  showLogin();
  loginName.value = previous.host.loginName ?? previous.host.name;
  alternativeLogin.open = true;
  rememberDevice.checked = !temporaryPassword;
  renderDevicePersistence();
  setStatus("offline", "身份已失效，请重新登录");
  setupError.textContent = temporaryPassword
    ? "临时登录不会保存专用密码。连接恢复后，请重新输入密码或改用 Passkey。"
    : "设备授权或登录状态已失效。请使用 Passkey 或 CodexEverywhere 密码重新登录。";
  window.setTimeout(() => loginPasswordInput.focus(), 0);
}

async function continueAfterHostAuthentication(): Promise<void> {
  if (!client) return;
  try {
    provisioning.hidden = true;
    const status = await client.request<SetupStatus>("setup/status", {});
    provisionStatus = status;
    networkMode.value = status.networkMode;
    renderNetworkFields();
    renderInstallStatus(status);
    if (!status.networkConfigured) {
      provisioning.hidden = false;
      showProvisionStep("network");
      return;
    }
    if (!status.codex.installed) {
      provisioning.hidden = false;
      showProvisionStep("install");
      return;
    }
    await continueToCodexAccount();
  } catch (error) {
    provisioning.hidden = false;
    requiredElement("provision-error").textContent = errorMessage(error);
  }
}

function showProvisionStep(step: "network" | "install" | "login"): void {
  for (const name of ["network", "install", "login"] as const) {
    requiredElement(`provision-${name}`).hidden = name !== step;
    requiredElement(`progress-${name}`).classList.toggle(
      "active",
      name === step,
    );
    requiredElement(`progress-${name}`).classList.toggle(
      "complete",
      step === "install"
        ? name === "network"
        : step === "login" && name !== "login",
    );
  }
}

function renderInstallStatus(status: SetupStatus): void {
  installCodexButton.hidden = false;
  installCodexButton.disabled = false;
  installCodexButton.textContent = status.codex.installed
    ? "安装或更新到最新版"
    : "安装最新版";
  const continueButton = requiredElement<HTMLButtonElement>(
    "continue-after-install",
  );
  continueButton.hidden = !status.codex.installed;
  continueButton.disabled = false;
  continueButton.textContent = appServerRestartRequired
    ? "重启 Codex 服务并继续"
    : "确认版本并继续";
  requiredElement("install-state").textContent = status.codex.installed
    ? `已安装${status.codex.version ? ` · ${status.codex.version}` : ""}${status.codex.binary ? ` · ${status.codex.binary}` : ""}`
    : "尚未安装";
  loginCodexButton.disabled = !status.codex.installed;
  requiredElement("network-state").textContent = !status.networkConfigured
    ? "尚未选择"
    : status.networkMode === "proxy"
      ? "已配置代理"
      : "当前为直接访问";
  if (!status.codex.installed) hideCodexInstallProgress();
}

function showCodexInstallStarting(): void {
  const container = requiredElement("codex-install-progress");
  container.hidden = false;
  container.classList.remove("failed");
  requiredElement("install-progress-label").textContent = "正在启动安装";
  requiredElement("install-progress-count").textContent =
    `0 / ${CODEX_INSTALL_STEP_COUNT}`;
  requiredElement("install-progress-detail").textContent =
    "正在向宿主机发起安装请求";
  updateCodexInstallProgressBar(0);
}

function renderCodexInstallProgress(payload: unknown): void {
  const progress = codexInstallProgressPresentation(payload);
  if (!progress) return;
  const container = requiredElement("codex-install-progress");
  container.hidden = false;
  container.classList.toggle("failed", progress.phase === "failed");
  requiredElement("install-progress-label").textContent = progress.label;
  requiredElement("install-progress-detail").textContent = progress.detail;
  requiredElement("install-state").textContent = progress.label;
  if (progress.step !== undefined) {
    requiredElement("install-progress-count").textContent =
      `${progress.step} / ${CODEX_INSTALL_STEP_COUNT}`;
    updateCodexInstallProgressBar(progress.step);
  }
  if (codexVersionDialog.open) {
    requiredElement("codex-version-state").textContent =
      `${progress.label}：${progress.detail}`;
  }
}

function updateCodexInstallProgressBar(step: number): void {
  const track = requiredElement("install-progress-track");
  track.setAttribute("aria-valuenow", String(step));
  requiredElement<HTMLElement>("install-progress-fill").style.width =
    `${(step / CODEX_INSTALL_STEP_COUNT) * 100}%`;
  for (const [index, element] of Array.from(
    requiredElement("install-progress-steps").children,
  ).entries()) {
    element.classList.toggle(
      "complete",
      step === CODEX_INSTALL_STEP_COUNT || index < step - 1,
    );
    element.classList.toggle(
      "active",
      index === step - 1 && step < CODEX_INSTALL_STEP_COUNT,
    );
  }
}

function hideCodexInstallProgress(): void {
  requiredElement("codex-install-progress").hidden = true;
}

function renderNetworkFields(): void {
  requiredElement("proxy-fields").hidden = networkMode.value !== "proxy";
}

async function openSettingsCenter(): Promise<void> {
  if (!client) return;
  requiredElement("settings-error").textContent = "";
  renderDefaultSessionPermissions();
  settingsDialog.showModal();
  try {
    await loadSessionPermissionDefaults(client);
    renderDefaultSessionPermissions();
  } catch (cause) {
    requiredElement("settings-error").textContent = errorMessage(cause);
  }
}

async function loadSessionPermissionDefaults(
  targetClient: GatewayClient,
): Promise<void> {
  const defaults = await targetClient.request<SessionPermissionDefaults>(
    "preferences/read",
    {},
  );
  if (client !== targetClient) return;
  sessionPermissionDefaults = defaults;
}

function renderDefaultSessionPermissions(): void {
  requiredElement<HTMLSelectElement>("default-session-sandbox").value =
    sessionPermissionDefaults.sandbox;
  requiredElement<HTMLSelectElement>("default-session-approval").value =
    sessionPermissionDefaults.approvalPolicy;
  requiredElement("default-session-permissions-state").textContent =
    `当前默认：${sessionPermissionSummary(sessionPermissionDefaults.sandbox, sessionPermissionDefaults.approvalPolicy)}`;
}

async function saveDefaultSessionPermissions(): Promise<void> {
  if (!client) return;
  const sandbox = requiredElement<HTMLSelectElement>("default-session-sandbox")
    .value as SessionPermissionDefaults["sandbox"];
  const approvalPolicy = requiredElement<HTMLSelectElement>(
    "default-session-approval",
  ).value as SessionPermissionDefaults["approvalPolicy"];
  if (
    sandbox === "danger-full-access" &&
    sessionPermissionDefaults.sandbox !== "danger-full-access" &&
    !window.confirm(
      "完全访问会让以后从 Web 创建的新会话默认拥有工作目录之外的读写和命令权限。确定保存吗？",
    )
  )
    return;
  const button = requiredElement<HTMLButtonElement>(
    "save-default-session-permissions",
  );
  const state = requiredElement("default-session-permissions-state");
  const error = requiredElement("settings-error");
  button.disabled = true;
  button.textContent = "正在保存…";
  state.textContent = "正在保存到宿主机…";
  error.textContent = "";
  try {
    sessionPermissionDefaults = await client.request<SessionPermissionDefaults>(
      "preferences/session-permissions/update",
      { sandbox, approvalPolicy },
    );
    renderDefaultSessionPermissions();
    showToast("新会话默认权限已更新", "success");
  } catch (cause) {
    state.textContent = "保存失败，默认权限未改变";
    error.textContent = errorMessage(cause);
  } finally {
    button.disabled = false;
    button.textContent = "保存默认权限";
  }
}

function sessionPermissionSummary(
  sandbox: SessionPermissionDefaults["sandbox"],
  approval: SessionPermissionDefaults["approvalPolicy"],
): string {
  const sandboxLabel = {
    "read-only": "只读",
    "workspace-write": "可写工作目录",
    "danger-full-access": "完全访问",
  }[sandbox];
  const approvalLabel = {
    untrusted: "仅不受信任命令审批",
    "on-request": "按需审批",
    never: "不请求审批",
  }[approval];
  return `${sandboxLabel} · ${approvalLabel}`;
}

function renderNewSessionPermissions(): void {
  const sandbox = requiredElement<HTMLSelectElement>("new-session-sandbox")
    .value as SessionPermissionDefaults["sandbox"];
  const approval = requiredElement<HTMLSelectElement>("new-session-approval")
    .value as SessionPermissionDefaults["approvalPolicy"];
  requiredElement("new-session-permission-summary").textContent =
    sessionPermissionSummary(sandbox, approval);
}

async function openCodexVersionSettings(): Promise<void> {
  if (!client) return;
  const current = requiredElement("codex-version-current");
  const latest = requiredElement("codex-version-latest");
  const binary = requiredElement("codex-version-binary");
  const state = requiredElement("codex-version-state");
  const error = requiredElement("codex-version-error");
  current.textContent = "检测中…";
  latest.textContent = "检测中…";
  binary.textContent = "正在检查可执行文件";
  state.textContent = "";
  error.textContent = "";
  const apply = requiredElement<HTMLButtonElement>("apply-codex-update");
  apply.hidden = true;
  apply.disabled = false;
  apply.textContent = "重启并应用";
  const update = requiredElement<HTMLButtonElement>("update-codex");
  update.hidden = false;
  update.disabled = false;
  update.textContent = "安装或更新到最新版";
  codexVersionDialog.showModal();
  try {
    const status = await readCodexVersionStatus();
    renderCodexVersionSettings(status);
  } catch (cause) {
    error.textContent = errorMessage(cause);
  }
}

async function readCodexVersionStatus(): Promise<CodexVersionStatus> {
  if (!client) throw new Error("尚未连接宿主机");
  try {
    return await client.request<CodexVersionStatus>(
      "setup/codex/version/read",
      {},
      { timeoutMs: 30_000 },
    );
  } catch {
    const status = await client.request<SetupStatus>("setup/status", {});
    const installedVersion = codexVersionFromCliOutput(status.codex.version);
    return {
      version: 1,
      installed: status.codex.installed,
      ...(installedVersion ? { installedVersion } : {}),
      ...(status.codex.binary ? { binary: status.codex.binary } : {}),
      relation: "unknown",
    };
  }
}

function renderCodexVersionSettings(status: CodexVersionStatus): void {
  const presentation = codexVersionPresentation(status);
  requiredElement("codex-version-current").textContent =
    presentation.installedLabel;
  requiredElement("codex-version-latest").textContent =
    presentation.latestLabel;
  requiredElement("codex-version-binary").textContent =
    presentation.binaryLabel;
  requiredElement("codex-version-state").textContent = presentation.state;
  const update = requiredElement<HTMLButtonElement>("update-codex");
  update.textContent = presentation.actionLabel;
  update.hidden = presentation.actionHidden;
}

async function updateCodexFromSettings(): Promise<void> {
  if (!client) return;
  const button = requiredElement<HTMLButtonElement>("update-codex");
  const apply = requiredElement<HTMLButtonElement>("apply-codex-update");
  const state = requiredElement("codex-version-state");
  const error = requiredElement("codex-version-error");
  const idleButtonText = button.textContent ?? "安装或更新到最新版";
  button.disabled = true;
  button.textContent = "正在安装最新版…";
  apply.hidden = true;
  error.textContent = "";
  state.textContent = "正在向宿主机发起安装或更新请求…";
  try {
    const result = await client.request<{
      installed: true;
      binary: string;
      version?: string;
      restartRequired: boolean;
    }>("setup/codex/install", {}, { timeoutMs: 10 * 60_000 });
    const installedVersion = codexVersionFromCliOutput(result.version);
    renderCodexVersionSettings({
      version: 1,
      installed: true,
      ...(installedVersion ? { installedVersion } : {}),
      binary: result.binary,
      ...(installedVersion ? { latestVersion: installedVersion } : {}),
      relation: installedVersion ? "current" : "unknown",
    });
    state.textContent = result.restartRequired
      ? "最新版已经安装。当前服务仍在使用原版本，请在任务空闲时重启并应用。"
      : "最新版已经安装，将在下次启动 Codex 时使用。";
    apply.hidden = !result.restartRequired;
    if (!result.restartRequired) showToast("Codex 已安装或更新", "success");
  } catch (cause) {
    state.textContent = "";
    error.textContent = errorMessage(cause);
  } finally {
    button.disabled = false;
    if (!button.hidden) button.textContent = idleButtonText;
  }
}

async function applyCodexUpdate(): Promise<void> {
  if (!client) return;
  if (
    !window.confirm(
      "重启 Codex app-server 会中断正在运行的 turn。确认现在重启并应用新版本？",
    )
  )
    return;
  const button = requiredElement<HTMLButtonElement>("apply-codex-update");
  const error = requiredElement("codex-version-error");
  const state = requiredElement("codex-version-state");
  button.disabled = true;
  button.textContent = "正在重启…";
  error.textContent = "";
  try {
    const previous = client;
    state.textContent = "正在重启 Codex app-server 并应用新版本…";
    await previous.request(
      "setup/app-server/restart",
      { force: true },
      { timeoutMs: APP_SERVER_RESTART_REQUEST_TIMEOUT_MS },
    );
    codexVersionDialog.close();
    await reconnectAfterCodexRestart(previous);
  } catch (cause) {
    error.textContent = errorMessage(cause);
    button.disabled = false;
    button.textContent = "重启并应用";
  }
}

async function openNetworkSettings(): Promise<void> {
  if (!client) return;
  const state = requiredElement("network-settings-state");
  const error = requiredElement("network-settings-error");
  state.textContent = "正在读取当前配置…";
  error.textContent = "";
  networkSettingsDialog.showModal();
  try {
    const status = await client.request<SetupStatus>("setup/status", {});
    requiredElement<HTMLSelectElement>("settings-network-mode").value =
      status.networkMode;
    renderSettingsNetworkFields();
    clearSettingsProxyInputs();
    state.textContent =
      status.networkMode === "proxy"
        ? "当前使用代理；代理地址已安全保存在宿主机，不会回显。"
        : "当前由 Codex 直接访问互联网。";
  } catch (cause) {
    error.textContent = errorMessage(cause);
  }
}

function renderSettingsNetworkFields(): void {
  requiredElement("settings-proxy-fields").hidden =
    requiredElement<HTMLSelectElement>("settings-network-mode").value !==
    "proxy";
}

async function saveNetworkSettings(): Promise<void> {
  if (!client) return;
  const error = requiredElement("network-settings-error");
  const state = requiredElement("network-settings-state");
  const save = requiredElement<HTMLButtonElement>("save-network-settings");
  const mode = requiredElement<HTMLSelectElement>(
    "settings-network-mode",
  ).value;
  error.textContent = "";
  const payload: Record<string, unknown> = { mode };
  if (mode === "proxy") {
    const httpsProxy = settingsInputValue("settings-https-proxy");
    if (!httpsProxy) {
      error.textContent = "修改代理时必须重新填写 HTTPS 代理地址";
      return;
    }
    payload.httpsProxy = httpsProxy;
    for (const [field, key] of [
      ["settings-http-proxy", "httpProxy"],
      ["settings-all-proxy", "allProxy"],
      ["settings-no-proxy", "noProxy"],
    ] as const) {
      const value = settingsInputValue(field);
      if (value) payload[key] = value;
    }
  }
  if (
    !window.confirm(
      "保存网络设置会重启 Codex app-server，并中断正在运行的 turn。确认现在修改？",
    )
  )
    return;
  save.disabled = true;
  save.textContent = "正在保存…";
  try {
    const result = await client.request<{
      networkMode: "direct" | "proxy";
      restartRequired: boolean;
    }>("setup/network/configure", payload);
    state.textContent = result.restartRequired
      ? "配置已保存，正在重启 Codex…"
      : "配置已保存。";
    clearSettingsProxyInputs();
    if (result.restartRequired) {
      const previous = client;
      await previous.request(
        "setup/app-server/restart",
        { force: true },
        { timeoutMs: APP_SERVER_RESTART_REQUEST_TIMEOUT_MS },
      );
      networkSettingsDialog.close();
      await reconnectAfterCodexRestart(previous);
      return;
    }
    networkSettingsDialog.close();
    showToast("Codex 网络设置已保存", "success");
  } catch (cause) {
    error.textContent = errorMessage(cause);
  } finally {
    save.disabled = false;
    save.textContent = "保存并重启 Codex";
  }
}

async function reconnectAfterCodexRestart(
  previous: GatewayClient,
): Promise<void> {
  setStatus("connecting", "Codex 已重启，正在重新连接…");
  // Restarting app-server must not discard the in-memory Web identity or
  // reload drafts. Reuse the same unlimited transport supervisor and its
  // original reconnect mode instead of creating a fresh saved-device login.
  previous.close();
  await recoverConnection(previous);
  if (client && client !== previous)
    showToast("Codex 已重启并重新连接", "success");
}

function settingsInputValue(id: string): string {
  return requiredElement<HTMLInputElement>(id).value.trim();
}

function clearSettingsProxyInputs(): void {
  for (const id of [
    "settings-https-proxy",
    "settings-http-proxy",
    "settings-all-proxy",
    "settings-no-proxy",
  ])
    requiredElement<HTMLInputElement>(id).value = "";
}

async function saveNetworkConfiguration(): Promise<void> {
  if (!client) return;
  const error = requiredElement("provision-error");
  error.textContent = "";
  const payload: Record<string, unknown> = { mode: networkMode.value };
  if (networkMode.value === "proxy") {
    const httpsProxy = inputValue("https-proxy");
    if (!httpsProxy) {
      error.textContent = "请输入 HTTPS 代理地址";
      return;
    }
    payload.httpsProxy = httpsProxy;
    for (const [field, key] of [
      ["http-proxy", "httpProxy"],
      ["all-proxy", "allProxy"],
      ["no-proxy", "noProxy"],
    ] as const) {
      const value = inputValue(field);
      if (value) payload[key] = value;
    }
  }
  try {
    const result = await client.request<{
      networkMode: "direct" | "proxy";
      restartRequired: boolean;
    }>("setup/network/configure", payload);
    appServerRestartRequired = result.restartRequired;
    provisionStatus = {
      ...(provisionStatus ?? {
        codex: { installed: false },
        appServerRunning: result.restartRequired,
      }),
      networkConfigured: true,
      networkMode: result.networkMode,
    };
    requiredElement("network-state").textContent = result.restartRequired
      ? "已保存；下一步重启 Codex 服务后生效"
      : result.networkMode === "proxy"
        ? "代理已保存到宿主机"
        : "已切换为直接访问";
    clearProxyInputs();
    renderInstallStatus(provisionStatus);
    showProvisionStep("install");
  } catch (cause) {
    error.textContent = errorMessage(cause);
  }
}

async function installCodex(): Promise<void> {
  if (!client) return;
  const error = requiredElement("provision-error");
  error.textContent = "";
  installCodexButton.disabled = true;
  requiredElement("install-state").textContent = "正在启动安装…";
  showCodexInstallStarting();
  try {
    const result = await client.request<{
      installed: true;
      binary: string;
      version?: string;
      restartRequired: boolean;
    }>("setup/codex/install", {}, { timeoutMs: 10 * 60_000 });
    appServerRestartRequired = result.restartRequired;
    const codex = {
      installed: result.installed,
      binary: result.binary,
      ...(result.version ? { version: result.version } : {}),
    };
    renderInstallStatus({
      networkConfigured: true,
      networkMode: networkMode.value as "direct" | "proxy",
      codex,
      appServerRunning: result.restartRequired,
    });
    provisionStatus = {
      networkConfigured: true,
      networkMode: networkMode.value as "direct" | "proxy",
      codex,
      appServerRunning: result.restartRequired,
    };
    showProvisionStep("install");
  } catch (cause) {
    installCodexButton.disabled = false;
    requiredElement("install-state").textContent = "安装或更新失败";
    error.textContent = errorMessage(cause);
  }
}

async function continueAfterCodexCheck(): Promise<void> {
  if (!client || !provisionStatus?.codex.installed) return;
  const error = requiredElement("provision-error");
  const continueButton = requiredElement<HTMLButtonElement>(
    "continue-after-install",
  );
  error.textContent = "";
  continueButton.disabled = true;
  try {
    if (appServerRestartRequired) {
      continueButton.textContent = "正在重启 Codex 服务…";
      const previous = client;
      await previous.request(
        "setup/app-server/restart",
        { force: true },
        { timeoutMs: APP_SERVER_RESTART_REQUEST_TIMEOUT_MS },
      );
      appServerRestartRequired = false;
      provisionStatus.appServerRunning = true;
      await reconnectAfterCodexRestart(previous);
      return;
    }
    await continueToCodexAccount();
  } catch (cause) {
    continueButton.disabled = false;
    continueButton.textContent = appServerRestartRequired
      ? "重启 Codex 服务并继续"
      : "确认版本并继续";
    error.textContent = errorMessage(cause);
  }
}

async function continueToCodexAccount(): Promise<void> {
  if (!client) return;
  const account = await client.request<AccountStatus>("codex/account/read", {});
  if (!account.account && account.requiresOpenaiAuth) {
    provisioning.hidden = false;
    loginCodexButton.hidden = false;
    loginCodexButton.disabled = false;
    loginCodexButton.textContent = "生成官方登录代码";
    requiredElement("device-code").hidden = true;
    requiredElement("login-state").textContent = "尚未登录";
    showProvisionStep("login");
    return;
  }
  await enterWorkspace(account.account);
}

async function loginCodex(): Promise<void> {
  if (!client) return;
  const error = requiredElement("provision-error");
  error.textContent = "";
  loginCodexButton.disabled = true;
  loginCodexButton.textContent = "正在生成安全登录代码…";
  requiredElement("device-code").hidden = true;
  copyUserCodeStatus.textContent = "";
  try {
    const result = await client.request<{
      type: string;
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }>("codex/account/login/start", {});
    if (
      result.type !== "chatgptDeviceCode" ||
      !result.verificationUrl ||
      !result.userCode
    ) {
      throw new Error("Codex 未返回设备码登录资料");
    }
    const link = requiredElement<HTMLAnchorElement>("verification-link");
    link.href = result.verificationUrl;
    userCodeOutput.value = result.userCode;
    requiredElement("device-code").hidden = false;
    loginCodexButton.hidden = true;
    setCodexLoginWaiting(
      "waiting",
      "等待授权完成",
      "保持本页打开；系统每 2 秒自动检测登录状态",
    );
    requiredElement("login-state").textContent =
      "登录代码已生成，请按上方两步完成授权";
    startCodexLoginMonitoring(result.loginId);
  } catch (cause) {
    const hasDeviceCode = !requiredElement("device-code").hidden;
    if (hasDeviceCode) {
      setCodexLoginWaiting(
        "failed",
        "未检测到登录完成",
        "代码可能已过期，重新生成后再试一次",
      );
    }
    loginCodexButton.hidden = false;
    loginCodexButton.disabled = false;
    loginCodexButton.textContent = hasDeviceCode
      ? "重新生成登录代码"
      : "生成官方登录代码";
    error.textContent = errorMessage(cause);
  }
}

function openCodexAuthFilePicker(source: "default" | "other"): void {
  clearSelectedCodexAuthFile();
  requiredElement("codex-auth-file-state").textContent =
    source === "default"
      ? "macOS：按 ⌘⇧G，粘贴 ~/.codex/，再选择 auth.json"
      : "请选择你从其他位置获得的 auth.json";
  codexAuthFileInput.click();
}

async function copyCodexAuthPath(): Promise<void> {
  const status = requiredElement("copy-codex-auth-path-status");
  try {
    await navigator.clipboard.writeText("~/.codex/");
    status.textContent =
      "文件夹路径 ~/.codex/ 已复制；打开文件窗口后按 ⌘⇧G 粘贴。";
  } catch {
    status.textContent = "浏览器未允许自动复制，请手动复制 ~/.codex/。";
  }
}

function selectCodexAuthFile(): void {
  selectedCodexAuthFile = codexAuthFileInput.files?.[0];
  const state = requiredElement("codex-auth-file-state");
  if (!selectedCodexAuthFile) {
    state.textContent = "尚未读取文件";
    importCodexAuthButton.disabled = true;
    return;
  }
  const tooLarge = selectedCodexAuthFile.size > 256 * 1024;
  state.textContent = tooLarge
    ? `${selectedCodexAuthFile.name} · 文件超过 256 KiB 限制`
    : `${selectedCodexAuthFile.name} · ${formatFileSize(selectedCodexAuthFile.size)}`;
  importCodexAuthButton.disabled = tooLarge;
}

async function importCodexAuth(): Promise<void> {
  if (!client || !selectedCodexAuthFile) return;
  const file = selectedCodexAuthFile;
  const error = requiredElement("provision-error");
  const state = requiredElement("codex-auth-file-state");
  if (
    !window.confirm(
      "auth.json 相当于 Codex 登录凭据。导入会替换当前 HPC 用户已有的 Codex 登录，并重启 Codex 服务。确认继续？",
    )
  )
    return;

  error.textContent = "";
  importCodexAuthButton.disabled = true;
  importCodexAuthButton.textContent = "正在安全导入…";
  state.textContent = "正在读取本机文件；内容不会保存到浏览器";
  let content = "";
  let imported = false;
  try {
    content = await file.text();
    if (new Blob([content]).size > 256 * 1024) {
      throw new Error("auth.json 超过 256 KiB 限制");
    }
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("auth.json 必须包含 JSON 对象");
    }

    stopCodexLoginMonitoring();
    const result = await client.request<CodexAuthImportResult>(
      "setup/codex/auth/import",
      { version: 1, content },
      { timeoutMs: 30_000 },
    );
    imported = result.imported;
    content = "";
    state.textContent = result.replacedExisting
      ? "凭据已导入并替换原有登录，正在重新加载 Codex…"
      : result.restartRequired
        ? "凭据已导入，正在重新加载 Codex…"
        : "凭据已导入，正在启动 Codex…";
    const previous = client;
    await previous.request(
      "setup/app-server/restart",
      { force: true },
      { timeoutMs: APP_SERVER_RESTART_REQUEST_TIMEOUT_MS },
    );
    await reconnectAfterCodexRestart(previous);
    return;
  } catch (cause) {
    state.textContent = imported
      ? "凭据已写入，但 Codex 服务未能自动重新加载；刷新页面可重试"
      : "导入未完成";
    error.textContent = errorMessage(cause);
  } finally {
    content = "";
    clearSelectedCodexAuthFile();
    importCodexAuthButton.textContent = "安全导入并继续";
  }
}

function clearSelectedCodexAuthFile(): void {
  selectedCodexAuthFile = undefined;
  codexAuthFileInput.value = "";
  importCodexAuthButton.disabled = true;
}

function formatFileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KiB`;
}

async function copyCodexUserCode(): Promise<void> {
  await copyCommand(
    userCodeOutput,
    copyUserCodeStatus,
    "登录代码已复制，请粘贴到 ChatGPT 官方页面。",
  );
}

function setCodexLoginWaiting(
  state: "waiting" | "failed" | "success",
  title: string,
  detail: string,
): void {
  const waiting = requiredElement("codex-login-waiting");
  waiting.classList.toggle("failed", state === "failed");
  waiting.classList.toggle("success", state === "success");
  requiredElement("codex-login-waiting-title").textContent = title;
  requiredElement("codex-login-waiting-detail").textContent = detail;
}

function startCodexLoginMonitoring(loginId: string): void {
  pendingCodexLoginId = loginId;
  codexLoginFinalizing = false;
  const generation = ++codexLoginMonitorGeneration;
  void pollForCodexAccount(loginId, generation);
}

function stopCodexLoginMonitoring(): void {
  pendingCodexLoginId = undefined;
  codexLoginFinalizing = false;
  ++codexLoginMonitorGeneration;
}

async function pollForCodexAccount(
  loginId: string,
  generation: number,
): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  while (
    client &&
    pendingCodexLoginId === loginId &&
    codexLoginMonitorGeneration === generation &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    if (
      pendingCodexLoginId !== loginId ||
      codexLoginMonitorGeneration !== generation
    )
      return;
    try {
      const status = await client.request<AccountStatus>(
        "codex/account/read",
        {},
      );
      if (status.account) {
        await finalizeCodexLogin(loginId, status.account);
        if (pendingCodexLoginId !== loginId) return;
      }
    } catch {
      // The app-server completion event remains the primary signal. A
      // transient polling failure must not discard an otherwise valid login.
    }
  }
  if (
    pendingCodexLoginId === loginId &&
    codexLoginMonitorGeneration === generation
  ) {
    failCodexLogin("等待 Codex 登录超时，请重新生成代码");
  }
}

async function finalizeCodexLogin(
  loginId: string,
  knownAccount?: NonNullable<AccountStatus["account"]>,
): Promise<void> {
  if (pendingCodexLoginId !== loginId || codexLoginFinalizing) return;
  codexLoginFinalizing = true;
  setCodexLoginWaiting("success", "授权完成", "正在进入你的 Codex 工作区");
  try {
    let account = knownAccount;
    for (let attempt = 0; !account && attempt < 8; attempt += 1) {
      const status = await client?.request<AccountStatus>(
        "codex/account/read",
        {},
      );
      account = status?.account ?? undefined;
      if (!account)
        await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    if (!account) throw new Error("Codex 已确认授权，但账号状态尚未刷新");
    stopCodexLoginMonitoring();
    await enterWorkspace(account);
  } catch (cause) {
    codexLoginFinalizing = false;
    requiredElement("provision-error").textContent = errorMessage(cause);
    setCodexLoginWaiting(
      "waiting",
      "授权已完成，正在同步账号",
      "无需重新登录，系统会继续自动检测",
    );
  }
}

function failCodexLogin(message: string): void {
  stopCodexLoginMonitoring();
  setCodexLoginWaiting(
    "failed",
    "未检测到登录完成",
    "代码可能已过期，重新生成后再试一次",
  );
  loginCodexButton.hidden = false;
  loginCodexButton.disabled = false;
  loginCodexButton.textContent = "重新生成登录代码";
  requiredElement("provision-error").textContent = message;
}

async function enterWorkspace(
  account: AccountStatus["account"],
): Promise<void> {
  provisioning.hidden = true;
  workspace.hidden = false;
  workspace.classList.remove("thread-open");
  conversationOutlineView.setThreadActive(false);
  if (account?.email) {
    appendTimeline("system", "Codex 已登录", account.email);
  }
  const targetClient = client;
  if (!targetClient) return;
  await Promise.all([
    refresh(),
    loadSessionPermissionDefaults(targetClient).catch(() => {
      // Older Agents do not expose host-side preferences. The explicit safe
      // fallback remains visible until the Agent is upgraded.
    }),
  ]);
  if (pendingThreadStartOperation) void resumePendingThreadStartOperation();
  if (pendingSideForkOperation) void resumePendingSideForkOperation();
  if (pendingComposerOperations.size > 0)
    schedulePendingComposerReconciliation(0);
}

function inputValue(id: string): string {
  return requiredElement<HTMLInputElement>(id).value.trim();
}

function clearProxyInputs(): void {
  for (const id of ["https-proxy", "http-proxy", "all-proxy"])
    requiredElement<HTMLInputElement>(id).value = "";
}

async function refresh(): Promise<void> {
  return runCoalescedRefresh();
}

async function performRefresh(): Promise<void> {
  const targetClient = client;
  if (!targetClient) return;
  const archived = threadListArchived;
  const requestEpoch = ++threadListRequestEpoch;
  threadListLoadingMore = false;
  const refreshButton = requiredElement<HTMLButtonElement>("refresh-button");
  refreshButton.classList.add("refreshing");
  refreshButton.disabled = true;
  try {
    const workspaces = await targetClient.request<WorkspaceProfile>(
      "workspace/list",
      {},
    );
    if (client !== targetClient) return;
    const previousSelection = workspaceSelect.value;
    workspaceRoots = workspaces.roots;
    defaultWorkspaceRoot = workspaces.defaultRoot;
    if (workspaceRoots.length === 0) {
      workspaceSelect.replaceChildren(option("", "请先添加工作目录"));
    } else {
      workspaceSelect.replaceChildren(
        ...workspaceRoots.map((root) => option(root, root)),
      );
      workspaceSelect.value = workspaceRoots.includes(previousSelection)
        ? previousSelection
        : (workspaces.defaultRoot ?? workspaceRoots[0]!);
    }
    requiredElement<HTMLButtonElement>("start-task").disabled =
      workspaceRoots.length === 0;
    renderWorkspaceScope(workspaces);
    renderWorkspaceManager(workspaces.defaultRoot);
    const threads = await requestThreadList<ThreadListPage>(
      targetClient,
      threadListParams(archived),
    );
    if (
      client !== targetClient ||
      requestEpoch !== threadListRequestEpoch ||
      archived !== threadListArchived
    )
      return;
    threadsCache = threads.data;
    threadListNextCursor = threads.nextCursor ?? null;
    threadListState.textContent = "";
    renderThreads(threadsCache);
  } catch (error) {
    if (
      client !== targetClient ||
      requestEpoch !== threadListRequestEpoch ||
      archived !== threadListArchived
    )
      return;
    const message = threadListErrorMessage(error);
    threadListState.textContent = message;
    renderThreadDiscoveryControls();
    appendTimeline("error", "刷新失败", message);
  } finally {
    refreshButton.classList.remove("refreshing");
    refreshButton.disabled = false;
  }
}

function threadListParams(
  archived: boolean,
  options: { cursor?: string; searchTerm?: string } = {},
): ThreadListParams {
  return {
    limit: THREAD_LIST_PAGE_SIZE,
    sortKey: "updated_at",
    sortDirection: "desc",
    sourceKinds: ["cli", "vscode", "appServer"],
    // Older app-server releases do not know the archive filter. Omitting the
    // default false value keeps the current-thread list available during a
    // rolling Codex upgrade; only the opt-in archived view requires support.
    ...(archived ? { archived: true } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.searchTerm ? { searchTerm: options.searchTerm } : {}),
  };
}

async function selectThreadArchiveView(archived: boolean): Promise<void> {
  if (threadListArchived === archived) return;
  threadListArchived = archived;
  threadListRequestEpoch += 1;
  threadListNextCursor = null;
  threadListLoadingMore = false;
  threadListState.textContent = "";
  threadsCache = [];
  renderThreads(threadsCache);
  await refresh();
}

async function loadMoreThreads(): Promise<void> {
  const targetClient = client;
  const cursor = threadListNextCursor;
  if (!targetClient || !cursor || threadListLoadingMore) return;
  const archived = threadListArchived;
  const requestEpoch = threadListRequestEpoch;
  threadListLoadingMore = true;
  threadListState.textContent = "正在加载更多会话…";
  renderThreadDiscoveryControls();
  try {
    const page = await requestThreadList<ThreadListPage>(
      targetClient,
      threadListParams(archived, { cursor }),
    );
    if (
      client !== targetClient ||
      requestEpoch !== threadListRequestEpoch ||
      archived !== threadListArchived
    )
      return;
    threadsCache = mergeThreadPages(threadsCache, page.data);
    threadListNextCursor = page.nextCursor ?? null;
    threadListState.textContent = "";
    renderThreads(threadsCache);
  } catch (error) {
    if (
      client !== targetClient ||
      requestEpoch !== threadListRequestEpoch ||
      archived !== threadListArchived
    )
      return;
    threadListState.textContent = threadListErrorMessage(error);
  } finally {
    if (
      client === targetClient &&
      requestEpoch === threadListRequestEpoch &&
      archived === threadListArchived
    ) {
      threadListLoadingMore = false;
      renderThreadDiscoveryControls();
    }
  }
}

function renderWorkspaceScope(profile: WorkspaceProfile): void {
  const availableScopes = [ALL_WORKSPACES, ...profile.roots];
  if (
    !selectedWorkspaceScope ||
    !availableScopes.includes(selectedWorkspaceScope)
  ) {
    selectedWorkspaceScope = profile.defaultRoot ?? ALL_WORKSPACES;
  }
  workspaceScopeSelect.replaceChildren(
    option(ALL_WORKSPACES, "全部工作区"),
    ...profile.roots.map((root) => option(root, root)),
  );
  workspaceScopeSelect.value = selectedWorkspaceScope;
  renderWorkspaceScopeDescription();
}

function selectWorkspaceScope(): void {
  selectedWorkspaceScope = workspaceScopeSelect.value;
  if (
    selectedWorkspaceScope !== ALL_WORKSPACES &&
    workspaceRoots.includes(selectedWorkspaceScope)
  ) {
    workspaceSelect.value = selectedWorkspaceScope;
  }
  renderWorkspaceScopeDescription();
  renderThreads(threadsCache);
}

function showActiveThreadWorkspace(): void {
  if (!activeThreadCwd) return;
  selectedWorkspaceScope =
    workspaceForCwd(workspaceRoots, activeThreadCwd) ?? ALL_WORKSPACES;
  workspaceScopeSelect.value = selectedWorkspaceScope;
  renderWorkspaceScopeDescription();
  renderThreads(threadsCache);
}

function renderWorkspaceScopeDescription(): void {
  const description = requiredElement("workspace-scope-description");
  const mismatch = requiredElement<HTMLButtonElement>("show-active-workspace");
  const scope = selectedWorkspaceScope ?? ALL_WORKSPACES;
  description.textContent =
    scope === ALL_WORKSPACES
      ? "显示所有已允许工作区；不会修改当前会话目录。"
      : `列表范围：${scope}；不会修改当前会话目录。`;
  const activeOutsideScope =
    Boolean(activeThreadCwd) &&
    scope !== ALL_WORKSPACES &&
    !workspaceContainsCwd(scope, activeThreadCwd!);
  mismatch.hidden = !activeOutsideScope;
  if (activeOutsideScope) {
    const activeRoot =
      workspaceForCwd(workspaceRoots, activeThreadCwd!) ?? activeThreadCwd!;
    mismatch.textContent = `当前会话在 ${pathName(activeRoot)} · 切回`;
    mismatch.title = activeThreadCwd!;
  }
}

function renderWorkspaceManager(defaultRoot = defaultWorkspaceRoot): void {
  const list = requiredElement("workspace-root-list");
  list.replaceChildren();
  if (workspaceRoots.length === 0) {
    list.append(emptyElement("还没有工作目录，请先添加一个。"));
    return;
  }
  for (const root of workspaceRoots) {
    const row = document.createElement("div");
    row.className = "workspace-root-row";
    const description = document.createElement("div");
    const path = document.createElement("code");
    path.textContent = root;
    const state = document.createElement("small");
    state.textContent = root === defaultRoot ? "默认启动目录" : "已允许";
    description.append(path, state);
    const actions = document.createElement("div");
    if (root !== defaultRoot) {
      const makeDefault = document.createElement("button");
      makeDefault.type = "button";
      makeDefault.className = "ghost";
      makeDefault.textContent = "设为默认";
      makeDefault.addEventListener(
        "click",
        () => void setDefaultWorkspace(root),
      );
      actions.append(makeDefault);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost danger-action";
    remove.textContent = "移除";
    remove.addEventListener("click", () => void removeWorkspace(root));
    actions.append(remove);
    row.append(description, actions);
    list.append(row);
  }
}

async function openDirectoryPicker(
  target: "session" | "workspace",
): Promise<void> {
  if (!client) return;
  directoryPickerTarget = target;
  directoryBrowseState = undefined;
  requiredElement("directory-picker-title").textContent =
    target === "session" ? "选择会话工作目录" : "浏览宿主机目录";
  requiredElement("directory-picker-help").textContent =
    target === "session"
      ? "从已允许的工作目录逐层进入子目录；新会话只会使用最终选中的路径。"
      : "从你的宿主机主目录或已允许目录开始浏览；也可以继续手动填写其他绝对路径。";
  requiredElement("select-directory").textContent =
    target === "session" ? "使用此目录" : "填入此路径";
  directoryPickerDialog.showModal();
  const startPath = target === "session" ? workspaceSelect.value : undefined;
  await browseDirectory(startPath || undefined);
}

function closeDirectoryPicker(): void {
  ++directoryBrowseSequence;
  directoryBrowseState = undefined;
  directoryPickerDialog.close();
}

async function browseDirectory(path?: string): Promise<void> {
  const currentClient = client;
  if (!currentClient) return;
  const sequence = ++directoryBrowseSequence;
  directoryBrowseState = undefined;
  requiredElement("directory-picker-error").textContent = "";
  requiredElement("directory-picker-note").textContent = "";
  requiredElement("directory-current-path").textContent = path ?? "主目录";
  requiredElement<HTMLButtonElement>("directory-parent").disabled = true;
  requiredElement<HTMLButtonElement>("select-directory").disabled = true;
  requiredElement("directory-shortcuts").replaceChildren();
  requiredElement("directory-list").replaceChildren(
    emptyElement("正在读取子目录…"),
  );
  try {
    const result = await currentClient.request<WorkspaceBrowseResponse>(
      "workspace/browse",
      path ? { path } : {},
    );
    if (
      sequence !== directoryBrowseSequence ||
      currentClient !== client ||
      !directoryPickerDialog.open
    )
      return;
    directoryBrowseState = result;
    renderDirectoryBrowser(result);
  } catch (cause) {
    if (sequence !== directoryBrowseSequence) return;
    requiredElement("directory-list").replaceChildren();
    requiredElement("directory-picker-error").textContent = errorMessage(cause);
  }
}

function renderDirectoryBrowser(result: WorkspaceBrowseResponse): void {
  requiredElement("directory-current-path").textContent = result.path;
  const parent = requiredElement<HTMLButtonElement>("directory-parent");
  const sessionPathAllowed = (path: string): boolean =>
    workspaceRoots.some((root) => workspaceContainsCwd(root, path));
  parent.disabled =
    !result.parent ||
    (directoryPickerTarget === "session" && !sessionPathAllowed(result.parent));

  const shortcuts = requiredElement("directory-shortcuts");
  shortcuts.replaceChildren();
  const locations = new Map<string, string>();
  if (directoryPickerTarget === "workspace") {
    locations.set(result.home, "⌂ 主目录");
  }
  for (const root of workspaceRoots) {
    if (!locations.has(root)) locations.set(root, `工作区 · ${pathName(root)}`);
  }
  for (const [path, label] of locations) {
    const shortcut = document.createElement("button");
    shortcut.type = "button";
    shortcut.className = `directory-shortcut${path === result.path ? " active" : ""}`;
    shortcut.textContent = label;
    shortcut.title = path;
    shortcut.addEventListener("click", () => void browseDirectory(path));
    shortcuts.append(shortcut);
  }

  const list = requiredElement("directory-list");
  list.replaceChildren();
  const visibleDirectories =
    directoryPickerTarget === "session"
      ? result.directories.filter((directory) =>
          sessionPathAllowed(directory.path),
        )
      : result.directories;
  if (visibleDirectories.length === 0) {
    list.append(emptyElement("这个目录没有可浏览的子目录"));
  } else {
    for (const directory of visibleDirectories) {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = "directory-entry";
      const icon = document.createElement("span");
      icon.className = "directory-icon";
      icon.textContent = "▸";
      const detail = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = directory.name;
      const path = document.createElement("small");
      path.textContent = directory.path;
      detail.append(name, path);
      entry.append(icon, detail);
      entry.addEventListener(
        "click",
        () => void browseDirectory(directory.path),
      );
      list.append(entry);
    }
  }

  const allowedForSession = sessionPathAllowed(result.path);
  const select = requiredElement<HTMLButtonElement>("select-directory");
  select.disabled = directoryPickerTarget === "session" && !allowedForSession;
  const notes: string[] = [];
  if (directoryPickerTarget === "session" && !allowedForSession) {
    notes.push("请先进入一个已允许的工作目录，再选择会话启动路径。");
  }
  if (result.truncated) notes.push("目录较多，仅显示前 250 项。");
  requiredElement("directory-picker-note").textContent = notes.join(" ");
}

function selectCurrentDirectory(): void {
  const path = directoryBrowseState?.path;
  if (!path) return;
  if (directoryPickerTarget === "session") {
    const existing = Array.from(workspaceSelect.options).find(
      (candidate) => candidate.value === path,
    );
    if (!existing) workspaceSelect.append(option(path, path));
    workspaceSelect.value = path;
  } else {
    const input = requiredElement<HTMLInputElement>("workspace-path-input");
    input.value = path;
    input.focus();
  }
  closeDirectoryPicker();
}

async function addWorkspace(): Promise<void> {
  if (!client) return;
  const input = requiredElement<HTMLInputElement>("workspace-path-input");
  const error = requiredElement("workspace-error");
  const path = input.value.trim();
  error.textContent = "";
  if (!path.startsWith("/")) {
    error.textContent = "请输入 HPC 上的绝对目录路径";
    return;
  }
  try {
    const result = await client.request<{ root: string }>("workspace/add", {
      path,
    });
    await client.request("workspace/default/set", { path: result.root });
    input.value = "";
    await refresh();
  } catch (cause) {
    error.textContent = errorMessage(cause);
  }
}

async function removeWorkspace(path: string): Promise<void> {
  if (!client) return;
  if (!window.confirm(`从允许目录中移除 ${path}？这不会删除磁盘上的任何文件。`))
    return;
  try {
    await client.request("workspace/remove", { path });
    await refresh();
  } catch (cause) {
    requiredElement("workspace-error").textContent = errorMessage(cause);
  }
}

async function setDefaultWorkspace(
  path = workspaceSelect.value,
): Promise<void> {
  if (!client || !path) return;
  try {
    await client.request("workspace/default/set", { path });
    defaultWorkspaceRoot = path;
    workspaceSelect.value = path;
    renderWorkspaceManager(path);
  } catch (cause) {
    requiredElement("workspace-error").textContent = errorMessage(cause);
  }
}

function renderThreads(threads: ThreadSummary[]): void {
  threadList.replaceChildren();
  renderThreadDiscoveryControls();
  const query = requiredElement<HTMLInputElement>("thread-search")
    .value.trim()
    .toLocaleLowerCase();
  const scoped = threadsInWorkspace(
    threads,
    selectedWorkspaceScope ?? ALL_WORKSPACES,
  );
  const visible = scoped.filter((thread) => {
    if (!query) return true;
    return [thread.id, thread.name, thread.preview, thread.cwd]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
  requiredElement("thread-count").textContent =
    query || scoped.length !== threads.length
      ? `${visible.length} / ${threads.length}`
      : String(threads.length);
  if (visible.length === 0) {
    threadList.append(
      emptyElement(
        query
          ? "没有匹配的会话"
          : threadListArchived
            ? "这个工作区没有已归档会话"
            : "这个工作区还没有会话",
      ),
    );
    return;
  }
  const groups = groupThreadsByCwd(visible);
  const highlightedThreadId = activeSideSession?.parent.id ?? activeThreadId;
  groups.forEach(({ cwd, threads: group }, index) => {
    const details = document.createElement("details");
    details.className = "thread-directory-group";
    const containsActiveThread = group.some(
      (thread) => thread.id === highlightedThreadId,
    );
    const remembered = threadDirectoryOpenState.get(cwd);
    details.open =
      Boolean(query) ||
      containsActiveThread ||
      (remembered ?? (groups.length === 1 || index === 0));
    const summary = document.createElement("summary");
    summary.className = "thread-directory-summary";
    summary.title = cwd;
    const label = document.createElement("span");
    label.textContent = threadDirectoryLabel(cwd);
    const count = document.createElement("span");
    count.className = "thread-directory-count";
    count.textContent = String(group.length);
    summary.append(label, count);
    const items = document.createElement("div");
    items.className = "thread-directory-items";
    for (const thread of group) renderThreadRow(thread, items);
    details.append(summary, items);
    details.addEventListener("toggle", () => {
      if (!query) threadDirectoryOpenState.set(cwd, details.open);
    });
    threadList.append(details);
  });
}

function renderThreadDiscoveryControls(): void {
  showCurrentThreadsButton.setAttribute(
    "aria-pressed",
    String(!threadListArchived),
  );
  showArchivedThreadsButton.setAttribute(
    "aria-pressed",
    String(threadListArchived),
  );
  showCurrentThreadsButton.classList.toggle("active", !threadListArchived);
  showArchivedThreadsButton.classList.toggle("active", threadListArchived);
  loadMoreThreadsButton.hidden =
    !threadListNextCursor && !threadListLoadingMore;
  loadMoreThreadsButton.disabled = threadListLoadingMore;
  loadMoreThreadsButton.textContent = threadListLoadingMore
    ? "正在加载…"
    : "加载更多";
  threadListState.hidden = threadListState.textContent === "";
}

function threadDirectoryLabel(cwd: string): string {
  const scope = selectedWorkspaceScope ?? ALL_WORKSPACES;
  const root =
    scope === ALL_WORKSPACES ? workspaceForCwd(workspaceRoots, cwd) : scope;
  return root ? workspaceRelativeCwd(root, cwd) : cwd;
}

function renderThreadRow(
  thread: ThreadSummary,
  container: HTMLElement = threadList,
): void {
  const button = document.createElement("button");
  const highlightedThreadId = activeSideSession?.parent.id ?? activeThreadId;
  button.className = `thread-item${thread.id === highlightedThreadId ? " active" : ""}`;
  const firstLine = document.createElement("span");
  firstLine.className = "thread-item-heading";
  const dot = document.createElement("i");
  dot.className = `thread-status-dot ${statusKey(thread.status)}`;
  const title = document.createElement("strong");
  title.textContent = (thread.name ?? thread.preview) || "Untitled thread";
  const trailing = document.createElement(threadListArchived ? "span" : "time");
  trailing.textContent = threadListArchived
    ? restoringArchivedThreads.has(thread.id)
      ? "恢复中…"
      : "恢复"
    : relativeTime(thread.updatedAt);
  if (threadListArchived) trailing.className = "thread-restore-label";
  firstLine.append(dot, title, trailing);
  const preview = document.createElement("small");
  preview.textContent = thread.preview || thread.cwd;
  button.append(firstLine, preview);
  if (threadListArchived) {
    button.disabled = restoringArchivedThreads.has(thread.id);
    button.setAttribute("aria-label", `恢复会话：${title.textContent}`);
    button.addEventListener("click", () => void restoreArchivedThread(thread));
  } else {
    button.addEventListener("click", () => void openThread(thread));
  }
  container.append(button);
}

async function restoreArchivedThread(thread: ThreadSummary): Promise<void> {
  const targetClient = client;
  if (!targetClient || restoringArchivedThreads.has(thread.id)) return;
  restoringArchivedThreads.add(thread.id);
  renderThreads(threadsCache);
  try {
    const response = await targetClient.request<{ thread: ThreadSummary }>(
      "thread/unarchive",
      { threadId: thread.id },
    );
    if (client !== targetClient) return;
    threadListArchived = false;
    threadListRequestEpoch += 1;
    threadListNextCursor = null;
    threadsCache = [response.thread];
    showToast("会话已恢复", "success");
    renderThreads(threadsCache);
    await refresh();
    if (client !== targetClient) return;
    setComposerSubmitting(false);
    await openThread(
      threadsCache.find((candidate) => candidate.id === thread.id) ??
        response.thread,
    );
  } catch (error) {
    if (client === targetClient) {
      showToast(`恢复归档会话失败：${errorMessage(error)}`, "error");
    }
  } finally {
    restoringArchivedThreads.delete(thread.id);
    if (client === targetClient) renderThreads(threadsCache);
  }
}

function closeActiveThreadView(): void {
  if (composerSubmitting) {
    showToast("消息正在发送，请稍候", "error");
    return;
  }
  const threadId = activeThreadId;
  const currentClient = client;
  ++openThreadSequence;
  stopThreadSync();
  activeThreadId = undefined;
  activeThreadCwd = undefined;
  activeThreadStatus = undefined;
  activeTurnId = undefined;
  activeNewestTurnId = undefined;
  activeHistoryNextCursor = undefined;
  activeHistoryPaginationExhausted = false;
  activeHistoryExhaustedNewestTurnId = undefined;
  activeHistoryMode = "none";
  olderHistoryLoading = false;
  activeThreadSettings = undefined;
  activeThreadTokenUsage = undefined;
  activeSideSession = undefined;
  threadSettingsPendingNextTurn = false;
  pendingRequestIds.clear();
  approvalSubmissions.clear();
  clearApprovalTray();
  queuedItems.clear();
  renderComposerQueue();
  workspace.classList.remove("thread-open");
  conversationOutlineView.setThreadActive(false);
  jumpToLatestButton.hidden = true;
  requiredElement("thread-title").textContent = "选择一个会话";
  requiredElement("thread-cwd").textContent = "";
  renderSideSessionChrome();
  setTuiHandoffVisible(false);
  renderComposerSessionMeta();
  messageInput.disabled = true;
  sendMessage.disabled = true;
  queueMessage.disabled = true;
  updateComposerMode();
  renderWorkspaceScopeDescription();
  renderThreads(threadsCache);
  if (threadId && currentClient) {
    void unsubscribeThread(threadId, currentClient);
  }
}

async function leaveActiveThreadView(): Promise<void> {
  if (pendingSideForkOperation) {
    showToast("请先确认或明确放弃 Side 创建结果", "error");
    renderPendingSideForkOperation();
    return;
  }
  if (activeSideSession) {
    await returnToSideParent();
    return;
  }
  closeActiveThreadView();
}

async function returnToSideParent(): Promise<void> {
  const side = activeSideSession;
  if (!side) return;
  if (
    composerSubmitting ||
    activeThreadStatus?.type === "active" ||
    hasPendingComposerOperationForThread(side.threadId)
  ) {
    showToast("请先结束 Side 回复并确认待处理消息，再返回主会话", "error");
    return;
  }
  activeSideSession = undefined;
  renderSideSessionChrome();
  await openThread(side.parent);
}

function renderSideSessionChrome(): void {
  const side = activeSideSession;
  const banner = requiredElement("side-session-banner");
  banner.hidden = !side;
  conversationContent.classList.toggle("side-session-active", Boolean(side));
  requiredElement("thread-kind-label").textContent = side
    ? "Side conversation · 临时"
    : "Codex session";
  if (side) {
    const parentTitle =
      (side.parent.name ?? side.parent.preview) || side.parent.id;
    requiredElement("side-session-parent").textContent =
      `继承自「${parentTitle}」`;
  }
  messageInput.placeholder = side
    ? "在 Side 临时支线中继续提问…"
    : client?.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1)
      ? "给 Codex 发送消息，或输入 /side 开启临时支线…"
      : "给 Codex 发送消息…";
  renderSideCommandCompletion();
}

function renderSideCommandCompletion(): void {
  const visible =
    Boolean(activeThreadId) &&
    !activeSideSession &&
    !messageInput.disabled &&
    client?.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1) === true &&
    offersSideCommandCompletion(messageInput.value);
  sideCommandCompletion.hidden = !visible;
  messageInput.setAttribute("aria-expanded", String(visible));
}

async function unsubscribeThread(
  threadId: string,
  targetClient: GatewayClient,
): Promise<void> {
  const previous = threadUnsubscribeOperations.get(threadId);
  const operation = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      try {
        await targetClient.request("thread/unsubscribe", { threadId });
      } catch {
        // Best-effort cleanup: closing this Gateway connection also releases
        // all app-server subscriptions and never interrupts the active turn.
      }
    });
  threadUnsubscribeOperations.set(threadId, operation);
  void operation.finally(() => {
    if (threadUnsubscribeOperations.get(threadId) === operation) {
      threadUnsubscribeOperations.delete(threadId);
    }
  });
  await operation;
}

async function waitForThreadUnsubscribe(threadId: string): Promise<void> {
  while (true) {
    const operation = threadUnsubscribeOperations.get(threadId);
    if (!operation) return;
    await operation;
    if (threadUnsubscribeOperations.get(threadId) === operation) return;
  }
}

function visibleTurnsForThread(
  threadId: string,
  turns: readonly Turn[],
): Turn[] {
  const side = activeSideSession;
  return side?.threadId === threadId
    ? sideVisibleTurns(turns, side.inheritedThroughTurnId, side.firstSideTurnId)
    : [...turns];
}

function hasPendingComposerOperationForThread(threadId: string): boolean {
  return [...pendingComposerOperations.values()].some(
    (operation) => operation.threadId === threadId,
  );
}

async function openThread(
  thread: ThreadSummary,
  options: {
    preserveTimeline?: boolean;
    allowWhileSubmitting?: boolean;
    initialHistory?: OpenThreadHistory;
  } = {},
): Promise<boolean> {
  if (
    pendingSideForkOperation &&
    pendingSideForkOperation.parent.id !== thread.id
  ) {
    showToast("请先确认或明确放弃 Side 创建结果", "error");
    renderPendingSideForkOperation();
    return false;
  }
  if (
    activeSideSession &&
    activeSideSession.threadId !== thread.id &&
    (activeThreadStatus?.type === "active" ||
      hasPendingComposerOperationForThread(activeSideSession.threadId))
  ) {
    showToast("请先结束 Side 回复并确认待处理消息，再打开其他会话", "error");
    return false;
  }
  if (
    activeSideSession &&
    activeSideSession.threadId !== thread.id &&
    !window.confirm("离开后无法恢复这个 Side 临时支线。确定要打开其他会话吗？")
  ) {
    return false;
  }
  if (composerSubmitting && !options.allowWhileSubmitting) {
    showToast("消息正在发送，请稍候", "error");
    return false;
  }
  const currentClient = client;
  if (!currentClient) return false;
  if (activeSideSession?.threadId !== thread.id) activeSideSession = undefined;
  const openingSide = activeSideSession;
  const previousThreadId = activeThreadId;
  stopThreadSync();
  const sequence = ++openThreadSequence;
  threadHistoryInitializationSequence = sequence;
  activeThreadId = thread.id;
  activeThreadCwd = thread.cwd;
  renderWorkspaceScopeDescription();
  activeTurnId = undefined;
  activeNewestTurnId = undefined;
  activeHistoryNextCursor = undefined;
  activeHistoryPaginationExhausted = false;
  activeHistoryExhaustedNewestTurnId = undefined;
  activeHistoryMode = "initializing";
  olderHistoryLoading = false;
  activeThreadSettings = undefined;
  activeThreadTokenUsage = undefined;
  threadSettingsPendingNextTurn = false;
  pendingRequestIds.clear();
  approvalSubmissions.clear();
  clearApprovalTray();
  queuedItems.clear();
  renderComposerQueue();
  setTuiHandoffVisible(false);
  renderComposerSessionMeta();
  lastRealtimeEventAt = Date.now();
  workspace.classList.add("thread-open");
  requiredElement("thread-title").textContent = openingSide
    ? "Side · 临时支线"
    : (thread.name ?? thread.preview) || thread.id;
  requiredElement("thread-cwd").textContent = thread.cwd;
  renderSideSessionChrome();
  setThreadStatus(thread.status);
  messageInput.disabled = true;
  sendMessage.disabled = true;
  queueMessage.disabled = true;
  if (!options.preserveTimeline) timeline.replaceChildren(loadingTimeline());
  conversationOutlineView.setThreadActive(true);
  jumpToLatestButton.hidden = true;
  try {
    if (previousThreadId && previousThreadId !== thread.id) {
      await unsubscribeThread(previousThreadId, currentClient);
    }
    await waitForThreadUnsubscribe(thread.id);
    if (
      client !== currentClient ||
      sequence !== openThreadSequence ||
      activeThreadId !== thread.id
    )
      return false;
    const history =
      options.initialHistory ??
      (openingSide
        ? await readEphemeralThreadHistory(
            currentClient,
            thread.id,
            openingSide.fallbackDetail,
          )
        : await resumeThreadHistory(currentClient, thread.id));
    const detail = history.detail;
    if (
      client !== currentClient ||
      sequence !== openThreadSequence ||
      activeThreadId !== thread.id
    ) {
      if (client !== currentClient || activeThreadId !== thread.id) {
        await unsubscribeThread(thread.id, currentClient);
      }
      return false;
    }
    const visibleTurns = visibleTurnsForThread(thread.id, detail.thread.turns);
    activeTurnId = [...visibleTurns]
      .reverse()
      .find((turn) => turn.status === "inProgress")?.id;
    activeNewestTurnId = visibleTurns.at(-1)?.id;
    activeHistoryNextCursor = openingSide ? undefined : history.nextCursor;
    activeHistoryPaginationExhausted = openingSide
      ? true
      : history.paged && history.nextCursor === undefined;
    activeHistoryExhaustedNewestTurnId = activeHistoryPaginationExhausted
      ? activeNewestTurnId
      : undefined;
    activeHistoryMode = history.paged ? "paged" : "legacy";
    setThreadStatus(detail.thread.status);
    timelineView.renderSnapshot(
      {
        ...detail,
        thread: { ...detail.thread, turns: visibleTurns },
      },
      { hasOlderHistory: Boolean(activeHistoryNextCursor) },
    );
    activeThreadSettings = {
      model: detail.model,
      effort: detail.reasoningEffort,
      approvalPolicy: detail.approvalPolicy,
      sandboxPolicy: detail.sandbox,
    };
    if (openingSide) openingSide.fallbackDetail = detail;
    setTuiHandoffVisible(!openingSide);
    renderComposerSessionMeta();
    // The authoritative initial snapshot is now committed. Queue restoration
    // may take longer, but a bounded repair can no longer race the resume.
    if (threadHistoryInitializationSequence === sequence)
      threadHistoryInitializationSequence = undefined;
    const queueSnapshot = openingSide
      ? undefined
      : await renderQueuedMessages(thread.id, sequence);
    if (
      client !== currentClient ||
      sequence !== openThreadSequence ||
      activeThreadId !== thread.id
    ) {
      if (client !== currentClient || activeThreadId !== thread.id) {
        await unsubscribeThread(thread.id, currentClient);
      }
      return false;
    }
    reconcilePendingComposerOperations(
      thread.id,
      visibleTurns,
      !history.paged || history.nextCursor === undefined,
      queueSnapshot,
      {
        // The history snapshot predates queue/list. A queued item can dispatch
        // between those reads, so this pass is positive evidence only.
        negativeEvidenceAllowed: false,
        targetClient: currentClient,
      },
    );
    messageInput.disabled = false;
    updateComposerSubmitAvailability();
    renderThreads(threadsCache);
    return true;
  } catch (error) {
    if (
      client !== currentClient ||
      sequence !== openThreadSequence ||
      activeThreadId !== thread.id
    )
      return false;
    appendTimeline("error", "无法读取 thread", errorMessage(error));
    startThreadSync();
    renderThreads(threadsCache);
    return false;
  } finally {
    if (threadHistoryInitializationSequence === sequence)
      threadHistoryInitializationSequence = undefined;
  }
}

async function openNewSession(): Promise<void> {
  requiredElement("new-session-error").textContent = "";
  if (pendingSideForkOperation) {
    showToast("请先确认或明确放弃 Side 创建结果", "error");
    renderPendingSideForkOperation();
    return;
  }
  if (activeSideSession) {
    showToast("请先返回主会话，再创建新会话", "error");
    return;
  }
  if (threadStartManualReviewRequired()) {
    newSessionDialog.showModal();
    renderIndeterminateThreadStart();
    return;
  }
  if (workspaceRoots.length === 0) {
    workspaceDialog.showModal();
    renderWorkspaceManager();
    return;
  }
  const currentClient = client;
  if (!currentClient) return;
  try {
    await loadSessionPermissionDefaults(currentClient);
  } catch (error) {
    showToast(`无法读取最新默认权限，请重试：${errorMessage(error)}`, "error");
    return;
  }
  if (client !== currentClient) return;
  if (
    selectedWorkspaceScope &&
    selectedWorkspaceScope !== ALL_WORKSPACES &&
    workspaceRoots.includes(selectedWorkspaceScope)
  ) {
    workspaceSelect.value = selectedWorkspaceScope;
  }
  requiredElement<HTMLSelectElement>("new-session-sandbox").value =
    sessionPermissionDefaults.sandbox;
  requiredElement<HTMLSelectElement>("new-session-approval").value =
    sessionPermissionDefaults.approvalPolicy;
  renderNewSessionPermissions();
  newSessionDialog.showModal();
  requiredElement<HTMLTextAreaElement>("new-prompt").focus();
  if (codexModels.length > 0) return;
  try {
    const result = await currentClient.request<{ data: Model[] }>(
      "model/list",
      {
        limit: 100,
      },
    );
    if (client !== currentClient) return;
    codexModels = result.data.filter((model) => !model.hidden);
    const modelSelect = requiredElement<HTMLSelectElement>("new-session-model");
    modelSelect.replaceChildren(option("", "Codex 默认"));
    for (const model of codexModels) {
      modelSelect.append(
        option(
          model.id,
          `${model.displayName}${model.isDefault ? " · 默认" : ""}`,
        ),
      );
    }
    renderReasoningEfforts();
  } catch (error) {
    requiredElement("new-session-error").textContent =
      `无法读取模型列表：${errorMessage(error)}`;
  }
}

function renderReasoningEfforts(): void {
  const modelId = requiredElement<HTMLSelectElement>("new-session-model").value;
  const model =
    codexModels.find((candidate) => candidate.id === modelId) ??
    codexModels.find((candidate) => candidate.isDefault);
  const effort = requiredElement<HTMLSelectElement>("new-session-effort");
  const previous = effort.value;
  effort.replaceChildren(option("", "模型默认"));
  for (const item of model?.supportedReasoningEfforts ?? []) {
    effort.append(option(item.reasoningEffort, item.reasoningEffort));
  }
  if (Array.from(effort.options).some((item) => item.value === previous))
    effort.value = previous;
}

async function openThreadSettings(
  focus?: "model" | "permissions",
): Promise<void> {
  if (!client || !activeThreadSettings) return;
  const error = requiredElement("thread-settings-error");
  error.textContent = "";
  try {
    if (codexModels.length === 0) {
      const result = await client.request<{ data: Model[] }>("model/list", {
        limit: 100,
      });
      codexModels = result.data.filter((model) => !model.hidden);
    }
    const model = requiredElement<HTMLSelectElement>("thread-model");
    model.replaceChildren();
    const currentModel = activeThreadSettings.model;
    if (!codexModels.some((item) => item.id === currentModel))
      model.append(option(currentModel, currentModel));
    for (const item of codexModels)
      model.append(
        option(
          item.id,
          `${item.displayName}${item.isDefault ? " · 推荐" : ""}`,
        ),
      );
    model.value = currentModel;
    renderThreadReasoningEfforts();
    const approval = requiredElement<HTMLSelectElement>("thread-approval");
    approval.querySelector('option[value="custom"]')?.remove();
    if (typeof activeThreadSettings.approvalPolicy === "string") {
      approval.value = activeThreadSettings.approvalPolicy;
    } else {
      const custom = option("custom", "自定义审批策略（保持不变）");
      approval.append(custom);
      approval.value = "custom";
    }
    const sandbox = requiredElement<HTMLSelectElement>("thread-sandbox");
    sandbox.querySelector('option[value="externalSandbox"]')?.remove();
    if (activeThreadSettings.sandboxPolicy.type === "externalSandbox") {
      sandbox.append(option("externalSandbox", "外部沙箱（保持不变）"));
    }
    sandbox.value = activeThreadSettings.sandboxPolicy.type;
    requiredElement("thread-settings-notice").hidden =
      activeThreadStatus?.type !== "active";
    threadSettingsDialog.showModal();
    if (focus === "model") {
      requiredElement<HTMLSelectElement>("thread-model").focus();
    } else if (focus === "permissions") {
      requiredElement<HTMLSelectElement>("thread-sandbox").focus();
    }
  } catch (cause) {
    error.textContent = errorMessage(cause);
    threadSettingsDialog.showModal();
  }
}

function renderThreadReasoningEfforts(): void {
  const modelId = requiredElement<HTMLSelectElement>("thread-model").value;
  const model = codexModels.find((item) => item.id === modelId);
  const effort = requiredElement<HTMLSelectElement>("thread-effort");
  const selected = activeThreadSettings?.effort ?? "";
  effort.replaceChildren(option("", "模型默认"));
  for (const item of model?.supportedReasoningEfforts ?? [])
    effort.append(option(item.reasoningEffort, item.reasoningEffort));
  if (Array.from(effort.options).some((item) => item.value === selected))
    effort.value = selected;
}

async function saveThreadSettings(): Promise<void> {
  if (!client || !activeThreadSettings || !activeThreadId) return;
  const targetClient = client;
  const threadId = activeThreadId;
  const currentSettings = activeThreadSettings;
  const button = requiredElement<HTMLButtonElement>("save-thread-settings");
  const error = requiredElement("thread-settings-error");
  const model = requiredElement<HTMLSelectElement>("thread-model").value;
  const effort = requiredElement<HTMLSelectElement>("thread-effort").value;
  const approval = requiredElement<HTMLSelectElement>("thread-approval").value;
  const sandboxType = requiredElement<HTMLSelectElement>("thread-sandbox")
    .value as SandboxPolicy["type"];
  const approvalPolicy =
    approval === "custom"
      ? currentSettings.approvalPolicy
      : (approval as AskForApproval);
  if (
    sandboxType === "dangerFullAccess" &&
    currentSettings.sandboxPolicy.type !== "dangerFullAccess" &&
    !window.confirm(
      "完全访问允许 Codex 读写工作目录之外的文件并执行不受沙箱限制的命令。确定启用吗？",
    )
  )
    return;
  const settingsUpdate: Record<string, unknown> = {};
  if (model !== currentSettings.model) settingsUpdate.model = model;
  if (effort !== (currentSettings.effort ?? ""))
    settingsUpdate.effort = effort || null;
  if (approvalPolicy !== currentSettings.approvalPolicy) {
    settingsUpdate.approvalPolicy = approvalPolicy;
  }
  if (
    sandboxType !== currentSettings.sandboxPolicy.type &&
    sandboxType !== "externalSandbox"
  ) {
    settingsUpdate.sandboxPolicy = sandboxPolicyForType(
      sandboxType,
      currentSettings.sandboxPolicy,
    );
  }
  error.textContent = "";
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    await targetClient.request("thread/settings/update", {
      threadId,
      ...settingsUpdate,
    });
    if (client !== targetClient || activeThreadId !== threadId) return;
    activeThreadSettings = {
      model,
      effort: (effort || null) as ReasoningEffort | null,
      approvalPolicy,
      sandboxPolicy:
        sandboxType === currentSettings.sandboxPolicy.type ||
        sandboxType === "externalSandbox"
          ? currentSettings.sandboxPolicy
          : sandboxPolicyForType(sandboxType, currentSettings.sandboxPolicy),
    };
    threadSettingsPendingNextTurn = activeThreadStatus?.type === "active";
    renderComposerSessionMeta();
    threadSettingsDialog.close();
    showToast(
      activeThreadStatus?.type === "active"
        ? "设置已保存，当前任务结束后的下一轮生效"
        : "会话设置已保存",
      "success",
    );
  } catch (cause) {
    error.textContent = errorMessage(cause);
  } finally {
    button.disabled = false;
    button.textContent = "保存设置";
  }
}

function availableSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function threadStartManualReviewRequired(): boolean {
  return (
    threadStartReloadReviewRequired ||
    Boolean(pendingThreadStartOperation?.manualReviewRequired)
  );
}

function armUnresolvedThreadStartMarker(): void {
  threadStartSafetyMarkerArmed = true;
  markThreadStartUnresolved(threadStartMarkerStorage);
}

function clearThreadStartSafetyMarker(): void {
  threadStartSafetyMarkerArmed = false;
  threadStartReloadReviewRequired = false;
  clearUnresolvedThreadStartMarker(threadStartMarkerStorage);
}

function warnBeforeUnresolvedMutationUnload(event: BeforeUnloadEvent): void {
  const hasUnresolvedMutation =
    threadStartSafetyMarkerArmed ||
    pendingThreadStartOperation !== undefined ||
    pendingSideForkOperation !== undefined ||
    inFlightComposerOperations.size > 0 ||
    pendingComposerOperations.size > 0;
  if (!hasUnresolvedMutation) return;
  event.preventDefault();
  event.returnValue = "仍有操作结果待确认。";
}

function renderIndeterminateThreadStart(): void {
  const manualReviewRequired = threadStartManualReviewRequired();
  requiredElement("thread-start-outcome-review").hidden = !manualReviewRequired;
  const start = requiredElement<HTMLButtonElement>("start-task");
  start.hidden = manualReviewRequired;
  if (!manualReviewRequired) return;
  requiredElement("new-session-error").textContent =
    "上次页面在会话创建结果明确前离开，无法证明会话是否已经创建；已停止自动重放。";
  requiredElement<HTMLTextAreaElement>("new-prompt").disabled = true;
}

async function inspectIndeterminateThreadStart(): Promise<void> {
  if (!threadStartManualReviewRequired()) return;
  if (threadListArchived) await selectThreadArchiveView(false);
  else await refresh();
  if (threadListState.textContent) {
    showToast("会话列表刷新失败，请恢复连接后再核对。", "error");
    return;
  }
  if (newSessionDialog.open) newSessionDialog.close();
  showToast("会话列表已刷新；系统未自动认领任何候选会话。", "success");
}

function abandonIndeterminateThreadStart(): void {
  if (!threadStartManualReviewRequired()) return;
  if (
    !window.confirm(
      "原会话可能已经创建。确认已核对会话列表，并放弃这条待确认记录？之后再次创建可能产生重复会话。",
    )
  )
    return;
  pendingThreadStartOperation = undefined;
  clearThreadStartSafetyMarker();
  updateMutationOutcomePendingState();
  requiredElement("thread-start-outcome-review").hidden = true;
  const start = requiredElement<HTMLButtonElement>("start-task");
  start.hidden = false;
  start.disabled = workspaceRoots.length === 0;
  start.removeAttribute("aria-busy");
  start.textContent = "创建并发送";
  requiredElement<HTMLTextAreaElement>("new-prompt").disabled = false;
  requiredElement("new-session-error").textContent =
    "已放弃旧的待确认记录；再次创建会使用新的操作编号。";
}

async function startTask(): Promise<void> {
  const prompt = requiredElement<HTMLTextAreaElement>("new-prompt");
  if (threadStartManualReviewRequired()) {
    renderIndeterminateThreadStart();
    return;
  }
  if (pendingThreadStartOperation) {
    await resumePendingThreadStartOperation();
    return;
  }
  if (!client) return;
  if (!workspaceSelect.value || !prompt.value.trim()) return;
  const threadPayload: Record<string, unknown> = {
    cwd: workspaceSelect.value,
  };
  for (const [id, key] of [
    ["new-session-model", "model"],
    ["new-session-sandbox", "sandbox"],
    ["new-session-approval", "approvalPolicy"],
  ] as const) {
    const value = requiredElement<HTMLSelectElement>(id).value;
    if (value) threadPayload[key] = value;
  }
  const operationId = crypto.randomUUID();
  armUnresolvedThreadStartMarker();
  pendingThreadStartOperation = {
    operationId,
    idempotencyKey: operationId,
    deviceId: client.host.deviceId,
    threadPayload,
    prompt: prompt.value.trim(),
    effort: requiredElement<HTMLSelectElement>("new-session-effort").value,
    ...(activeThreadId ? { previousThreadId: activeThreadId } : {}),
    outcomeUnknown: false,
    manualReviewRequired: false,
  };
  updateMutationOutcomePendingState();
  await resumePendingThreadStartOperation();
}

async function resumePendingThreadStartOperation(): Promise<void> {
  if (threadStartReconciliation) return threadStartReconciliation;
  const operation = pendingThreadStartOperation;
  const initialClient = client;
  if (!operation || !initialClient) return;
  const error = requiredElement("new-session-error");
  const start = requiredElement<HTMLButtonElement>("start-task");
  const prompt = requiredElement<HTMLTextAreaElement>("new-prompt");
  error.textContent = operation.outcomeUnknown
    ? "正在确认上次创建结果；不会新建重复会话。"
    : "";
  start.disabled = true;
  start.setAttribute("aria-busy", "true");
  start.textContent = operation.outcomeUnknown ? "正在确认…" : "正在创建…";
  prompt.disabled = true;

  if (operation.manualReviewRequired) {
    renderIndeterminateThreadStart();
    return;
  }

  if (
    operation.outcomeUnknown &&
    operation.deviceId !== initialClient.host.deviceId
  ) {
    error.textContent =
      "登录身份已变化，无法安全重试上次创建操作；请回到原设备会话完成确认。";
    start.textContent = "等待原会话确认";
    updateMutationOutcomePendingState();
    return;
  }

  const reconciliation = (async () => {
    try {
      const recovered =
        await requestRecoverableGatewayMutation<ThreadStartResponse>({
          client: initialClient,
          method: "thread/start",
          payload: operation.threadPayload,
          idempotencyKey: operation.idempotencyKey,
          reconnect: async (failedClient) => {
            operation.outcomeUnknown = true;
            updateMutationOutcomePendingState();
            await recoverConnection(failedClient);
            if (!client || client === failedClient)
              throw new Error("Host connection has not recovered yet");
            return client;
          },
        });
      if (pendingThreadStartOperation !== operation) return;
      clearThreadStartSafetyMarker();
      pendingThreadStartOperation = undefined;
      updateMutationOutcomePendingState();
      await completeStartedTask(recovered.client, recovered.value, operation);
    } catch (cause) {
      if (
        cause instanceof GatewayResponseError &&
        cause.code === IDEMPOTENCY_OUTCOME_INDETERMINATE
      ) {
        operation.outcomeUnknown = true;
        operation.manualReviewRequired = true;
        updateMutationOutcomePendingState();
        renderIndeterminateThreadStart();
        return;
      }
      if (
        isGatewayRequestOutcomeUnknown(cause) ||
        cause instanceof GatewayMutationRecoveryPendingError
      ) {
        operation.outcomeUnknown = true;
        error.textContent =
          "连接中断，创建结果待确认；连接恢复后会使用原操作编号继续，不会重复创建。";
        updateMutationOutcomePendingState();
        return;
      }
      if (pendingThreadStartOperation === operation) {
        clearThreadStartSafetyMarker();
        pendingThreadStartOperation = undefined;
      }
      updateMutationOutcomePendingState();
      error.textContent = errorMessage(cause);
    } finally {
      const pending = pendingThreadStartOperation === operation;
      start.disabled = pending || workspaceRoots.length === 0;
      if (pending) start.setAttribute("aria-busy", "true");
      else start.removeAttribute("aria-busy");
      start.textContent = pending ? "等待确认…" : "创建并发送";
      prompt.disabled = pending;
      renderIndeterminateThreadStart();
    }
  })();
  threadStartReconciliation = reconciliation.finally(() => {
    threadStartReconciliation = undefined;
  });
  return threadStartReconciliation;
}

async function completeStartedTask(
  taskClient: GatewayClient,
  started: ThreadStartResponse,
  operation: PendingThreadStartOperation,
): Promise<void> {
  const error = requiredElement("new-session-error");
  const prompt = requiredElement<HTMLTextAreaElement>("new-prompt");
  let turnOperation: PendingComposerOperation | undefined;
  let turnStarted = false;
  try {
    queuedItems.clear();
    renderComposerQueue();
    ++openThreadSequence;
    activeThreadId = started.thread.id;
    activeThreadCwd = started.thread.cwd;
    activeTurnId = undefined;
    activeNewestTurnId = undefined;
    activeHistoryNextCursor = undefined;
    activeHistoryPaginationExhausted = false;
    activeHistoryExhaustedNewestTurnId = undefined;
    // A newly created thread has no older history. Keep repair reads bounded
    // from the first turn instead of temporarily treating it as legacy.
    activeHistoryMode = "paged";
    olderHistoryLoading = false;
    renderWorkspaceScopeDescription();
    workspace.classList.add("thread-open");
    requiredElement("thread-title").textContent =
      started.thread.name ?? "New thread";
    requiredElement("thread-cwd").textContent = started.thread.cwd;
    activeThreadSettings = {
      model: started.model,
      effort: started.reasoningEffort,
      approvalPolicy: started.approvalPolicy,
      sandboxPolicy: started.sandbox,
    };
    setTuiHandoffVisible(true);
    activeThreadTokenUsage = undefined;
    renderComposerSessionMeta();
    setThreadStatus({ type: "active" });
    messageInput.disabled = false;
    sendMessage.disabled = false;
    queueMessage.disabled = false;
    timelineView.clear("Codex 正在处理第一条消息…");
    conversationOutlineView.setThreadActive(true);
    const input: UserInput[] = [
      { type: "text", text: operation.prompt, text_elements: [] },
    ];
    const turnPayload: Record<string, unknown> = {
      threadId: started.thread.id,
      input,
      ...(operation.effort ? { effort: operation.effort } : {}),
    };
    turnOperation = createPendingComposerOperation(
      "turn",
      taskClient,
      started.thread.id,
      input,
      operation.prompt,
    );
    beginComposerOperationRequest(turnOperation);
    turnPayload.clientUserMessageId = turnOperation.operationId;
    timelineView.appendLocalUser(input, turnOperation.operationId);
    const turnResponse = await taskClient.request<TurnStartResponse>(
      "turn/start",
      turnPayload,
      { idempotencyKey: turnOperation.idempotencyKey },
    );
    completeComposerOperationRequest(turnOperation);
    turnStarted = true;
    activeTurnId = turnResponse.turn.id;
    activeNewestTurnId = turnResponse.turn.id;
    timelineView.bindLocalUserToTurn(
      turnResponse.turn.id,
      turnOperation.operationId,
    );
    if (
      operation.previousThreadId &&
      operation.previousThreadId !== started.thread.id
    ) {
      await unsubscribeThread(operation.previousThreadId, taskClient);
    }
    prompt.value = "";
    newSessionDialog.close();
    await refresh();
  } catch (cause) {
    if (turnStarted) {
      prompt.value = "";
      newSessionDialog.close();
      showToast(
        `第一条消息已经发送，但后续界面刷新失败：${errorMessage(cause)}`,
        "error",
      );
      return;
    }
    if (turnOperation && isGatewayMutationOutcomeIndeterminate(cause)) {
      prompt.value = "";
      newSessionDialog.close();
      markComposerOperationIndeterminate(turnOperation);
      return;
    }
    if (turnOperation && isGatewayRequestOutcomeUnknown(cause)) {
      prompt.value = "";
      newSessionDialog.close();
      markComposerOperationUnknown(turnOperation, taskClient, cause);
      return;
    }
    try {
      await taskClient.request("thread/delete", {
        threadId: started.thread.id,
      });
    } catch {
      // Preserve the original first-turn error.
    }
    timelineView.removeLocalUser(turnOperation?.operationId);
    error.textContent = errorMessage(cause);
  } finally {
    if (turnOperation) completeComposerOperationRequest(turnOperation);
  }
}

function setComposerSubmitting(submitting: boolean): void {
  composerSubmitting = submitting;
  if (submitting) sendMessage.setAttribute("aria-busy", "true");
  else sendMessage.removeAttribute("aria-busy");
  updateComposerSubmitAvailability();
}

function updateComposerSubmitAvailability(): void {
  updateMutationOutcomePendingState();
  const outcomePending = [...pendingComposerOperations.values()].some(
    (operation) => operation.threadId === activeThreadId,
  );
  const unavailable =
    composerSubmitting ||
    Boolean(pendingSideForkOperation) ||
    outcomePending ||
    inFlightComposerOperations.size > 0 ||
    (Boolean(activeSideSession) && activeThreadStatus?.type === "active") ||
    messageInput.disabled;
  sendMessage.disabled = unavailable;
  queueMessage.disabled = unavailable;
}

function updateMutationOutcomePendingState(): void {
  document.body.classList.toggle(
    "mutation-outcome-pending",
    pendingComposerOperations.size > 0 ||
      inFlightComposerOperations.size > 0 ||
      Boolean(pendingThreadStartOperation) ||
      Boolean(pendingSideForkOperation) ||
      threadStartReloadReviewRequired,
  );
}

async function queueForThread(): Promise<void> {
  await submitComposerMessage(true);
}

async function continueThread(): Promise<void> {
  await submitComposerMessage(false);
}

async function submitComposerMessage(forceQueue: boolean): Promise<void> {
  const rawText = messageInput.value;
  const text = rawText.trim();
  const targetClient = client;
  const threadId = activeThreadId;
  if (!targetClient || !threadId || composerSubmitting || !text) return;
  const command = parseWebComposerCommand(rawText);
  if (command.kind === "invalid-side") {
    showToast("用法：/side <你想在临时支线中询问的问题>", "error");
    return;
  }
  if (command.kind === "unsupported") {
    showToast(
      "Web 目前只支持 /side；其他斜杠指令请通过 SSH TUI 执行。",
      "error",
    );
    return;
  }
  if (command.kind === "side") {
    await startSideConversation(command.prompt);
    return;
  }
  if (activeSideSession && activeThreadStatus?.type === "active") {
    showToast("Side 回复尚未结束；临时支线不支持持久 Queue", "error");
    return;
  }
  if (
    [...pendingComposerOperations.values()].some(
      (operation) => operation.threadId === threadId,
    )
  ) {
    showToast("请先等待上一条消息的发送结果确认", "error");
    return;
  }

  setComposerSubmitting(true);
  const input: UserInput[] = [{ type: "text", text, text_elements: [] }];
  const shouldQueue =
    !activeSideSession &&
    (forceQueue || threadSendMode(activeThreadStatus) === "queue");
  const operation = createPendingComposerOperation(
    shouldQueue ? "queue" : "turn",
    targetClient,
    threadId,
    input,
    text,
  );
  beginComposerOperationRequest(operation);
  let messageCleared = false;
  let localMessageAppended = false;
  try {
    messageInput.value = "";
    messageCleared = true;
    autoResize(messageInput);
    renderSideCommandCompletion();
    if (shouldQueue) {
      const item = await targetClient.request<QueueItem>(
        "queue/add",
        {
          threadId,
          input,
          clientUserMessageId: operation.operationId,
        },
        {
          idempotencyKey: operation.idempotencyKey,
        },
      );
      queuedItems.set(item.id, item);
      renderComposerQueue();
      showToast(
        forceQueue ? "消息已加入队列" : "当前任务仍在运行，消息已加入队列",
        "success",
      );
    } else {
      timelineView.appendLocalUser(input, operation.operationId);
      localMessageAppended = true;
      await sendTurn(targetClient, operation);
    }
  } catch (error) {
    if (isGatewayMutationOutcomeIndeterminate(error)) {
      markComposerOperationIndeterminate(operation);
    } else if (isGatewayRequestOutcomeUnknown(error)) {
      markComposerOperationUnknown(operation, targetClient, error);
    } else {
      if (localMessageAppended)
        timelineView.removeLocalUser(operation.operationId);
      if (messageCleared && !messageInput.value) messageInput.value = text;
      autoResize(messageInput);
      messageInput.focus();
      appendTimeline(
        "error",
        shouldQueue ? "排队失败" : "发送失败",
        errorMessage(error),
      );
    }
  } finally {
    completeComposerOperationRequest(operation);
    setComposerSubmitting(false);
  }
}

async function startSideConversation(prompt: string): Promise<void> {
  const targetClient = client;
  const parent = activeThreadSnapshot();
  if (!targetClient || !parent) return;
  if (!targetClient.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1)) {
    showToast("当前 Agent 版本不支持 Side；请先完成 Agent 升级", "error");
    return;
  }
  if (activeSideSession) {
    showToast("当前已经在 Side 中；请先返回主会话", "error");
    return;
  }
  if (activeThreadStatus?.type === "active") {
    showToast("请等待主会话当前回复结束后再开启 Side", "error");
    return;
  }
  if (!activeNewestTurnId) {
    showToast("当前会话还没有可继承的对话；请先发送一条普通消息", "error");
    return;
  }
  if (pendingSideForkOperation) {
    showToast("已有 Side 创建结果待确认，请使用原操作编号继续", "error");
    renderPendingSideForkOperation();
    return;
  }
  if (
    [...pendingComposerOperations.values()].some(
      (operation) => operation.threadId === parent.id,
    )
  ) {
    showToast("请先确认上一条消息的发送结果", "error");
    return;
  }

  const forkIdempotencyKey = crypto.randomUUID();
  pendingSideForkOperation = {
    idempotencyKey: forkIdempotencyKey,
    deviceId: targetClient.host.deviceId,
    parent,
    prompt,
    inheritedThroughTurnId: activeNewestTurnId,
    outcomeUnknown: false,
    manualReviewRequired: false,
  };
  updateMutationOutcomePendingState();
  renderPendingSideForkOperation();
  await resumePendingSideForkOperation();
}

async function resumePendingSideForkOperation(): Promise<void> {
  if (sideForkReconciliation) return sideForkReconciliation;
  const operation = pendingSideForkOperation;
  const initialClient = client;
  if (!operation || !initialClient || operation.manualReviewRequired) {
    renderPendingSideForkOperation();
    return;
  }
  if (
    operation.outcomeUnknown &&
    operation.deviceId !== initialClient.host.deviceId
  ) {
    operation.manualReviewRequired = true;
    renderPendingSideForkOperation();
    showToast("登录身份已变化，无法安全确认原 Side 创建操作", "error");
    return;
  }

  setComposerSubmitting(true);
  const reconciliation = (async () => {
    try {
      const recovered =
        await requestRecoverableGatewayMutation<SideThreadForkResponse>({
          client: initialClient,
          method: "thread/fork",
          payload: {
            threadId: operation.parent.id,
            lastTurnId: operation.inheritedThroughTurnId,
            ephemeral: true,
          },
          idempotencyKey: operation.idempotencyKey,
          reconnect: async (failedClient) => {
            operation.outcomeUnknown = true;
            renderPendingSideForkOperation();
            await recoverConnection(failedClient);
            if (!client || client === failedClient)
              throw new Error("Host connection has not recovered yet");
            if (!client.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1)) {
              throw new SideCapabilityUnavailableAfterRecovery(
                "The recovered Agent does not advertise bounded Side support",
              );
            }
            return client;
          },
        });
      if (pendingSideForkOperation !== operation) return;
      assertSideForkResponse(recovered.value, operation);
      pendingSideForkOperation = undefined;
      updateMutationOutcomePendingState();
      renderPendingSideForkOperation();
      await completeSideForkOperation(
        recovered.client,
        recovered.value,
        operation,
      );
    } catch (error) {
      if (pendingSideForkOperation !== operation) return;
      if (isGatewayMutationOutcomeIndeterminate(error)) {
        operation.outcomeUnknown = true;
        operation.manualReviewRequired = true;
        showToast("Side 创建结果无法证明；已停止自动重放", "error");
      } else if (error instanceof SideCapabilityUnavailableAfterRecovery) {
        operation.outcomeUnknown = true;
        operation.manualReviewRequired = true;
        showToast("Agent 无法提供当前 Side 安全边界；已停止自动重放", "error");
      } else if (
        isGatewayRequestOutcomeUnknown(error) ||
        error instanceof GatewayMutationRecoveryPendingError
      ) {
        operation.outcomeUnknown = true;
        showToast("连接中断，Side 创建结果待确认；将保留原操作编号", "error");
      } else {
        pendingSideForkOperation = undefined;
        if (!messageInput.value)
          messageInput.value = `/side ${operation.prompt}`;
        autoResize(messageInput);
        showToast(`无法开启 Side：${errorMessage(error)}`, "error");
      }
      updateMutationOutcomePendingState();
      renderPendingSideForkOperation();
    } finally {
      setComposerSubmitting(false);
    }
  })();
  sideForkReconciliation = reconciliation.finally(() => {
    sideForkReconciliation = undefined;
    renderPendingSideForkOperation();
  });
  renderPendingSideForkOperation();
  return sideForkReconciliation;
}

async function completeSideForkOperation(
  targetClient: GatewayClient,
  fork: SideThreadForkResponse,
  operation: PendingSideForkOperation,
): Promise<void> {
  let turnOperation: PendingComposerOperation | undefined;
  try {
    assertSideForkResponse(fork, operation);
    activeSideSession = {
      threadId: fork.thread.id,
      parent: operation.parent,
      inheritedThroughTurnId: operation.inheritedThroughTurnId,
      appServerInstanceId: fork.sideFork.appServerInstanceId,
      fallbackDetail: fork,
    };
    await openThread(
      {
        id: fork.thread.id,
        name: null,
        preview: "Side 临时支线",
        cwd: fork.thread.cwd,
        status: fork.thread.status,
        updatedAt: fork.thread.updatedAt,
      },
      {
        allowWhileSubmitting: true,
        initialHistory: {
          detail: fork,
          nextCursor: undefined,
          paged: true,
        },
      },
    );
    if (
      client !== targetClient ||
      activeSideSession?.threadId !== fork.thread.id ||
      activeThreadId !== fork.thread.id ||
      !activeThreadSettings
    ) {
      throw new Error("Side 已创建，但临时会话未能安全打开");
    }

    messageInput.value = "";
    autoResize(messageInput);
    const input: UserInput[] = [
      { type: "text", text: operation.prompt, text_elements: [] },
    ];
    turnOperation = createPendingComposerOperation(
      "turn",
      targetClient,
      fork.thread.id,
      input,
      operation.prompt,
    );
    beginComposerOperationRequest(turnOperation);
    timelineView.appendLocalUser(input, turnOperation.operationId);
    const turn = await sendTurn(targetClient, turnOperation);
    if (activeSideSession?.threadId === fork.thread.id) {
      activeSideSession.firstSideTurnId = turn.turn.id;
    }
    showToast("已开启 Side 临时支线", "success");
  } catch (error) {
    if (turnOperation && isGatewayMutationOutcomeIndeterminate(error)) {
      markComposerOperationIndeterminate(turnOperation);
    } else if (turnOperation && isGatewayRequestOutcomeUnknown(error)) {
      markComposerOperationUnknown(turnOperation, targetClient, error);
    } else if (turnOperation) {
      timelineView.removeLocalUser(turnOperation.operationId);
      if (!messageInput.value) messageInput.value = operation.prompt;
      autoResize(messageInput);
      showToast(`Side 消息发送失败：${errorMessage(error)}`, "error");
    } else showToast(`无法完成 Side 初始化：${errorMessage(error)}`, "error");
  } finally {
    if (turnOperation) completeComposerOperationRequest(turnOperation);
  }
}

function assertSideForkResponse(
  fork: SideThreadForkResponse,
  operation: PendingSideForkOperation,
): void {
  if (
    !fork.thread.ephemeral ||
    fork.thread.forkedFromId !== operation.parent.id ||
    fork.sideFork?.version !== 1 ||
    fork.sideFork.inheritedThroughTurnId !== operation.inheritedThroughTurnId ||
    typeof fork.sideFork.appServerInstanceId !== "string" ||
    !fork.sideFork.appServerInstanceId
  ) {
    throw new SideCapabilityUnavailableAfterRecovery(
      "Codex did not return a bounded Side response for the current app-server instance",
    );
  }
}

function renderPendingSideForkOperation(): void {
  const operation = pendingSideForkOperation;
  const review = requiredElement("side-fork-outcome-review");
  review.hidden = !operation;
  if (!operation) return;
  requiredElement("side-fork-outcome-review-copy").textContent =
    operation.manualReviewRequired
      ? "Agent 无法证明原 Side 是否已经创建，系统已停止自动重放。请核对后再明确放弃；放弃后使用新操作编号可能创建另一条支线。"
      : "Side 创建结果尚未确认。系统会保留原操作编号继续确认，不会用新编号重复分叉。";
  requiredElement<HTMLButtonElement>("retry-side-fork-outcome").disabled =
    operation.manualReviewRequired || Boolean(sideForkReconciliation);
  requiredElement<HTMLButtonElement>("abandon-side-fork-outcome").disabled =
    !operation.outcomeUnknown || Boolean(sideForkReconciliation);
}

function abandonPendingSideForkOperation(): void {
  const operation = pendingSideForkOperation;
  if (!operation) return;
  if (!operation.outcomeUnknown || sideForkReconciliation) {
    showToast("Side 创建请求仍在执行，暂时不能放弃", "error");
    return;
  }
  if (
    !window.confirm(
      "只有在确认可以承担重复 Side 风险后才应放弃。确定清除这条待确认记录吗？",
    )
  )
    return;
  pendingSideForkOperation = undefined;
  updateMutationOutcomePendingState();
  renderPendingSideForkOperation();
  if (!messageInput.value) messageInput.value = `/side ${operation.prompt}`;
  autoResize(messageInput);
}

async function sendTurn(
  targetClient: GatewayClient,
  operation: PendingComposerOperation,
): Promise<TurnStartResponse> {
  const response = await targetClient.request<TurnStartResponse>(
    "turn/start",
    {
      threadId: operation.threadId,
      input: operation.input,
      clientUserMessageId: operation.operationId,
    },
    {
      idempotencyKey: operation.idempotencyKey,
    },
  );
  if (client !== targetClient || activeThreadId !== operation.threadId)
    return response;
  if (
    activeSideSession?.threadId === operation.threadId &&
    !activeSideSession.firstSideTurnId
  ) {
    activeSideSession.firstSideTurnId = response.turn.id;
  }
  activeTurnId = response.turn.id;
  activeNewestTurnId = response.turn.id;
  timelineView.bindLocalUserToTurn(response.turn.id, operation.operationId);
  setThreadStatus({ type: "active", activeFlags: [] });
  lastRealtimeEventAt = Date.now();
  startThreadSync();
  return response;
}

function createPendingComposerOperation(
  kind: ComposerOperationKind,
  targetClient: GatewayClient,
  threadId: string,
  input: UserInput[],
  text: string,
): PendingComposerOperation {
  const operationId = crypto.randomUUID();
  return {
    kind,
    operationId,
    idempotencyKey: operationId,
    deviceId: targetClient.host.deviceId,
    threadId,
    input,
    text,
    reconciliationStartedAt: Date.now(),
    authoritativeChecks: 0,
    manualReviewRequired: false,
    ...(activeThreadId === threadId && activeNewestTurnId
      ? { reconciliationBoundaryTurnId: activeNewestTurnId }
      : {}),
  };
}

function beginComposerOperationRequest(
  operation: PendingComposerOperation,
): void {
  inFlightComposerOperations.add(operation.operationId);
  updateMutationOutcomePendingState();
}

function completeComposerOperationRequest(
  operation: PendingComposerOperation,
): void {
  inFlightComposerOperations.delete(operation.operationId);
  updateMutationOutcomePendingState();
}

function pendingQueueItem(operation: PendingComposerOperation): QueueItem {
  return {
    id: `confirming-${operation.operationId}`,
    threadId: operation.threadId,
    turnPayload: {
      input: operation.input,
      clientUserMessageId: operation.operationId,
    },
    status: "confirming",
  };
}

function markComposerOperationUnknown(
  operation: PendingComposerOperation,
  targetClient: GatewayClient,
  outcomeError: GatewayRequestOutcomeUnknownError,
): void {
  pendingComposerOperations.set(operation.operationId, operation);
  updateComposerSubmitAvailability();
  renderPendingComposerOperation(operation);
  schedulePendingComposerReconciliation();
  showToast(
    outcomeError.transportLost
      ? operation.kind === "queue"
        ? "连接中断，排队结果待确认"
        : "连接中断，发送结果待确认"
      : operation.kind === "queue"
        ? "宿主机响应超时，排队结果待确认"
        : "宿主机响应超时，发送结果待确认",
    "error",
  );
  if (outcomeError.transportLost && client === targetClient)
    void recoverConnection(targetClient);
}

function isGatewayMutationOutcomeIndeterminate(
  error: unknown,
): error is GatewayResponseError {
  return (
    error instanceof GatewayResponseError &&
    error.code === IDEMPOTENCY_OUTCOME_INDETERMINATE
  );
}

function markComposerOperationIndeterminate(
  operation: PendingComposerOperation,
): void {
  pendingComposerOperations.set(operation.operationId, operation);
  operation.manualReviewRequired = true;
  operation.manualReviewReason = "host-indeterminate";
  composerReconciliations.delete(operation.operationId);
  updateComposerSubmitAvailability();
  renderPendingComposerOperation(operation);
  stopPendingComposerReconciliationIfIdle();
  renderComposerOutcomeReview();
  showToast(
    operation.kind === "queue"
      ? "宿主机无法证明排队结果；已停止自动重试，请人工核对。"
      : "宿主机无法证明发送结果；已停止自动重试，请人工核对。",
    "error",
  );
}

function renderPendingComposerOperation(
  operation: PendingComposerOperation,
): void {
  if (activeThreadId !== operation.threadId) return;
  if (operation.kind === "queue") {
    queuedItems.set(
      `confirming-${operation.operationId}`,
      pendingQueueItem(operation),
    );
    renderComposerQueue();
    return;
  }
  timelineView.appendLocalUser(operation.input, operation.operationId);
  timelineView.markLocalUserOutcomeUnknown(operation.operationId);
}

function confirmComposerOperation(
  operation: PendingComposerOperation,
  outcome:
    | { kind: "turn"; turnId: string; turnStatus: Turn["status"] }
    | { kind: "queue"; queueId: string },
  queueItem?: QueueItem,
): void {
  pendingComposerOperations.delete(operation.operationId);
  composerReconciliations.delete(operation.operationId);
  composerTurnSnapshotReader.forget(operation.operationId);
  queuedItems.delete(`confirming-${operation.operationId}`);
  if (outcome.kind === "turn" && activeThreadId === operation.threadId) {
    if (
      activeSideSession?.threadId === operation.threadId &&
      !activeSideSession.firstSideTurnId
    ) {
      activeSideSession.firstSideTurnId = outcome.turnId;
    }
    timelineView.bindLocalUserToTurn(outcome.turnId, operation.operationId);
    if (outcome.turnStatus === "inProgress") {
      activeTurnId = outcome.turnId;
      setThreadStatus({ type: "active", activeFlags: [] });
      startThreadSync();
    }
    activeNewestTurnId = outcome.turnId;
  } else if (
    outcome.kind === "queue" &&
    activeThreadId === operation.threadId &&
    queueItem &&
    queueItem.status !== "running"
  ) {
    queuedItems.set(queueItem.id, queueItem);
  }
  stopPendingComposerReconciliationIfIdle();
  renderComposerQueue();
  updateComposerSubmitAvailability();
  showToast(
    operation.kind === "queue" && outcome.kind === "queue"
      ? "已确认消息在宿主机队列中"
      : "已确认消息只发送了一次",
    "success",
  );
}

function failComposerOperation(
  operation: PendingComposerOperation,
  error: unknown,
): void {
  pendingComposerOperations.delete(operation.operationId);
  composerReconciliations.delete(operation.operationId);
  composerTurnSnapshotReader.forget(operation.operationId);
  queuedItems.delete(`confirming-${operation.operationId}`);
  if (operation.kind === "turn" && activeThreadId === operation.threadId)
    timelineView.removeLocalUser(operation.operationId);
  stopPendingComposerReconciliationIfIdle();
  renderComposerQueue();
  updateComposerSubmitAvailability();
  if (activeThreadId === operation.threadId && !messageInput.value) {
    messageInput.value = operation.text;
    autoResize(messageInput);
  }
  if (activeThreadId === operation.threadId) {
    appendTimeline(
      "error",
      operation.kind === "queue" ? "宿主机确认排队失败" : "宿主机确认发送失败",
      errorMessage(error),
    );
  }
}

function reconcilePendingComposerOperations(
  threadId: string,
  turns: Turn[] | undefined,
  turnsAuthoritative: boolean,
  queueSnapshot: QueueItem[] | undefined,
  options: {
    negativeEvidenceAllowed: boolean;
    targetClient: GatewayClient;
  },
): void {
  const { negativeEvidenceAllowed, targetClient } = options;
  for (const operation of pendingComposerOperations.values()) {
    if (operation.threadId !== threadId) continue;
    const outcome = composerOperationOutcome(
      operation.kind,
      operation.operationId,
      turns ?? [],
      queueSnapshot ?? [],
    );
    if (outcome) {
      const queueItem =
        outcome.kind === "queue"
          ? queueSnapshot?.find((item) => item.id === outcome.queueId)
          : undefined;
      confirmComposerOperation(operation, outcome, queueItem);
      continue;
    }
    renderPendingComposerOperation(operation);
    if (operation.manualReviewRequired) {
      renderComposerOutcomeReview();
      continue;
    }
    if (!negativeEvidenceAllowed) continue;
    const turnsCoverOperation = composerTurnSnapshotCoversOperation({
      turns,
      complete: turnsAuthoritative,
      boundaryTurnId: operation.reconciliationBoundaryTurnId,
      negativeEvidenceAllowed,
    });
    const completeSnapshot =
      turnsCoverOperation &&
      (operation.kind === "turn" || queueSnapshot !== undefined);
    if (completeSnapshot) operation.authoritativeChecks += 1;
    const action = composerReconciliationAction({
      operationKind: operation.kind,
      sameDevice: operation.deviceId === targetClient.host.deviceId,
      turnsAvailable: turnsCoverOperation,
      queueAvailable: queueSnapshot !== undefined,
      authoritativeMisses: operation.authoritativeChecks,
      reconciliationAgeMs: Date.now() - operation.reconciliationStartedAt,
    });
    if (action === "retry") {
      void retryPendingComposerOperation(operation, targetClient);
    } else if (action === "fail") {
      failComposerOperation(
        operation,
        new Error("多次权威快照均未发现原操作；已恢复草稿，可以重新发送。"),
      );
    }
  }
  if (pendingComposerOperations.size > 0)
    schedulePendingComposerReconciliation();
}

function manualComposerOperationForActiveThread():
  PendingComposerOperation | undefined {
  return [...pendingComposerOperations.values()].find(
    (operation) =>
      operation.manualReviewRequired &&
      (operation.threadId === activeThreadId ||
        operation.manualReviewReason === "side-unavailable"),
  );
}

function renderComposerOutcomeReview(): void {
  const operation = manualComposerOperationForActiveThread();
  const review = requiredElement("composer-outcome-review");
  review.hidden = !operation;
  if (!operation) return;
  const sideUnavailable = operation.manualReviewReason === "side-unavailable";
  const hostIndeterminate =
    operation.manualReviewReason === "host-indeterminate";
  requiredElement("composer-outcome-review-copy").textContent = sideUnavailable
    ? "Side 所属 app-server 已重启，临时支线无法恢复；原消息仍可能在重启前提交。系统已停止自动核对和重放。请根据主会话或其他运行记录人工核对，只有确认可以承担重复消息风险后，才能放弃待确认记录。"
    : hostIndeterminate
      ? operation.kind === "queue"
        ? "宿主机已锁定这次排队操作，但 app-server 的最终结果无法证明；系统不会自动重放。原消息可能已经进入队列或开始执行，请刷新当前会话核对，只有确认可以承担重复消息风险后，才能放弃待确认记录。"
        : "宿主机已锁定这次发送操作，但 app-server 的最终结果无法证明；系统不会自动重放。原消息可能已经提交，请刷新当前会话核对，只有确认可以承担重复消息风险后，才能放弃待确认记录。"
      : operation.kind === "queue"
        ? "旧版 app-server 的完整历史读取连续失败，系统已停止自动重试排队。原消息可能已经进入队列或开始执行；请刷新当前会话核对，只有确认可以承担重复消息风险后，才能放弃待确认记录。"
        : "旧版 app-server 的完整历史读取连续失败，系统已停止自动重试发送。原消息可能已经提交；请刷新当前会话核对，只有确认可以承担重复消息风险后，才能放弃待确认记录。";
  const inspect = requiredElement<HTMLButtonElement>(
    "inspect-composer-outcome",
  );
  inspect.hidden = sideUnavailable;
  inspect.disabled = sideUnavailable;
}

function markComposerOperationManualReview(
  operation: PendingComposerOperation,
): void {
  if (operation.manualReviewRequired) return;
  operation.manualReviewRequired = true;
  operation.manualReviewReason = "history-unavailable";
  composerReconciliations.delete(operation.operationId);
  renderPendingComposerOperation(operation);
  stopPendingComposerReconciliationIfIdle();
  renderComposerOutcomeReview();
  updateComposerSubmitAvailability();
  if (activeThreadId === operation.threadId) {
    showToast("自动核对已停止，请人工刷新并确认发送结果。", "error");
  }
}

async function inspectManualComposerOutcome(): Promise<void> {
  const operation = manualComposerOperationForActiveThread();
  const targetClient = client;
  if (!operation || !targetClient) return;
  if (operation.manualReviewReason === "side-unavailable") {
    showToast("临时 Side 已随 app-server 重启消失，无法再读取其历史", "error");
    return;
  }
  const inspect = requiredElement<HTMLButtonElement>(
    "inspect-composer-outcome",
  );
  inspect.disabled = true;
  inspect.textContent = "正在刷新…";
  try {
    const detail = await targetClient.request<ThreadReadResponse>(
      "thread/read",
      { threadId: operation.threadId, includeTurns: true },
    );
    let queueSnapshot: QueueItem[] | undefined;
    if (operation.kind === "queue") {
      try {
        queueSnapshot = (
          await targetClient.request<{ items: QueueItem[] }>("queue/list", {})
        ).items;
      } catch {
        // A full turn match can still positively confirm a dispatched item.
      }
    }
    if (client !== targetClient) return;
    reconcilePendingComposerOperations(
      operation.threadId,
      detail.thread.turns,
      true,
      queueSnapshot,
      {
        // Manual inspection also reads history before Queue. It may confirm a
        // match, but absence must never resume automatic mutation replay.
        negativeEvidenceAllowed: false,
        targetClient,
      },
    );
    if (pendingComposerOperations.has(operation.operationId)) {
      showToast(
        operation.kind === "queue" && queueSnapshot === undefined
          ? "会话已刷新，但队列读取失败；仍未完成核对。"
          : "已刷新当前会话；系统未自动重发，也未按文本猜测结果。",
        "error",
      );
    }
  } catch (error) {
    showToast(`刷新当前会话失败：${errorMessage(error)}`, "error");
  } finally {
    inspect.disabled = false;
    inspect.textContent = "刷新并核对当前会话";
  }
}

function abandonManualComposerOutcome(): void {
  const operation = manualComposerOperationForActiveThread();
  if (!operation) return;
  if (
    !window.confirm(
      "原消息可能已经提交。确认已核对当前会话，并放弃这条待确认记录？之后再次发送可能产生重复消息。",
    )
  )
    return;
  pendingComposerOperations.delete(operation.operationId);
  composerReconciliations.delete(operation.operationId);
  composerTurnSnapshotReader.forget(operation.operationId);
  queuedItems.delete(`confirming-${operation.operationId}`);
  if (operation.kind === "turn" && activeThreadId === operation.threadId)
    timelineView.removeLocalUser(operation.operationId);
  stopPendingComposerReconciliationIfIdle();
  renderComposerQueue();
  renderComposerOutcomeReview();
  updateComposerSubmitAvailability();
  showToast("已放弃待确认记录；系统没有自动恢复或重新发送原消息。", "success");
}

async function retryPendingComposerOperation(
  operation: PendingComposerOperation,
  targetClient: GatewayClient,
): Promise<void> {
  if (operation.manualReviewRequired) return;
  if (composerReconciliations.has(operation.operationId)) return;
  composerReconciliations.add(operation.operationId);
  try {
    if (operation.kind === "queue") {
      const item = await targetClient.request<QueueItem>(
        "queue/add",
        {
          threadId: operation.threadId,
          input: operation.input,
          clientUserMessageId: operation.operationId,
        },
        { idempotencyKey: operation.idempotencyKey },
      );
      confirmComposerOperation(
        operation,
        { kind: "queue", queueId: item.id },
        item,
      );
      return;
    }
    const response = await targetClient.request<TurnStartResponse>(
      "turn/start",
      {
        threadId: operation.threadId,
        input: operation.input,
        clientUserMessageId: operation.operationId,
      },
      { idempotencyKey: operation.idempotencyKey },
    );
    confirmComposerOperation(operation, {
      kind: "turn",
      turnId: response.turn.id,
      turnStatus: response.turn.status,
    });
  } catch (error) {
    composerReconciliations.delete(operation.operationId);
    if (operation.manualReviewRequired) {
      renderComposerOutcomeReview();
      return;
    }
    if (isGatewayMutationOutcomeIndeterminate(error)) {
      markComposerOperationIndeterminate(operation);
      return;
    }
    const transportLost = isGatewayRequestOutcomeUnknown(error)
      ? error.transportLost
      : isRetryableConnectionFailure(error);
    if (
      isGatewayRequestOutcomeUnknown(error) ||
      isRetryableConnectionFailure(error)
    ) {
      renderPendingComposerOperation(operation);
      schedulePendingComposerReconciliation();
      if (transportLost && client === targetClient)
        void recoverConnection(targetClient);
      return;
    }
    failComposerOperation(operation, error);
  }
}

function hasAutomaticComposerReconciliation(): boolean {
  return [...pendingComposerOperations.values()].some(
    (operation) => !operation.manualReviewRequired,
  );
}

function schedulePendingComposerReconciliation(
  delayMs = COMPOSER_RECONCILIATION_INTERVAL_MS,
): void {
  if (
    !hasAutomaticComposerReconciliation() ||
    pendingComposerReconciliationTimer !== undefined
  )
    return;
  pendingComposerReconciliationTimer = window.setTimeout(() => {
    pendingComposerReconciliationTimer = undefined;
    void reconcileAllPendingComposerOperations();
  }, delayMs);
}

function stopPendingComposerReconciliationIfIdle(): void {
  if (
    hasAutomaticComposerReconciliation() ||
    pendingComposerReconciliationTimer === undefined
  )
    return;
  window.clearTimeout(pendingComposerReconciliationTimer);
  pendingComposerReconciliationTimer = undefined;
}

async function reconcileAllPendingComposerOperations(): Promise<void> {
  const targetClient = client;
  if (!targetClient || document.hidden) {
    schedulePendingComposerReconciliation(3_000);
    return;
  }
  const operations = [...pendingComposerOperations.values()].filter(
    (operation) => !operation.manualReviewRequired,
  );
  if (operations.length === 0) {
    stopPendingComposerReconciliationIfIdle();
    return;
  }
  let queueSnapshot: QueueItem[] | undefined;
  if (operations.some((operation) => operation.kind === "queue")) {
    try {
      queueSnapshot = (
        await targetClient.request<{ items: QueueItem[] }>("queue/list", {})
      ).items;
    } catch {
      // A later pass retries this read before any mutation is replayed.
    }
  }
  const threadIds = new Set(operations.map((operation) => operation.threadId));
  for (const threadId of threadIds) {
    const threadOperations = operations.filter(
      (operation) => operation.threadId === threadId,
    );
    let turns: Turn[] | undefined;
    let turnsAuthoritative = false;
    let turnsNegativeEvidenceAllowed = false;
    try {
      const snapshot = await composerTurnSnapshotReader.read(
        targetClient,
        threadId,
        threadOperations.map((operation) => operation.operationId),
        {
          legacyNegativeEvidenceAllowed: threadOperations.every(
            (operation) =>
              operation.kind === "turn" || queueSnapshot !== undefined,
          ),
        },
      );
      turns = snapshot.turns;
      turnsAuthoritative = snapshot.authoritative;
      turnsNegativeEvidenceAllowed = snapshot.negativeEvidenceAllowed;
      if (snapshot.manualReviewRequired) {
        for (const operation of threadOperations) {
          markComposerOperationManualReview(operation);
        }
      }
    } catch {
      // Keep polling independently from the realtime thread subscription.
    }
    if (client !== targetClient) break;
    reconcilePendingComposerOperations(
      threadId,
      turns,
      turnsAuthoritative,
      queueSnapshot,
      {
        // Only the reader can distinguish a fresh page/full read from stale
        // cached turns returned during legacy backoff or read failure.
        negativeEvidenceAllowed: turnsNegativeEvidenceAllowed,
        targetClient,
      },
    );
  }
  if (hasAutomaticComposerReconciliation())
    schedulePendingComposerReconciliation();
}

function startThreadSync(): void {
  if (threadSyncTimer !== undefined) return;
  threadSyncTimer = window.setInterval(() => void syncActiveThread(), 750);
}

function stopThreadSync(): void {
  if (threadSyncTimer === undefined) return;
  window.clearInterval(threadSyncTimer);
  threadSyncTimer = undefined;
}

async function loadOlderHistory(): Promise<void> {
  const targetClient = client;
  const threadId = activeThreadId;
  const cursor = activeHistoryNextCursor;
  const sequence = openThreadSequence;
  if (
    !targetClient ||
    !threadId ||
    activeHistoryMode !== "paged" ||
    !cursor ||
    olderHistoryLoading
  ) {
    timelineView.setOlderHistoryLoading(false);
    return;
  }
  olderHistoryLoading = true;
  timelineView.setOlderHistoryLoading(true);
  try {
    const page = await targetClient.request<TurnsPage>("thread/turns/list", {
      threadId,
      cursor,
      limit: HISTORY_PAGE_SIZE,
      sortDirection: "desc",
      itemsView: "full",
    });
    if (
      client !== targetClient ||
      sequence !== openThreadSequence ||
      activeThreadId !== threadId
    )
      return;
    const nextCursor = page.nextCursor ?? undefined;
    timelineView.prependTurns(
      newestPageInReadingOrder(page),
      Boolean(nextCursor),
    );
    // Commit pagination only after the DOM update succeeds. A rendering error
    // must leave the same page retryable instead of skipping it permanently.
    activeHistoryNextCursor = nextCursor;
    activeHistoryPaginationExhausted = nextCursor === undefined;
    activeHistoryExhaustedNewestTurnId = activeHistoryPaginationExhausted
      ? activeNewestTurnId
      : undefined;
  } catch (error) {
    if (
      client === targetClient &&
      sequence === openThreadSequence &&
      activeThreadId === threadId
    ) {
      timelineView.setOlderHistoryLoading(false);
      showToast(`加载历史失败：${errorMessage(error)}`, "error");
    }
  } finally {
    if (
      client === targetClient &&
      sequence === openThreadSequence &&
      activeThreadId === threadId
    )
      olderHistoryLoading = false;
  }
}

async function syncActiveThread(): Promise<void> {
  if (
    threadSyncInFlight ||
    threadHistoryInitializationSequence === openThreadSequence ||
    !client ||
    !activeThreadId ||
    (activeHistoryMode !== "initializing" &&
      (activeThreadStatus?.type !== "active" ||
        Date.now() - lastRealtimeEventAt < 1_250))
  )
    return;
  const currentClient = client;
  const threadId = activeThreadId;
  const sequence = openThreadSequence;
  threadSyncInFlight = true;
  try {
    const syncStrategy = threadHistorySyncStrategy(activeHistoryMode);
    if (syncStrategy === "skip") return;
    const requestedHistoryMode = activeHistoryMode;
    if (syncStrategy === "initialize") {
      const syncingSide =
        activeSideSession?.threadId === threadId
          ? activeSideSession
          : undefined;
      const history = syncingSide
        ? await readEphemeralThreadHistory(
            currentClient,
            threadId,
            syncingSide.fallbackDetail,
          )
        : await resumeThreadHistory(currentClient, threadId);
      if (
        client !== currentClient ||
        sequence !== openThreadSequence ||
        activeThreadId !== threadId ||
        activeHistoryMode !== requestedHistoryMode
      )
        return;
      const detail = history.detail;
      const visibleTurns = visibleTurnsForThread(threadId, detail.thread.turns);
      const isSyncingSide = Boolean(syncingSide);
      activeTurnId = [...visibleTurns]
        .reverse()
        .find((turn) => turn.status === "inProgress")?.id;
      activeNewestTurnId = visibleTurns.at(-1)?.id;
      activeHistoryNextCursor = isSyncingSide ? undefined : history.nextCursor;
      activeHistoryPaginationExhausted = isSyncingSide
        ? true
        : history.paged && history.nextCursor === undefined;
      activeHistoryExhaustedNewestTurnId = activeHistoryPaginationExhausted
        ? activeNewestTurnId
        : undefined;
      activeHistoryMode = history.paged ? "paged" : "legacy";
      timelineView.renderSnapshot(
        {
          ...detail,
          thread: { ...detail.thread, turns: visibleTurns },
        },
        { hasOlderHistory: Boolean(activeHistoryNextCursor) },
      );
      activeThreadSettings = {
        model: detail.model,
        effort: detail.reasoningEffort,
        approvalPolicy: detail.approvalPolicy,
        sandboxPolicy: detail.sandbox,
      };
      if (syncingSide) syncingSide.fallbackDetail = detail;
      setTuiHandoffVisible(!isSyncingSide);
      renderComposerSessionMeta();
      setThreadStatus(detail.thread.status);
      messageInput.disabled = false;
      updateComposerSubmitAvailability();
      const queueSnapshot = isSyncingSide
        ? undefined
        : await renderQueuedMessages(threadId, sequence);
      if (
        client !== currentClient ||
        sequence !== openThreadSequence ||
        activeThreadId !== threadId
      )
        return;
      reconcilePendingComposerOperations(
        threadId,
        visibleTurns,
        !history.paged || history.nextCursor === undefined,
        queueSnapshot,
        {
          negativeEvidenceAllowed: false,
          targetClient: currentClient,
        },
      );
      lastRealtimeEventAt = Date.now();
      return;
    }
    const syncingSide =
      activeSideSession?.threadId === threadId ? activeSideSession : undefined;
    const repair = syncingSide
      ? await readEphemeralThreadRepairSnapshot(
          currentClient,
          threadId,
          syncingSide.fallbackDetail,
        )
      : await readThreadRepairSnapshot(currentClient, threadId, syncStrategy);
    if (
      client !== currentClient ||
      sequence !== openThreadSequence ||
      activeThreadId !== threadId ||
      activeHistoryMode !== requestedHistoryMode
    )
      return;
    const displayTurns = visibleTurnsForThread(threadId, repair.displayTurns);
    const reconciliationTurns = visibleTurnsForThread(
      threadId,
      repair.reconciliationTurns,
    );
    activeHistoryMode = repair.mode;
    if (repair.mode === "paged" && !syncingSide) {
      activeHistoryNextCursor = retainRepairHistoryCursor(
        activeHistoryNextCursor,
        repair.nextCursor,
        activeHistoryPaginationExhausted,
        activeHistoryExhaustedNewestTurnId !== undefined &&
          repair.displayTurns.some(
            (turn) => turn.id === activeHistoryExhaustedNewestTurnId,
          ),
      );
      if (activeHistoryNextCursor) {
        activeHistoryPaginationExhausted = false;
        activeHistoryExhaustedNewestTurnId = undefined;
      }
      timelineView.setHasOlderHistory(Boolean(activeHistoryNextCursor));
      timelineView.mergeRecentTurns(displayTurns);
    } else {
      activeHistoryNextCursor = undefined;
      activeHistoryPaginationExhausted = true;
      activeHistoryExhaustedNewestTurnId = undefined;
      timelineView.reconcileSnapshot(
        {
          ...repair.detail,
          thread: {
            ...repair.detail.thread,
            turns: displayTurns,
          },
        },
        { maxTurns: HISTORY_PAGE_SIZE },
      );
    }
    activeTurnId = [...displayTurns]
      .reverse()
      .find((turn) => turn.status === "inProgress")?.id;
    activeNewestTurnId = displayTurns.at(-1)?.id ?? activeNewestTurnId;
    setThreadStatus(repair.detail.thread.status);
    reconcilePendingComposerOperations(
      threadId,
      reconciliationTurns,
      repair.turnsAuthoritative,
      undefined,
      {
        // No Queue snapshot is present, so queue operations cannot become a
        // negative result; direct turns may use this fresh snapshot.
        negativeEvidenceAllowed: true,
        targetClient: currentClient,
      },
    );
    lastRealtimeEventAt = Date.now();
    if (repair.detail.thread.status.type !== "active") stopThreadSync();
  } catch (error) {
    // Live notifications remain primary. Retry snapshot synchronization on a
    // later tick without surfacing transient read failures as timeline noise.
  } finally {
    threadSyncInFlight = false;
  }
}

async function renderQueuedMessages(
  threadId: string,
  sequence: number,
): Promise<QueueItem[] | undefined> {
  if (!client) return undefined;
  try {
    const result = await client.request<{ items: QueueItem[] }>(
      "queue/list",
      {},
    );
    if (sequence !== openThreadSequence || activeThreadId !== threadId)
      return undefined;
    const threadItems = result.items.filter(
      (item) => item.threadId === threadId,
    );
    queuedItems.clear();
    for (const item of threadItems) {
      const text = queuedMessageText(item.turnPayload);
      if (text) queuedItems.set(item.id, item);
    }
    renderComposerQueue();
    return threadItems;
  } catch (error) {
    showToast(`无法读取消息队列：${errorMessage(error)}`, "error");
    return undefined;
  }
}

function renderComposerQueue(): void {
  const items = [...queuedItems.values()];
  const steerableItemIds = steerableQueueItemIds(items);
  composerQueue.hidden =
    items.length === 0 || !activeThreadId || Boolean(activeSideSession);
  composerQueueCount.textContent = `${String(items.length)} 条`;
  composerQueueNote.textContent = items.some(
    (item) => item.status === "confirming",
  )
    ? "连接中断，正在向宿主机确认；不会重复排队"
    : items.some((item) => item.status === "indeterminate")
      ? "投递结果无法确认；不会自动重发，请核对后再放弃记录"
      : items.some(
            (item) => item.status === "delivering" || item.status === "running",
          )
        ? "正在提交给 Codex；此时不能移除或转为 Steer"
        : items.some((item) => item.status === "paused")
          ? "消息尚未提交，宿主机队列已安全暂停"
          : activeThreadStatus?.type === "active"
            ? "当前任务结束后依次发送"
            : "正在等待发送";
  composerQueueList.replaceChildren();
  for (const item of items) {
    const row = document.createElement("article");
    row.className = `composer-queue-item ${item.status}`;
    row.dataset.queueId = item.id;

    const copy = document.createElement("div");
    const status = document.createElement("span");
    status.className = "composer-queue-status";
    status.textContent =
      item.status === "confirming"
        ? "结果待确认"
        : item.status === "indeterminate"
          ? "结果待核对"
          : item.status === "delivering" || item.status === "running"
            ? "正在提交"
            : item.status === "paused"
              ? "已暂停"
              : "排队中";
    const text = document.createElement("p");
    text.textContent = queuedMessageText(item.turnPayload);
    text.title = text.textContent;
    copy.append(status, text);

    const actions = document.createElement("div");
    actions.className = "composer-queue-actions";
    if (
      item.status === "confirming" ||
      item.status === "delivering" ||
      item.status === "running"
    ) {
      row.append(copy, actions);
      composerQueueList.append(row);
      continue;
    }
    if (item.status === "indeterminate") {
      const acknowledge = document.createElement("button");
      acknowledge.type = "button";
      acknowledge.className = "ghost danger queue-tray-acknowledge";
      acknowledge.textContent = "核对后放弃记录";
      acknowledge.title = "仅在核对会话后放弃；再次发送可能产生重复消息";
      acknowledge.addEventListener(
        "click",
        () => void acknowledgeIndeterminateQueuedMessage(item.id),
      );
      actions.append(acknowledge);
      row.append(copy, actions);
      composerQueueList.append(row);
      continue;
    }
    const canSteer =
      steerableItemIds.has(item.id) &&
      activeThreadStatus?.type === "active" &&
      Boolean(activeTurnId);
    if (canSteer) {
      const steer = document.createElement("button");
      steer.type = "button";
      steer.className = "ghost queue-tray-steer";
      steer.textContent = "转为 Steer";
      steer.title = "立即补充到当前正在运行的任务";
      steer.addEventListener("click", () => void steerQueuedMessage(item.id));
      actions.append(steer);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button queue-tray-remove";
    remove.textContent = "×";
    remove.title = "移除这条待发送消息";
    remove.setAttribute("aria-label", "移除待发送消息");
    remove.addEventListener("click", () => void removeQueuedMessage(item.id));
    actions.append(remove);
    row.append(copy, actions);
    composerQueueList.append(row);
  }
  renderComposerOutcomeReview();
  updateApprovalTray();
}

async function interruptActiveTurn(): Promise<void> {
  if (!client || !activeThreadId || !activeTurnId) return;
  const button = requiredElement<HTMLButtonElement>("interrupt-turn");
  button.disabled = true;
  try {
    await client.request("turn/interrupt", {
      threadId: activeThreadId,
      turnId: activeTurnId,
    });
    showToast("正在停止当前任务", "success");
  } catch (error) {
    showToast(`停止失败：${errorMessage(error)}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function steerQueuedMessage(queueId: string): Promise<void> {
  if (!client || !activeThreadId || !activeTurnId) {
    showToast("当前没有可接收 Steer 的运行中任务", "error");
    return;
  }
  const card = composerQueueList.querySelector<HTMLElement>(
    `[data-queue-id="${CSS.escape(queueId)}"]`,
  );
  const button = card?.querySelector<HTMLButtonElement>(".queue-tray-steer");
  if (button) button.disabled = true;
  try {
    await client.request("queue/steer", {
      id: queueId,
      expectedTurnId: activeTurnId,
    });
    queuedItems.delete(queueId);
    renderComposerQueue();
    showToast("排队消息已转为 Steer", "success");
  } catch (error) {
    if (button) button.disabled = false;
    showToast(`转为 Steer 失败：${errorMessage(error)}`, "error");
  }
}

async function removeQueuedMessage(queueId: string): Promise<void> {
  if (!client) return;
  const row = composerQueueList.querySelector<HTMLElement>(
    `[data-queue-id="${CSS.escape(queueId)}"]`,
  );
  const button = row?.querySelector<HTMLButtonElement>(".queue-tray-remove");
  if (button) button.disabled = true;
  try {
    const result = await client.request<{ removed: boolean }>("queue/remove", {
      id: queueId,
    });
    if (!result.removed) throw new Error("消息已经开始发送或已被移除");
    queuedItems.delete(queueId);
    renderComposerQueue();
    showToast("已移除待发送消息", "success");
  } catch (error) {
    if (button) button.disabled = false;
    showToast(`移除失败：${errorMessage(error)}`, "error");
  }
}

async function acknowledgeIndeterminateQueuedMessage(
  queueId: string,
): Promise<void> {
  if (!client) return;
  if (
    !window.confirm(
      "原消息可能已经提交。请先核对当前会话；放弃记录不会撤回已经发生的发送，之后再次发送可能产生重复消息。确认放弃这条记录？",
    )
  ) {
    return;
  }
  const row = composerQueueList.querySelector<HTMLElement>(
    `[data-queue-id="${CSS.escape(queueId)}"]`,
  );
  const button = row?.querySelector<HTMLButtonElement>(
    ".queue-tray-acknowledge",
  );
  if (button) button.disabled = true;
  try {
    const result = await client.request<{ removed: boolean }>("queue/remove", {
      id: queueId,
      acknowledgeIndeterminate: true,
    });
    if (!result.removed) throw new Error("记录已经由其他客户端处理");
    queuedItems.delete(queueId);
    renderComposerQueue();
    showToast("已放弃待核对记录；系统没有自动重新发送原消息", "success");
  } catch (error) {
    if (button) button.disabled = false;
    showToast(`放弃记录失败：${errorMessage(error)}`, "error");
  }
}

function renderEvent(event: EventEnvelope): void {
  if (event.type === CODEX_INSTALL_PROGRESS_EVENT) {
    renderCodexInstallProgress(event.payload);
    return;
  }
  const loginAction = codexLoginEventAction({
    eventType: event.type,
    payload: event.payload,
    pendingLoginId: pendingCodexLoginId,
  });
  if (loginAction.type === "refresh" && pendingCodexLoginId) {
    void finalizeCodexLogin(pendingCodexLoginId);
    return;
  }
  if (loginAction.type === "failed") {
    failCodexLogin(loginAction.message);
    return;
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  const threadId = extractThreadId(payload);
  if (
    !shouldRenderInThreadTimeline({
      activeThreadId,
      eventThreadId: threadId,
      eventType: event.type,
    })
  )
    return;
  if (threadId === activeThreadId) lastRealtimeEventAt = Date.now();

  if (event.type === "codex/serverRequest") {
    if (typeof payload.requestId === "string")
      pendingRequestIds.add(payload.requestId);
    updatePendingApprovalState();
    renderApproval(event.payload);
    return;
  }
  if (event.type === "codex/serverRequest/resolved") {
    const payload = isRecord(event.payload) ? event.payload : {};
    const requestId = String(payload.requestId ?? payload.id ?? "");
    pendingRequestIds.delete(requestId);
    const resolution = approvalSubmissions.resolve(requestId);
    const card = Array.from(
      composerApprovalList.querySelectorAll<HTMLElement>("[data-request-id]"),
    ).find((candidate) => candidate.dataset.requestId === requestId);
    if (card && !card.classList.contains("answered"))
      resolveApprovalCard(
        card,
        requestId,
        resolution.wasSubmitting
          ? (card.dataset.submissionResult ?? "已处理")
          : "已由其他客户端处理",
      );
    updatePendingApprovalState();
    return;
  }
  if (
    (event.type === "queue/started" || event.type === "queue/steered") &&
    typeof payload.itemId === "string"
  ) {
    queuedItems.delete(payload.itemId);
    renderComposerQueue();
    return;
  }
  if (event.type === "queue/paused" && typeof payload.itemId === "string") {
    const item = queuedItems.get(payload.itemId);
    if (item) {
      item.status = "paused";
      renderComposerQueue();
    } else if (activeThreadId) {
      void renderQueuedMessages(activeThreadId, openThreadSequence);
    }
    return;
  }
  if (
    (event.type === "queue/delivering" ||
      event.type === "queue/indeterminate") &&
    typeof payload.itemId === "string"
  ) {
    const item = queuedItems.get(payload.itemId);
    if (item) {
      item.status =
        event.type === "queue/delivering" ? "delivering" : "indeterminate";
      renderComposerQueue();
    } else if (activeThreadId) {
      void renderQueuedMessages(activeThreadId, openThreadSequence);
    }
    return;
  }

  if (event.type === "codex/thread/status/changed") {
    const current = requiredElement("thread-state");
    const detailedActivity = ["thinking", "replying", "tool"].some((name) =>
      current.classList.contains(name),
    );
    if (statusKey(payload.status) !== "active" || !detailedActivity)
      setThreadStatus(payload.status);
    if (isThreadStatus(payload.status) && payload.status.type === "active")
      startThreadSync();
    void refresh();
    return;
  }
  if (event.type === "codex/thread/name/updated") {
    if (!activeSideSession && typeof payload.name === "string")
      requiredElement("thread-title").textContent = payload.name;
    void refresh();
    return;
  }
  if (event.type === "codex/thread/settings/updated") {
    applyThreadSettingsNotification(payload);
    return;
  }
  if (event.type === "codex/thread/started") {
    void refresh();
    return;
  }
  if (
    event.type === "codex/thread/tokenUsage/updated" &&
    isThreadTokenUsage(payload.tokenUsage)
  ) {
    activeThreadTokenUsage = payload.tokenUsage;
    renderComposerSessionMeta();
    return;
  }
  const eventSideSession =
    activeSideSession?.threadId === threadId ? activeSideSession : undefined;
  if (
    event.type === "codex/turn/completed" &&
    eventSideSession &&
    isTurn(payload.turn)
  ) {
    eventSideSession.fallbackDetail = mergeEphemeralCompletedTurn(
      eventSideSession.fallbackDetail,
      payload.turn,
    );
  }
  if (
    event.type === "codex/model/rerouted" &&
    activeThreadSettings &&
    typeof payload.toModel === "string"
  ) {
    activeThreadSettings.model = payload.toModel;
    renderComposerSessionMeta();
    return;
  }
  updateThreadActivity(event, payload);
  if (timelineView.handleEvent(event)) {
    if (event.type === "codex/turn/completed") void refresh();
    return;
  }

  // Preserve forward compatibility: an unknown Codex event is visible as a
  // generic entry instead of crashing the UI or silently disappearing.
  appendTimeline(
    "event",
    event.type.replace("codex/", ""),
    genericEventSummary(event.payload),
  );
}

function renderApproval(payload: unknown): void {
  if (!isRecord(payload) || typeof payload.requestId !== "string") return;
  if (
    composerApprovalList.querySelector(
      `[data-request-id="${CSS.escape(payload.requestId)}"]`,
    )
  )
    return;
  if (payload.method === "item/tool/requestUserInput") {
    renderUserInput(payload);
    return;
  }
  const presentation = approvalPresentation(payload.method, payload.params);
  const { card, body } = createApprovalTrayCard(
    payload.requestId,
    presentation.title,
    presentation.summary,
  );
  const detail = document.createElement("div");
  detail.className = "approval-summary";
  const summary = document.createElement("p");
  summary.textContent = presentation.summary;
  detail.append(summary);
  if (presentation.code) {
    const code = document.createElement("code");
    code.textContent = presentation.code;
    detail.append(code);
  }
  for (const line of presentation.meta) {
    const meta = document.createElement("small");
    meta.textContent = line;
    detail.append(meta);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const deny = button("拒绝", "danger");
  const canApprove = isApprovalMethod(payload.method);
  if (canApprove) {
    const approve = button("允许", "primary");
    approve.addEventListener(
      "click",
      () => void answerApproval(payload, true, card),
    );
    actions.append(approve);
  }
  deny.addEventListener(
    "click",
    () => void answerApproval(payload, false, card),
  );
  actions.append(deny);
  body.append(detail, actions);
  composerApprovalList.append(card);
  if (!expandedApprovalId) expandedApprovalId = payload.requestId;
  updateApprovalTray();
}

async function answerApproval(
  payload: Record<string, unknown>,
  accepted: boolean,
  card: HTMLElement,
): Promise<void> {
  const currentClient = client;
  if (!currentClient) return;
  const requestId = String(payload.requestId);
  if (!approvalSubmissions.begin(requestId)) return;
  const resultText = accepted ? "已允许" : "已拒绝";
  setApprovalSubmitting(
    card,
    accepted ? "正在提交允许，请勿重复点击…" : "正在提交拒绝，请勿重复点击…",
    resultText,
  );
  try {
    if (!accepted && payload.method === "item/permissions/requestApproval") {
      await currentClient.request("codex/server-request/respond", {
        requestId,
        error: { code: -32_000, message: "Declined by user" },
      });
    } else {
      await currentClient.request("codex/server-request/respond", {
        requestId,
        result:
          payload.method === "item/permissions/requestApproval"
            ? permissionGrant(payload.params)
            : payload.method === "mcpServer/elicitation/request"
              ? mcpElicitationResponse(accepted)
              : { decision: accepted ? "accept" : "decline" },
      });
    }
    if (!approvalSubmissions.complete(requestId) || !card.isConnected) return;
    resolveApprovalCard(card, requestId, resultText);
  } catch (error) {
    const disposition = approvalSubmissions.fail(requestId, error);
    if (disposition === "ignored" || !card.isConnected) return;
    if (disposition === "already-handled") {
      resolveApprovalCard(card, requestId, "已由其他客户端处理");
      return;
    }
    setApprovalSubmissionFailed(card, `提交失败：${errorMessage(error)}`);
  }
}

function renderUserInput(payload: Record<string, unknown>): void {
  if (
    !client ||
    typeof payload.requestId !== "string" ||
    !isRecord(payload.params)
  )
    return;
  const questions = Array.isArray(payload.params.questions)
    ? payload.params.questions.filter(isRecord)
    : [];
  const firstQuestion = questions[0];
  const summary = firstQuestion
    ? String(firstQuestion.question ?? firstQuestion.header ?? "需要补充信息")
    : "Codex 需要你补充信息后才能继续。";
  const { card, body } = createApprovalTrayCard(
    payload.requestId,
    "Codex 需要你的回答",
    summary,
  );
  const form = document.createElement("div");
  form.className = "input-questions";
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const question of questions) {
    const id = String(question.id ?? "");
    if (!id) continue;
    const label = document.createElement("label");
    label.textContent = String(question.question ?? question.header ?? id);
    const options = Array.isArray(question.options)
      ? question.options.filter(isRecord)
      : [];
    let control: HTMLInputElement | HTMLSelectElement;
    if (options.length > 0) {
      const select = document.createElement("select");
      for (const item of options) {
        select.append(
          option(String(item.label ?? ""), String(item.label ?? "")),
        );
      }
      control = select;
    } else {
      const input = document.createElement("input");
      input.type = question.isSecret === true ? "password" : "text";
      control = input;
    }
    controls.set(id, control);
    label.append(control);
    form.append(label);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const submit = button("提交回答", "primary");
  submit.addEventListener("click", async () => {
    const currentClient = client;
    if (!currentClient) return;
    const requestId = String(payload.requestId);
    if (!approvalSubmissions.begin(requestId)) return;
    const answers: Record<string, { answers: string[] }> = {};
    for (const [id, control] of controls)
      answers[id] = { answers: [control.value] };
    setApprovalSubmitting(card, "正在提交回答，请勿重复点击…", "已提交回答");
    try {
      await currentClient.request("codex/server-request/respond", {
        requestId,
        result: { answers },
      });
      if (!approvalSubmissions.complete(requestId) || !card.isConnected) return;
      resolveApprovalCard(card, requestId, "已提交回答");
    } catch (error) {
      const disposition = approvalSubmissions.fail(requestId, error);
      if (disposition === "ignored" || !card.isConnected) return;
      if (disposition === "already-handled") {
        resolveApprovalCard(card, requestId, "已由其他客户端处理");
        return;
      }
      setApprovalSubmissionFailed(card, `提交回答失败：${errorMessage(error)}`);
    }
  });
  actions.append(submit);
  body.append(form, actions);
  composerApprovalList.append(card);
  if (!expandedApprovalId) expandedApprovalId = payload.requestId;
  updateApprovalTray();
}

function createApprovalTrayCard(
  requestId: string,
  titleText: string,
  summaryText: string,
): { card: HTMLElement; body: HTMLElement } {
  const card = document.createElement("article");
  card.className = "approval-tray-item";
  card.dataset.requestId = requestId;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "approval-tray-toggle";
  toggle.setAttribute("aria-expanded", "false");
  const order = document.createElement("span");
  order.className = "approval-tray-order";
  const copy = document.createElement("span");
  copy.className = "approval-tray-copy";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const summary = document.createElement("small");
  summary.textContent = summaryText;
  copy.append(title, summary);
  const chevron = document.createElement("span");
  chevron.className = "approval-tray-chevron";
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(order, copy, chevron);
  toggle.addEventListener("click", () => {
    if (card.classList.contains("answered")) return;
    expandedApprovalId = requestId;
    updateApprovalTray();
  });

  const body = document.createElement("div");
  body.className = "approval-tray-body";
  card.append(toggle, body);
  return { card, body };
}

function updateApprovalTray(): void {
  const cards = Array.from(
    composerApprovalList.querySelectorAll<HTMLElement>(".approval-tray-item"),
  );
  const pendingCards = cards.filter(
    (card) => !card.classList.contains("answered"),
  );
  if (
    !expandedApprovalId ||
    !cards.some((card) => card.dataset.requestId === expandedApprovalId)
  ) {
    expandedApprovalId = pendingCards[0]?.dataset.requestId;
  }

  composerApprovals.hidden = cards.length === 0;
  composerApprovalCount.textContent = `${pendingCards.length} 项`;
  const expandedCard = cards.find(
    (card) => card.dataset.requestId === expandedApprovalId,
  );
  const expandedIndex = pendingCards.findIndex(
    (card) => card.dataset.requestId === expandedApprovalId,
  );
  composerApprovalNote.textContent = expandedCard?.classList.contains(
    "answered",
  )
    ? pendingCards.length > 0
      ? "操作已处理，正在进入下一项"
      : "操作已处理"
    : pendingCards.length > 1
      ? `逐项处理 · 当前第 ${Math.max(0, expandedIndex) + 1}/${pendingCards.length} 项`
      : pendingCards.length === 1
        ? "当前任务正在等待你的操作"
        : "操作已处理";

  let pendingIndex = 0;
  for (const card of cards) {
    const answered = card.classList.contains("answered");
    if (!answered) pendingIndex += 1;
    const expanded = card.dataset.requestId === expandedApprovalId;
    card.classList.toggle("collapsed", !expanded);
    const toggle = card.querySelector<HTMLButtonElement>(
      ".approval-tray-toggle",
    );
    toggle?.setAttribute("aria-expanded", String(expanded));
    const order = card.querySelector<HTMLElement>(".approval-tray-order");
    if (order) order.textContent = answered ? "✓" : String(pendingIndex);
  }

  const composer = composerApprovals.parentElement;
  const hasPendingApproval = pendingCards.length > 0;
  composer?.classList.toggle("approval-pending", hasPendingApproval);
  if (!hasPendingApproval) composerQueue.classList.remove("force-open");
  composerQueueHeader.setAttribute(
    "aria-expanded",
    String(
      !hasPendingApproval || composerQueue.classList.contains("force-open"),
    ),
  );
}

function resolveApprovalCard(
  card: HTMLElement,
  requestId: string,
  text: string,
): void {
  markAnswered(card, text);
  pendingRequestIds.delete(requestId);
  updatePendingApprovalState();
  updateApprovalTray();
  if (card.dataset.resolutionScheduled === "true") return;
  card.dataset.resolutionScheduled = "true";
  window.setTimeout(() => {
    if (!card.isConnected) return;
    card.remove();
    if (expandedApprovalId === requestId) expandedApprovalId = undefined;
    updateApprovalTray();
  }, 900);
}

function clearApprovalTray(preserveAnswered = false): void {
  expandedApprovalId = undefined;
  if (preserveAnswered) {
    for (const card of composerApprovalList.querySelectorAll(
      ".approval-tray-item:not(.answered)",
    ))
      card.remove();
  } else {
    composerApprovalList.replaceChildren();
  }
  if (composerApprovalList.childElementCount > 0) {
    updateApprovalTray();
    return;
  }
  composerApprovals.hidden = true;
  composerApprovals.parentElement?.classList.remove("approval-pending");
  composerQueue.classList.remove("force-open");
  composerQueueHeader.setAttribute("aria-expanded", "true");
}

function toggleComposerQueueDuringApproval(): void {
  if (
    composerQueue.hidden ||
    !composerApprovals.parentElement?.classList.contains("approval-pending")
  )
    return;
  const expanded = composerQueue.classList.toggle("force-open");
  composerQueueHeader.setAttribute("aria-expanded", String(expanded));
}

function isApprovalMethod(method: unknown): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "applyPatchApproval" ||
    method === "execCommandApproval"
  );
}

function permissionGrant(params: unknown): Record<string, unknown> {
  const source =
    isRecord(params) && isRecord(params.permissions) ? params.permissions : {};
  const permissions: Record<string, unknown> = {};
  if (source.network !== null && source.network !== undefined)
    permissions.network = source.network;
  if (source.fileSystem !== null && source.fileSystem !== undefined)
    permissions.fileSystem = source.fileSystem;
  return { permissions, scope: "turn" };
}

function markAnswered(card: HTMLElement, text: string): void {
  card.classList.remove("submitting", "submission-error");
  card.classList.add("answered");
  card.removeAttribute("aria-busy");
  const state = approvalSubmissionState(text, "complete");
  card.querySelector(".actions")?.replaceChildren(state);
  for (const control of card.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  >("input, select, button"))
    control.disabled = true;
  delete card.dataset.submissionResult;
}

function setApprovalSubmitting(
  card: HTMLElement,
  text: string,
  resultText: string,
): void {
  card.classList.remove("submission-error");
  card.classList.add("submitting");
  card.setAttribute("aria-busy", "true");
  card.dataset.submissionResult = resultText;
  for (const control of card.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  >("input, select, button"))
    control.disabled = true;
  const actions = card.querySelector(".actions");
  actions?.querySelector(".approval-submit-state")?.remove();
  actions?.append(approvalSubmissionState(text, "pending"));
}

function setApprovalSubmissionFailed(card: HTMLElement, text: string): void {
  card.classList.remove("submitting");
  card.classList.add("submission-error");
  card.removeAttribute("aria-busy");
  for (const control of card.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLButtonElement
  >("input, select, button"))
    control.disabled = false;
  const actions = card.querySelector(".actions");
  actions?.querySelector(".approval-submit-state")?.remove();
  actions?.append(approvalSubmissionState(`${text}，请重试。`, "failure"));
}

function approvalSubmissionState(
  text: string,
  state: "pending" | "complete" | "failure",
): HTMLElement {
  const element = document.createElement("span");
  element.className = `approval-submit-state ${state}`;
  element.setAttribute("role", state === "failure" ? "alert" : "status");
  element.setAttribute(
    "aria-live",
    state === "failure" ? "assertive" : "polite",
  );
  element.textContent = text;
  return element;
}

async function renderSavedHosts(): Promise<void> {
  const container = requiredElement("saved-hosts");
  const section = requiredElement("saved-section");
  const hosts = (await listHosts()).filter((host) => host.kind !== "admin");
  savedHostsCache = hosts;
  renderDevicePersistence();
  container.replaceChildren();
  section.hidden = hosts.length === 0;
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "saved-host";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = savedHostDisplayName(host);
    const account = document.createElement("small");
    account.className = "saved-host-account";
    account.textContent = `用户：${savedHostLoginName(host)}`;
    const endpoint = document.createElement("small");
    endpoint.className = "saved-host-endpoint";
    endpoint.textContent = host.directEndpoint
      ? `Direct 优先 · ${host.directEndpoint}`
      : host.endpoint;
    info.append(name, account, endpoint);
    const connect = button("继续", "primary");
    connect.addEventListener(
      "click",
      () =>
        void runLoginButtonAction(connect, "正在验证…", () =>
          connectSaved(host),
        ),
    );
    const more = document.createElement("details");
    more.className = "host-menu";
    const summary = document.createElement("summary");
    summary.textContent = "管理";
    const remove = button("移除此设备", "ghost");
    const recover = button("恢复 Passkey", "ghost");
    recover.addEventListener("click", async () => {
      const code = window.prompt("输入一个未使用的宿主机恢复码");
      if (!code) return;
      try {
        const result = await GatewayClient.recover(savedHostDocument(host), {
          loginName: host.name,
          recoveryCode: code,
          deviceName: host.deviceName,
          rememberDevice: true,
        });
        showRecoveryCodes(result.recoveryCodes);
        await activate(result.client);
      } catch (error) {
        setupError.textContent = errorMessage(error);
      }
    });
    remove.addEventListener("click", async () => {
      await deleteHost(host.id);
      await renderSavedHosts();
    });
    more.append(summary, recover, remove);
    row.append(info, connect, more);
    container.append(row);
  }
}

function savedHostDocument(host: SavedHost): HostDocument {
  if (host.transport === "direct") {
    return {
      version: 1,
      transport: "direct",
      endpoint: host.directEndpoint ?? host.endpoint,
      ...(host.relayEndpoint ? { relayEndpoint: host.relayEndpoint } : {}),
      ...(host.routeId ? { routeId: host.routeId } : {}),
      nodeId: host.nodeId,
      userId: host.userId,
      hostPublicKey: host.hostPublicKey,
      hostFingerprint: host.hostFingerprint,
    };
  }
  if (!host.routeId) throw new Error("已保存的 Relay 路由无效");
  return {
    version: 1,
    transport: "relay",
    endpoint: host.relayEndpoint ?? host.endpoint,
    ...(host.directEndpoint ? { directEndpoint: host.directEndpoint } : {}),
    routeId: host.routeId,
    nodeId: host.nodeId,
    userId: host.userId,
    hostPublicKey: host.hostPublicKey,
    hostFingerprint: host.hostFingerprint,
  };
}

function appendTimeline(kind: string, title: string, content: string): void {
  timelineView.appendNotice(title, content, kind);
}

function setStatus(
  state: "online" | "offline" | "connecting",
  text: string,
): void {
  const dot = requiredElement("status-dot");
  dot.className = `dot ${state}`;
  requiredElement("status-symbol").textContent =
    state === "online" ? "✓" : state === "connecting" ? "…" : "×";
  requiredElement("status-text").textContent = text;
  requiredElement("connection-status").setAttribute(
    "aria-label",
    `连接状态：${text}`,
  );
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element as T;
}

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function button(label: string, className: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = className;
  element.textContent = label;
  return element;
}

function emptyElement(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "empty";
  element.textContent = text;
  return element;
}

function statusKey(status: unknown): string {
  if (typeof status === "string") return status;
  if (isRecord(status) && typeof status.type === "string") {
    if (
      status.type === "active" &&
      Array.isArray(status.activeFlags) &&
      status.activeFlags.includes("waitingOnApproval")
    )
      return "waiting";
    return status.type;
  }
  return "idle";
}

function statusLabel(status: unknown): string {
  const key = statusKey(status);
  const labels: Record<string, string> = {
    active: "运行中",
    waiting: "等待审批",
    idle: "空闲",
    notLoaded: "已休眠",
    systemError: "异常",
    running: "运行中",
    inProgress: "运行中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[key] ?? key;
}

function setThreadStatus(status: unknown): void {
  const element = requiredElement("thread-state");
  const key = statusKey(status);
  element.className = `pill ${key}`;
  element.textContent = statusLabel(status);
  if (isThreadStatus(status)) activeThreadStatus = status;
  if (activeThreadStatus?.type === "active") {
    lastRealtimeEventAt ||= Date.now();
    startThreadSync();
  } else {
    if (activeHistoryMode === "initializing") startThreadSync();
    else stopThreadSync();
    if (threadSettingsPendingNextTurn) {
      threadSettingsPendingNextTurn = false;
      renderComposerSessionMeta();
    }
  }
  updateComposerMode();
  renderSideCommandCompletion();
}

function updatePendingApprovalState(): void {
  if (pendingRequestIds.size > 0) {
    setThreadActivity(
      "waiting",
      pendingRequestIds.size === 1
        ? "等待操作"
        : `等待 ${pendingRequestIds.size} 项操作`,
    );
    return;
  }
  if (activeThreadStatus?.type === "active")
    setThreadActivity("active", "继续处理");
}

function renderComposerSessionMeta(): void {
  const meta = requiredElement("composer-session-meta");
  const hint = requiredElement("message-input").parentElement?.querySelector(
    ".composer-hint",
  ) as HTMLElement | null;
  if (!activeThreadSettings || !activeThreadId) {
    meta.hidden = true;
    if (hint) hint.hidden = false;
    return;
  }
  meta.hidden = false;
  if (hint) hint.hidden = true;
  requiredElement("thread-info-model").textContent = activeThreadSettings.model;
  requiredElement("thread-info-effort").textContent = reasoningEffortLabel(
    activeThreadSettings.effort,
  );
  const permissionLabel = `${sandboxPolicyLabel(activeThreadSettings.sandboxPolicy)} · ${approvalPolicyLabel(activeThreadSettings.approvalPolicy)}`;
  requiredElement("thread-info-permissions").textContent = permissionLabel;
  const permission = requiredElement("thread-permission-summary");
  permission.classList.toggle(
    "dangerous",
    activeThreadSettings.sandboxPolicy.type === "dangerFullAccess",
  );
  permission.classList.toggle(
    "read-only",
    activeThreadSettings.sandboxPolicy.type === "readOnly",
  );
  permission.setAttribute(
    "aria-label",
    `会话权限：${permissionLabel}。点击修改后续轮次权限`,
  );
  requiredElement("thread-permission-pending").hidden =
    !threadSettingsPendingNextTurn;

  requiredElement("thread-model-summary").setAttribute(
    "aria-label",
    `模型：${activeThreadSettings.model}，推理强度：${reasoningEffortLabel(activeThreadSettings.effort)}。点击修改`,
  );

  const context = contextUsagePresentation(activeThreadTokenUsage);
  requiredElement("thread-context-window").textContent = context.windowLabel;
  requiredElement("thread-context-percent").textContent = context.percentLabel;
  const contextSummary = requiredElement("thread-context-summary");
  const contextRing = requiredElement<HTMLElement>("thread-context-ring");
  contextSummary.className = `session-context ${context.level}`;
  contextRing.style.setProperty(
    "--context-progress",
    `${(context.percent ?? 0) * 3.6}deg`,
  );
  contextSummary.setAttribute(
    "aria-label",
    context.percent === null
      ? `上下文用量：${context.detail}`
      : `上下文窗口 ${context.windowLabel}，已使用 ${context.percentLabel}`,
  );
  contextSummary.setAttribute(
    "aria-valuetext",
    context.percent === null
      ? context.detail
      : `${context.label}，${context.percentLabel}`,
  );
  if (context.percent === null) {
    contextSummary.removeAttribute("aria-valuenow");
  } else {
    contextSummary.setAttribute("aria-valuenow", context.percent.toFixed(1));
  }
  contextSummary.title =
    context.percent === null
      ? context.detail
      : `当前上下文 ${context.label}，${context.detail}${context.level === "danger" ? "；建议尽快压缩上下文" : ""}`;
}

function reasoningEffortLabel(effort: ReasoningEffort | null): string {
  if (!effort) return "默认";
  const labels: Partial<Record<ReasoningEffort, string>> = {
    minimal: "最低",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
  };
  return labels[effort] ?? effort;
}

function sandboxPolicyLabel(policy: SandboxPolicy): string {
  const labels: Record<SandboxPolicy["type"], string> = {
    readOnly: "只读",
    workspaceWrite: "工作区可写",
    dangerFullAccess: "完全访问",
    externalSandbox: "外部沙箱",
  };
  return labels[policy.type] ?? policy.type;
}

function approvalPolicyLabel(policy: AskForApproval): string {
  if (typeof policy !== "string") return "自定义审批";
  const labels: Record<string, string> = {
    "on-request": "按需审批",
    untrusted: "不受信任时审批",
    never: "不审批",
  };
  return labels[policy] ?? policy;
}

function sandboxPolicyForType(
  type: SandboxPolicy["type"],
  current: SandboxPolicy,
): SandboxPolicy {
  if (type === current.type) return current;
  if (type === "dangerFullAccess") return { type };
  const networkAccess =
    "networkAccess" in current && typeof current.networkAccess === "boolean"
      ? current.networkAccess
      : false;
  if (type === "readOnly") return { type, networkAccess };
  if (type === "workspaceWrite") {
    return {
      type,
      writableRoots: [],
      networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return current;
}

function applyThreadSettingsNotification(
  payload: Record<string, unknown>,
): void {
  if (!isRecord(payload.threadSettings)) return;
  const settings = payload.threadSettings;
  if (
    typeof settings.model !== "string" ||
    !(settings.effort === null || typeof settings.effort === "string") ||
    !isApprovalPolicy(settings.approvalPolicy) ||
    !isSandboxPolicy(settings.sandboxPolicy)
  )
    return;
  const typed = settings as unknown as ThreadSettings;
  activeThreadSettings = {
    model: typed.model,
    effort: typed.effort,
    approvalPolicy: typed.approvalPolicy,
    sandboxPolicy: typed.sandboxPolicy,
  };
  if (typeof typed.cwd === "string") {
    activeThreadCwd = typed.cwd;
    requiredElement("thread-cwd").textContent = typed.cwd;
  }
  threadSettingsPendingNextTurn = activeThreadStatus?.type === "active";
  renderComposerSessionMeta();
}

function isApprovalPolicy(value: unknown): value is AskForApproval {
  return (
    value === "untrusted" ||
    value === "on-request" ||
    value === "never" ||
    (isRecord(value) && isRecord(value.granular))
  );
}

function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return (
    isRecord(value) &&
    (value.type === "readOnly" ||
      value.type === "workspaceWrite" ||
      value.type === "dangerFullAccess" ||
      value.type === "externalSandbox")
  );
}

function isThreadTokenUsage(value: unknown): value is ThreadTokenUsage {
  if (!isRecord(value) || !isRecord(value.total) || !isRecord(value.last))
    return false;
  return (
    typeof value.total.totalTokens === "number" &&
    typeof value.last.totalTokens === "number" &&
    (typeof value.modelContextWindow === "number" ||
      value.modelContextWindow === null)
  );
}

function updateComposerMode(): void {
  const active = activeThreadStatus?.type === "active";
  const side = Boolean(activeSideSession);
  const label = sendMessage.querySelector("span");
  if (label)
    label.textContent =
      side && active ? "Side 处理中" : active ? "加入队列" : "发送";
  queueMessage.hidden = true;
  const interrupt = requiredElement<HTMLButtonElement>("interrupt-turn");
  interrupt.hidden = !active || !activeTurnId;
  const waitingForApproval =
    activeThreadStatus?.type === "active" &&
    activeThreadStatus.activeFlags.includes("waitingOnApproval");
  interrupt.title = waitingForApproval
    ? "审批请求已不可见时，可停止当前任务后继续"
    : "停止当前 Codex 任务";
  requiredElement("thread-state").title = active
    ? side
      ? "Side 是临时支线，不支持持久 Queue；请等待当前回复结束"
      : "新消息会保存在 HPC 队列中，并在当前任务结束后发送"
    : "";
  updateComposerSubmitAvailability();
  renderSideCommandCompletion();
  renderComposerQueue();
}

function setThreadActivity(key: string, label: string): void {
  const element = requiredElement("thread-state");
  element.className = `pill ${key}`;
  element.textContent = label;
}

function updateThreadActivity(
  event: EventEnvelope,
  payload: Record<string, unknown>,
): void {
  if (event.type === "codex/turn/started") {
    const turn = isRecord(payload.turn) ? payload.turn : undefined;
    if (turn && typeof turn.id === "string") {
      activeTurnId = turn.id;
      activeNewestTurnId = turn.id;
    }
    activeThreadStatus = { type: "active", activeFlags: [] };
    setThreadActivity("active", "正在处理");
    updateComposerMode();
    startThreadSync();
    return;
  }
  if (event.type === "codex/turn/completed") {
    pendingRequestIds.clear();
    approvalSubmissions.clear();
    clearApprovalTray(true);
    activeTurnId = undefined;
    activeThreadStatus = { type: "idle" };
    setThreadActivity("completed", "已完成");
    updateComposerMode();
    if (activeHistoryMode === "initializing") startThreadSync();
    else stopThreadSync();
    const completedThreadId = activeThreadId;
    window.setTimeout(() => {
      if (
        activeThreadId === completedThreadId &&
        requiredElement("thread-state").classList.contains("completed")
      )
        setThreadStatus({ type: "idle" });
    }, 1_200);
    return;
  }
  if (event.type === "codex/error") {
    setThreadActivity("systemError", "执行异常");
    return;
  }
  if (event.type !== "codex/item/started") return;
  const item = isRecord(payload.item) ? payload.item : {};
  const type = typeof item.type === "string" ? item.type : "";
  const activity: Record<string, [string, string]> = {
    reasoning: ["thinking", "正在思考"],
    agentMessage: ["replying", "正在回复"],
    plan: ["thinking", "正在制定计划"],
    commandExecution: ["tool", "正在执行命令"],
    fileChange: ["tool", "正在修改文件"],
    mcpToolCall: ["tool", "正在调用工具"],
    dynamicToolCall: ["tool", "正在调用工具"],
    collabAgentToolCall: ["tool", "正在协调 Agent"],
    subAgentActivity: ["tool", "子 Agent 工作中"],
    webSearch: ["tool", "正在搜索网页"],
    imageGeneration: ["tool", "正在生成图片"],
  };
  const next = activity[type];
  if (next) setThreadActivity(...next);
}

function loadingTimeline(): HTMLElement {
  const shell = document.createElement("div");
  shell.className = "timeline-loading";
  for (const width of ["72%", "88%", "58%"] as const) {
    const row = document.createElement("div");
    row.style.width = width;
    row.append(document.createElement("i"), document.createElement("span"));
    shell.append(row);
  }
  return shell;
}

function autoResize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function showToast(
  message: string,
  tone: "success" | "error" = "success",
): void {
  const region = requiredElement("toast-region");
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => {
    toast.classList.add("leaving");
    window.setTimeout(() => toast.remove(), 180);
  }, 2_800);
}

function extractThreadId(value: Record<string, unknown>): string | undefined {
  if (typeof value.threadId === "string") return value.threadId;
  if (isRecord(value.thread) && typeof value.thread.id === "string")
    return value.thread.id;
  for (const key of ["params", "payload", "request"] as const) {
    if (isRecord(value[key])) {
      const nested = extractThreadId(value[key]);
      if (nested) return nested;
    }
  }
  return undefined;
}

function genericEventSummary(payload: unknown): string {
  if (!isRecord(payload)) return String(payload ?? "");
  for (const key of ["message", "reason", "delta"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "收到无法展示的事件";
  }
}

function pathName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? path;
}

function relativeTime(timestamp: number): string {
  const milliseconds =
    timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  const delta = Date.now() - milliseconds;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(milliseconds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  return (
    isRecord(value) &&
    (value.type === "notLoaded" ||
      value.type === "idle" ||
      value.type === "systemError" ||
      (value.type === "active" && Array.isArray(value.activeFlags)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
