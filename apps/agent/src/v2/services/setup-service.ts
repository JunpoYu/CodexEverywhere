import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { Scope, TypedEventBus } from "@codex-everywhere/kernel";
import type { ThreadSourceKind } from "@codex-everywhere/codex-app-server-schema/v2";
import type { CodexInstallProgressPhase } from "@codex-everywhere/protocol";
import { GatewayV2Error } from "@codex-everywhere/protocol/v2";

import {
  readHostConfig,
  updateHostConfigWithCoordination,
  type HostConfig,
  type HostConfigCoordination,
} from "../../host/config.js";
import {
  codexProcessEnvironment,
  createProxyNetworkConfig,
} from "../../host/network.js";
import type { HostPaths } from "../../host/paths.js";
import {
  codexCliVersion,
  compareCodexVersions,
  installCodexForCurrentUser,
  probeCodexInstallation,
  probeLatestCodexVersion,
  type CodexInstallation,
} from "../../runtime/codex-install.js";
import {
  clearCodexRuntimeSwitchState,
  readCodexRuntimeSwitchState,
  writeCodexRuntimeSwitchState,
  type CodexRuntimeSwitchState,
} from "../../runtime/codex-runtime-switch.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import type { SetupHandlerMap } from "../gateway/handler-types.js";
import type { CodexSupervisorPort } from "./codex-supervisor.js";
import type { CodexRuntimeGatePort } from "./codex-runtime-gate.js";

const LOGIN_TTL_MS = 15 * 60_000;
const LOGIN_POLL_INTERVAL_SECONDS = 5;
const RESTART_SAFETY_PAGE_LIMIT = 200;
const RESTART_SAFETY_MAX_PAGES = 100;
const ALL_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const satisfies readonly ThreadSourceKind[];

export type SetupServiceEvent =
  | {
      readonly type: "setup/codex/install/progress";
      readonly payload: {
        readonly version: 1;
        readonly operationId: string;
        readonly phase: CodexInstallProgressPhase;
      };
    }
  | {
      readonly type: "setup/codex/login/completed";
      readonly payload: {
        readonly version: 1;
        readonly operationId: string;
        readonly success: boolean;
        readonly error?: string;
      };
    };

export interface SetupServiceEvents {
  readonly event: SetupServiceEvent;
}

