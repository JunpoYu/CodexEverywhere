import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  CODEX_INSTALL_PROGRESS_EVENT,
  PROTOCOL_VERSION,
  type CodexAuthImportRequest,
  type CodexAuthImportResult,
  type CodexInstallProgressPayload,
  type CodexInstallProgressPhase,
  type EventEnvelope,
  type RequestEnvelope,
} from "@codex-everywhere/protocol";

import {
  readHostConfig,
  writeHostConfig,
  type HostConfig,
} from "../host/config.js";
import {
  codexProcessEnvironment,
  createProxyNetworkConfig,
} from "../host/network.js";
import type { HostPaths } from "../host/paths.js";
import type { AuthenticatedRequestResult } from "../gateway/authenticated-session.js";
import {
  installCodexForCurrentUser,
  probeCodexInstallation,
  type CodexInstallation,
} from "./codex-install.js";
import {
  importCodexAuthFile,
  type CodexAuthImportOutcome,
} from "./codex-auth-import.js";
import { probeAppServer, restartAppServer } from "./app-server-supervisor.js";

type HostSetupDependencies = {
  readConfig(paths: HostPaths): Promise<HostConfig>;
  writeConfig(paths: HostPaths, config: HostConfig): Promise<void>;
  probeCodex(options: {
    userHome: string;
    env: NodeJS.ProcessEnv;
  }): Promise<CodexInstallation>;
  installCodex(options: {
    userHome: string;
    env: NodeJS.ProcessEnv;
    onProgress?: (phase: CodexInstallProgressPhase) => void;
  }): Promise<CodexInstallation>;
  probeAppServer(socketPath: string): Promise<boolean>;
  restartAppServer(
    paths: HostPaths,
    options: { codexBinary: string; env: NodeJS.ProcessEnv },
  ): Promise<unknown>;
  importCodexAuth(options: {
    userHome: string;
    content: string;
  }): Promise<CodexAuthImportOutcome>;
};

type InstallProgressEvent = EventEnvelope<CodexInstallProgressPayload>;
type InstallProgressListener = (event: InstallProgressEvent) => void;

type InstallationOperation = {
  id: string;
  phase: CodexInstallProgressPhase;
  listeners: Set<InstallProgressListener>;
};

const defaultDependencies: HostSetupDependencies = {
  readConfig: readHostConfig,
  writeConfig: writeHostConfig,
  probeCodex: probeCodexInstallation,
  installCodex: installCodexForCurrentUser,
  probeAppServer,
  restartAppServer,
  importCodexAuth: importCodexAuthFile,
};

export class HostSetupService {
  readonly #paths: HostPaths;
  readonly #userHome: string;
  readonly #dependencies: HostSetupDependencies;
  #installation: Promise<CodexInstallation> | undefined;
  #installationOperation: InstallationOperation | undefined;
  #progressCursor = 0;

  constructor(
    paths: HostPaths,
    options: {
      userHome?: string;
      dependencies?: Partial<HostSetupDependencies>;
    } = {},
  ) {
    this.#paths = paths;
    this.#userHome = options.userHome ?? homedir();
    this.#dependencies = { ...defaultDependencies, ...options.dependencies };
  }