export interface SetupServiceDependencies {
  readConfig(paths: HostPaths): Promise<HostConfig>;
  updateConfig(
    paths: HostPaths,
    coordination: HostConfigCoordination,
    update: (current: HostConfig) => HostConfig,
    options: { readonly signal: AbortSignal },
  ): Promise<HostConfig>;
  probeInstallation(options: {
    readonly userHome: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<CodexInstallation>;
  install(options: {
    readonly userHome: string;
    readonly env: NodeJS.ProcessEnv;
    readonly versionConstraint?: string;
    readonly signal: AbortSignal;
    readonly onProgress: (phase: CodexInstallProgressPhase) => void;
  }): Promise<CodexInstallation>;
  probeLatestVersion(options: {
    readonly env: NodeJS.ProcessEnv;
  }): Promise<string | undefined>;
  readRuntimeSwitchState(
    paths: HostPaths,
  ): Promise<CodexRuntimeSwitchState | undefined>;
  writeRuntimeSwitchState(
    paths: HostPaths,
    state: CodexRuntimeSwitchState,
  ): Promise<void>;
  clearRuntimeSwitchState(paths: HostPaths): Promise<void>;
}

const DEFAULT_DEPENDENCIES: SetupServiceDependencies = {
  readConfig: readHostConfig,
  updateConfig: updateHostConfigWithCoordination,
  probeInstallation: probeCodexInstallation,
  install: installCodexForCurrentUser,
  probeLatestVersion: probeLatestCodexVersion,
  readRuntimeSwitchState: readCodexRuntimeSwitchState,
  writeRuntimeSwitchState: writeCodexRuntimeSwitchState,
  clearRuntimeSwitchState: clearCodexRuntimeSwitchState,
};

type InstallOperation = {
  readonly id: string;
  readonly versionConstraint?: string;
  readonly promise: Promise<void>;
};

type LoginOperation = {
  readonly id: string;
  readonly scope: Scope;
  readonly client: CodexClient;
};

/** Onboarding and Codex account lifecycle without importing browser auth files. */
export class SetupService {
  readonly handlers: SetupHandlerMap;
  readonly events = new TypedEventBus<SetupServiceEvents>();
  readonly #scope: Scope;
  readonly #paths: HostPaths;
  readonly #userHome: string;
  readonly #coordination: HostConfigCoordination;
  readonly #supervisor: Pick<
    CodexSupervisorPort,
    "inspect" | "ensure" | "restart"
  >;
  readonly #clients: CodexClientFactoryPort;
  readonly #dependencies: SetupServiceDependencies;
  readonly #runtimeGate: CodexRuntimeGatePort;
  readonly #assertRestartSafe: () => void | Promise<void>;
  readonly #loginOperations = new Map<string, LoginOperation>();
  #installOperation: InstallOperation | undefined;

  constructor(options: {
    readonly scope: Scope;
    readonly paths: HostPaths;
    readonly coordination: HostConfigCoordination;
    readonly supervisor: Pick<
      CodexSupervisorPort,
      "inspect" | "ensure" | "restart"
    >;
    readonly clients: CodexClientFactoryPort;
    readonly runtimeGate: CodexRuntimeGatePort;
    readonly userHome?: string;
    readonly assertRestartSafe?: () => void | Promise<void>;
    readonly dependencies?: Partial<SetupServiceDependencies>;
  }) {
    this.#scope = options.scope.fork("setup");
    this.#paths = options.paths;
    this.#coordination = options.coordination;
    this.#supervisor = options.supervisor;
    this.#clients = options.clients;
    this.#runtimeGate = options.runtimeGate;
    this.#userHome = options.userHome ?? homedir();
    this.#assertRestartSafe = options.assertRestartSafe ?? (() => undefined);
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
    this.#scope.defer(() => {
      this.#loginOperations.clear();
      this.events.clear();
    });

    this.handlers = {
      "setup/status": () => this.#status(),
      "setup/network/configure": (input) => this.#configureNetwork(input),
      "setup/codex/install": (input) =>
        this.#startInstall(input.versionConstraint),
      "setup/codex/version": (input) =>
        this.#version(input.includeRuntimeSwitchState === true),
      "setup/codex/login/start": () => this.#startLogin(),
      "setup/codex/login/cancel": (input) =>
        this.#cancelLogin(input.operationId),
      "setup/codex/logout": () => this.#logout(),
      "setup/app-server/restart": () => this.#restart(),
    };
  }

  async #status() {
    this.#scope.throwIfClosed();
    const config = await this.#dependencies.readConfig(this.#paths);
    const env = this.#environment(config);
    const installation = await this.#dependencies.probeInstallation({
      userHome: this.#userHome,
      env,
    });
    const inspection = await this.#supervisor.inspect();
    const appServerHealthy = inspection.health === "healthy";
    const codexAuthenticated = appServerHealthy
      ? await this.#readAccountAuthenticated()
      : false;
    const networkConfigured = config.network !== undefined;
    return {
      version: 1 as const,
      networkConfigured,
      ...(config.network === undefined
        ? {}
        : { networkMode: config.network.mode }),
      codexInstalled: installation.installed,
      ...(installation.version === undefined
        ? {}
        : { codexVersion: installation.version }),
      codexAuthenticated,
      appServerHealthy,
      ready:
        networkConfigured &&
        installation.installed &&
        codexAuthenticated &&
        appServerHealthy,
    };
  }

  async #configureNetwork(
    input: Parameters<SetupHandlerMap["setup/network/configure"]>[0],
  ) {
    const network =
      input.mode === "direct"
        ? ({ mode: "direct" } as const)
        : createProxyNetworkConfig({
            httpsProxy: requiredProxy(input.httpsProxy, input.httpProxy),
            ...(input.httpProxy === undefined
              ? {}
              : { httpProxy: input.httpProxy }),
            ...(input.noProxy === undefined ? {} : { noProxy: input.noProxy }),
          });
    await this.#dependencies.updateConfig(
      this.#paths,
      this.#coordination,
      (config) => ({ ...config, network }),
      { signal: this.#scope.signal },
    );
    return {
      version: 1 as const,
      configured: true as const,
      mode: network.mode,
    };
  }

  async #startInstall(versionConstraint: string | undefined) {
    this.#scope.throwIfClosed();
    const active = this.#installOperation;
    if (active !== undefined) {
      return acceptedInstall(active, versionConstraint);
    }

    await this.#assertRuntimeRestartSafe();
    const concurrent = this.#installOperation;
    if (concurrent !== undefined) {
      return acceptedInstall(concurrent, versionConstraint);
    }

    const id = randomUUID();
    const promise = this.#runInstall(id, versionConstraint).finally(() => {
      if (this.#installOperation?.id === id) this.#installOperation = undefined;
    });
    this.#installOperation = {
      id,
      ...(versionConstraint === undefined ? {} : { versionConstraint }),
      promise,
    };
    this.#scope.defer(() => promise);
    return { version: 1 as const, operationId: id, accepted: true as const };
  }

  async #runInstall(
    operationId: string,
    versionConstraint: string | undefined,
  ): Promise<void> {
    this.#emitInstallProgress(operationId, "preparing");
    try {
      const config = await this.#dependencies.readConfig(this.#paths);
      const createdAt = new Date().toISOString();
      await this.#dependencies.writeRuntimeSwitchState(this.#paths, {
        version: 1,
        phase: "installing",
        createdAt,
      });
      const installation = await this.#dependencies.install({
        userHome: this.#userHome,
        env: this.#environment(config),
        ...(versionConstraint === undefined ? {} : { versionConstraint }),
        signal: this.#scope.signal,
        onProgress: (phase) => {
          if (phase === "installing" || phase === "verifying") {
            this.#emitInstallProgress(operationId, phase);
          }
        },
      });
      const installedVersion = installation.version
        ? (codexCliVersion(installation.version) ?? installation.version)
        : undefined;
      await this.#dependencies.writeRuntimeSwitchState(this.#paths, {
        version: 1,
        phase: "restart-required",
        createdAt,
        ...(installedVersion === undefined ? {} : { installedVersion }),
      });
      await this.#runtimeGate.run(async () => {
        await this.#assertRuntimeRestartSafe();
        await this.#supervisor.restart();
        await this.#dependencies.clearRuntimeSwitchState(this.#paths);
      });
      this.#emitInstallProgress(operationId, "completed");
    } catch (error) {
      this.#emitInstallProgress(operationId, "failed");
      if (!this.#scope.signal.aborted) {
        // The accepted operation reports failure through its event and status probe.
        void error;
      }
    }
  }

  async #version(includeRuntimeSwitchState: boolean) {
    this.#scope.throwIfClosed();
    const config = await this.#dependencies.readConfig(this.#paths);
    const env = this.#environment(config);
    const [installation, latestVersion, runtimeSwitchState] = await Promise.all(
      [
        this.#dependencies.probeInstallation({
          userHome: this.#userHome,
          env,
        }),
        this.#dependencies.probeLatestVersion({ env }),
        includeRuntimeSwitchState
          ? this.#dependencies.readRuntimeSwitchState(this.#paths)
          : Promise.resolve(undefined),
      ],
    );
    const installedVersion = installation.version
      ? (codexCliVersion(installation.version) ?? installation.version)
      : undefined;
    let relation = "unknown" as "older" | "current" | "newer" | "unknown";
    if (installedVersion !== undefined && latestVersion !== undefined) {
      const comparison = compareCodexVersions(installedVersion, latestVersion);
      relation =
        comparison < 0 ? "older" : comparison > 0 ? "newer" : "current";
    }
    const runtimeSwitchPhase: "none" | "installing" | "restart-required" =
      runtimeSwitchState?.phase ?? "none";
    return {
      version: 1 as const,
      installed: installation.installed,
      ...(installedVersion === undefined ? {} : { installedVersion }),
      ...(latestVersion === undefined ? {} : { latestVersion }),
      relation,
      ...(includeRuntimeSwitchState
        ? { runtimeSwitchState: runtimeSwitchPhase }
        : {}),
    };
  }

  async #startLogin() {
    this.#scope.throwIfClosed();
    await this.#supervisor.ensure();
    const operationScope = this.#scope.fork(`codex-login-${randomUUID()}`);
    try {
      const client = await this.#clients.create(operationScope);
      let expectedLoginId: string | undefined;
      operationScope.defer(
        client.onNotification((notification) => {
          if (notification.method !== "account/login/completed") return;
          const completion = parseLoginCompletion(notification.params);
          if (
            completion === undefined ||
            expectedLoginId === undefined ||
            (completion.loginId !== null &&
              completion.loginId !== expectedLoginId)
          ) {
            return;
          }
          void this.#completeLogin(
            expectedLoginId,
            completion.success,
            completion.error,
          );
        }),
      );
      const response = parseLoginStart(
        await client.request("account/login/start", {
          type: "chatgptDeviceCode",
        }),
      );
      expectedLoginId = response.loginId;
      const operation: LoginOperation = {
        id: response.loginId,
        scope: operationScope,
        client,
      };
      this.#loginOperations.set(operation.id, operation);
      operationScope.setTimeout(() => {
        void this.#expireLogin(operation.id);
      }, LOGIN_TTL_MS);
      return {
        version: 1 as const,
        operationId: operation.id,
        verificationUri: response.verificationUrl,
        userCode: response.userCode,
        expiresAt: new Date(Date.now() + LOGIN_TTL_MS).toISOString(),
        intervalSeconds: LOGIN_POLL_INTERVAL_SECONDS,
      };
    } catch (error) {
      await operationScope.close("codex-login-start-failed");
      throw error;
    }
  }

  async #cancelLogin(operationId: string) {
    const operation = this.#loginOperations.get(operationId);
    if (operation === undefined) {
      return { version: 1 as const, cancelled: true as const };
    }
    this.#loginOperations.delete(operationId);
    try {
      await operation.client.request("account/login/cancel", {
        loginId: operationId,
      });
    } finally {
      await operation.scope.close("codex-login-cancelled");
    }
    return { version: 1 as const, cancelled: true as const };
  }

  async #logout() {
    await this.#runtimeGate.run(async () => {
      await this.#assertRestartSafe();
      await this.#withClient(async (client) => {
        await client.request("account/logout", {});
      });
    });
    return { version: 1 as const, loggedOut: true as const };
  }

  async #restart() {
    await this.#runtimeGate.run(async () => {
      await this.#assertRuntimeRestartSafe();
      await this.#supervisor.restart();
      const pending = await this.#dependencies.readRuntimeSwitchState(
        this.#paths,
      );
      if (pending?.phase === "restart-required") {
        await this.#dependencies.clearRuntimeSwitchState(this.#paths);
      }
    });
    return { version: 1 as const, restarted: true as const };
  }

  async #assertRuntimeRestartSafe(): Promise<void> {
    if (this.#loginOperations.size > 0) {
      throw new GatewayV2Error(
        "APP_SERVER_BUSY",
        "Cannot restart Codex app-server while a device login is active",
      );
    }
    await this.#assertRestartSafe();
    const inspection = await this.#supervisor.inspect();
    if (
      inspection.health === "starting" ||
      inspection.health === "live-unresponsive"
    ) {
      throw new GatewayV2Error(
        "APP_SERVER_BUSY",
        "Cannot verify active Codex tasks while app-server is starting or unresponsive",
      );
    }
    if (inspection.health !== "healthy") return;
    await this.#assertNoActiveCodexThreads();
  }

  async #assertNoActiveCodexThreads(): Promise<void> {
    await this.#withClient(async (client) => {
      for (const archived of [false, true]) {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        let complete = false;
        for (let page = 0; page < RESTART_SAFETY_MAX_PAGES; page += 1) {
          const response = await client.request("thread/list", {
            ...(cursor === undefined ? {} : { cursor }),
            limit: RESTART_SAFETY_PAGE_LIMIT,
            archived,
            sortKey: "updated_at",
            sortDirection: "desc",
            sourceKinds: [...ALL_THREAD_SOURCE_KINDS],
          });
          if (!isRecord(response) || !Array.isArray(response.data)) {
            throw invalidRestartSafetyResponse();
          }
          for (const thread of response.data) {
            if (!isRecord(thread) || !isRecord(thread.status)) {
              throw invalidRestartSafetyResponse();
            }
            if (thread.status.type === "active") {
              throw new GatewayV2Error(
                "APP_SERVER_BUSY",
                "Cannot restart Codex app-server while a task is active",
              );
            }
            if (
              thread.status.type !== "notLoaded" &&
              thread.status.type !== "idle" &&
              thread.status.type !== "systemError"
            ) {
              throw invalidRestartSafetyResponse();
            }
          }
          if (response.nextCursor === null) {
            complete = true;
            break;
          }
          if (
            typeof response.nextCursor !== "string" ||
            response.nextCursor.length === 0 ||
            seenCursors.has(response.nextCursor)
          ) {
            throw invalidRestartSafetyResponse();
          }
          cursor = response.nextCursor;
          seenCursors.add(cursor);
        }
        if (!complete) throw invalidRestartSafetyResponse();
      }
    });
  }

  async #readAccountAuthenticated(): Promise<boolean> {
    try {
      return await this.#withClient(async (client) => {
        const value = await client.request("account/read", {
          refreshToken: false,
        });
        if (!isRecord(value)) return false;
        return isRecord(value.account);
      });
    } catch {
      return false;
    }
  }

  async #withClient<Result>(
    operation: (client: CodexClient) => Promise<Result>,
  ): Promise<Result> {
    const scope = this.#scope.fork(`setup-client-${randomUUID()}`);
    try {
      const client = await this.#clients.create(scope);
      return await operation(client);
    } finally {
      await scope.close("setup-client-completed");
    }
  }

  async #completeLogin(
    operationId: string,
    success: boolean,
    error: string | null,
  ): Promise<void> {
    const operation = this.#loginOperations.get(operationId);
    if (operation === undefined) return;
    this.#loginOperations.delete(operationId);
    this.#emit({
      type: "setup/codex/login/completed",
      payload: {
        version: 1,
        operationId,
        success,
        ...(error === null ? {} : { error: safeError(error) }),
      },
    });
    await operation.scope.close("codex-login-completed");
  }

  async #expireLogin(operationId: string): Promise<void> {
    const operation = this.#loginOperations.get(operationId);
    if (operation === undefined) return;
    this.#loginOperations.delete(operationId);
    try {
      await operation.client.request("account/login/cancel", {
        loginId: operationId,
      });
    } catch {
      // Expiry remains local even when app-server has already forgotten the login.
    }
    this.#emit({
      type: "setup/codex/login/completed",
      payload: {
        version: 1,
        operationId,
        success: false,
        error: "Device-code login expired",
      },
    });
    await operation.scope.close("codex-login-expired");
  }

  #environment(config: HostConfig): NodeJS.ProcessEnv {
    return codexProcessEnvironment(config.network, {
      userHome: this.#userHome,
    });
  }

  #emitInstallProgress(
    operationId: string,
    phase: CodexInstallProgressPhase,
  ): void {
    this.#emit({
      type: "setup/codex/install/progress",
      payload: { version: 1, operationId, phase },
    });
  }

  #emit(event: SetupServiceEvent): void {
    try {
      this.events.emit("event", event);
    } catch {
      // A transient transport subscriber cannot change setup side-effect outcome.
    }
  }
}