  async request(
    request: RequestEnvelope,
    emitEvent?: (event: EventEnvelope) => void,
  ): Promise<AuthenticatedRequestResult> {
    const payload = asRecord(request.payload);
    switch (request.method) {
      case "setup/status":
        return { handled: true, value: await this.#status() };
      case "setup/network/configure":
        return { handled: true, value: await this.#configureNetwork(payload) };
      case "setup/codex/install":
        return {
          handled: true,
          value: await this.#installCodex(emitEvent),
        };
      case "setup/codex/auth/import":
        return {
          handled: true,
          value: await this.#importCodexAuth(payload),
        };
      case "setup/app-server/restart":
        return { handled: true, value: await this.#restartAppServer() };
      default:
        return { handled: false };
    }
  }

  async codexEnvironment(): Promise<NodeJS.ProcessEnv> {
    const config = await this.#dependencies.readConfig(this.#paths);
    return codexProcessEnvironment(config.network, {
      userHome: this.#userHome,
    });
  }

  async #status(): Promise<unknown> {
    const config = await this.#dependencies.readConfig(this.#paths);
    const environment = codexProcessEnvironment(config.network, {
      userHome: this.#userHome,
    });
    const installation = await this.#dependencies.probeCodex({
      userHome: this.#userHome,
      env: environment,
    });
    return {
      networkConfigured: config.network !== undefined,
      networkMode: config.network?.mode ?? "direct",
      codex: installation.installed
        ? { installed: true, version: installation.version }
        : { installed: false },
      appServerRunning: await this.#dependencies.probeAppServer(
        this.#paths.appServerSocket,
      ),
    };
  }

  async #configureNetwork(payload: Record<string, unknown>): Promise<unknown> {
    const httpProxy = optionalString(payload, "httpProxy");
    const allProxy = optionalString(payload, "allProxy");
    const noProxy = optionalString(payload, "noProxy");
    const caCertificate = optionalString(payload, "caCertificate");
    const network =
      payload.mode === "direct"
        ? ({ mode: "direct" } as const)
        : createProxyNetworkConfig({
            httpsProxy: requiredString(payload, "httpsProxy"),
            ...(httpProxy !== undefined ? { httpProxy } : {}),
            ...(allProxy !== undefined ? { allProxy } : {}),
            ...(noProxy !== undefined ? { noProxy } : {}),
            ...(caCertificate !== undefined ? { caCertificate } : {}),
          });
    if (payload.mode !== "direct" && payload.mode !== "proxy") {
      throw new Error("Network mode must be direct or proxy");
    }
    const config = await this.#dependencies.readConfig(this.#paths);
    const appServerRunning = await this.#dependencies.probeAppServer(
      this.#paths.appServerSocket,
    );
    await this.#dependencies.writeConfig(this.#paths, { ...config, network });
    return {
      networkMode: network.mode,
      restartRequired: appServerRunning,
    };
  }

  async #installCodex(
    emitEvent?: (event: EventEnvelope) => void,
  ): Promise<unknown> {
    if (!this.#installation) {
      const operation: InstallationOperation = {
        id: randomUUID(),
        phase: "preparing",
        listeners: new Set(),
      };
      this.#installationOperation = operation;
      this.#installation = this.codexEnvironment()
        .then((env) =>
          this.#dependencies.installCodex({
            userHome: this.#userHome,
            env,
            onProgress: (phase) => this.#updateProgress(operation, phase),
          }),
        )
        .then((installation) => {
          this.#updateProgress(operation, "completed");
          return installation;
        })
        .catch((error: unknown) => {
          this.#updateProgress(operation, "failed");
          throw error;
        });
    }

    const installation = this.#installation;
    const operation = this.#installationOperation;
    const listener = emitEvent as InstallProgressListener | undefined;
    if (operation && listener) {
      operation.listeners.add(listener);
      this.#emitProgress(listener, operation);
    }
    try {
      const result = await installation;
      return { installed: true, version: result.version };
    } finally {
      if (operation && listener) operation.listeners.delete(listener);
      if (this.#installation === installation) {
        this.#installation = undefined;
        this.#installationOperation = undefined;
      }
    }
  }

  #updateProgress(
    operation: InstallationOperation,
    phase: CodexInstallProgressPhase,
  ): void {
    if (operation.phase === phase) return;
    operation.phase = phase;
    for (const listener of operation.listeners) {
      this.#emitProgress(listener, operation);
    }
  }

  #emitProgress(
    listener: InstallProgressListener,
    operation: InstallationOperation,
  ): void {
    listener({
      version: PROTOCOL_VERSION,
      eventId: randomUUID(),
      cursor: `setup:${++this.#progressCursor}`,
      type: CODEX_INSTALL_PROGRESS_EVENT,
      payload: {
        version: 1,
        operationId: operation.id,
        phase: operation.phase,
      },
    });
  }

  async #restartAppServer(): Promise<unknown> {
    const env = await this.codexEnvironment();
    const installation = await this.#dependencies.probeCodex({
      userHome: this.#userHome,
      env,
    });
    if (!installation.installed)
      throw new Error("Codex is not installed or executable");
    await this.#dependencies.restartAppServer(this.#paths, {
      codexBinary: installation.binary,
      env,
    });
    return {
      running: true,
      version: installation.version,
    };
  }

  async #importCodexAuth(
    payload: Record<string, unknown>,
  ): Promise<CodexAuthImportResult> {
    const request = payload as Partial<CodexAuthImportRequest>;
    if (request.version !== 1) {
      throw new Error("Unsupported Codex auth import version");
    }
    const content = requiredString(payload, "content");
    const result = await this.#dependencies.importCodexAuth({
      userHome: this.#userHome,
      content,
    });
    return {
      version: 1,
      imported: true,
      replacedExisting: result.replacedExisting,
      restartRequired: await this.#dependencies.probeAppServer(
        this.#paths.appServerSocket,
      ),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object")
    throw new Error("Request payload must be an object");
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key);
  if (result === undefined) throw new Error(`Request requires ${key}`);
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string" || result.length === 0)
    throw new Error(`${key} must be a non-empty string`);
  return result;
}