function acceptedInstall(
  active: InstallOperation,
  versionConstraint: string | undefined,
) {
  if (active.versionConstraint !== versionConstraint) {
    throw new GatewayV2Error(
      "INSTALL_IN_PROGRESS",
      "A different Codex installation is already in progress",
    );
  }
  return {
    version: 1 as const,
    operationId: active.id,
    accepted: true as const,
  };
}

function invalidRestartSafetyResponse(): GatewayV2Error {
  return new GatewayV2Error(
    "CODEX_INVALID_RESPONSE",
    "Codex app-server returned an invalid task list while checking restart safety",
  );
}

function requiredProxy(
  httpsProxy: string | undefined,
  httpProxy: string | undefined,
): string {
  const value = httpsProxy ?? httpProxy;
  if (value === undefined) {
    throw new GatewayV2Error(
      "PROXY_REQUIRED",
      "Proxy mode requires an HTTPS or HTTP proxy URL",
    );
  }
  return value;
}

function parseLoginStart(value: unknown): {
  readonly loginId: string;
  readonly verificationUrl: string;
  readonly userCode: string;
} {
  if (
    !isRecord(value) ||
    value.type !== "chatgptDeviceCode" ||
    typeof value.loginId !== "string" ||
    value.loginId.length === 0 ||
    typeof value.verificationUrl !== "string" ||
    typeof value.userCode !== "string"
  ) {
    throw new Error("Codex app-server returned an invalid device-code login");
  }
  return {
    loginId: value.loginId,
    verificationUrl: value.verificationUrl,
    userCode: value.userCode,
  };
}

function parseLoginCompletion(value: unknown):
  | {
      readonly loginId: string | null;
      readonly success: boolean;
      readonly error: string | null;
    }
  | undefined {
  if (
    !isRecord(value) ||
    (typeof value.loginId !== "string" && value.loginId !== null) ||
    typeof value.success !== "boolean" ||
    (typeof value.error !== "string" && value.error !== null)
  ) {
    return undefined;
  }
  return {
    loginId: value.loginId,
    success: value.success,
    error: value.error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeError(value: string): string {
  return value.replace(/[\r\n\0]/gu, " ").slice(0, 1_024);
}
