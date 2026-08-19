import { homedir } from "node:os";

import { Scope } from "@codex-everywhere/kernel";

import { readHostConfig, type HostConfig } from "../../host/config.js";
import { codexProcessEnvironment } from "../../host/network.js";
import type { HostPaths } from "../../host/paths.js";
import {
  ensureAppServer,
  inspectAppServer,
  restartAppServer,
  type AppServerInspection,
} from "../../runtime/app-server-supervisor.js";
import {
  CodexAppServerClient,
  type InitializeOptions,
} from "../../runtime/codex-app-server-client.js";
import {
  probeCodexInstallation,
  type CodexInstallation,
} from "../../runtime/codex-install.js";

export interface CodexSupervisorDependencies {
  readConfig(paths: HostPaths): Promise<HostConfig>;
  probeInstallation(options: {
    readonly userHome: string;
    readonly env: NodeJS.ProcessEnv;
  }): Promise<CodexInstallation>;
  inspect(paths: HostPaths): Promise<AppServerInspection>;
  ensure(
    paths: HostPaths,
    options: {
      readonly codexBinary: string;
      readonly env: NodeJS.ProcessEnv;
    },
  ): Promise<{ started: boolean; pid?: number }>;
  restart(
    paths: HostPaths,
    options: {
      readonly codexBinary: string;
      readonly env: NodeJS.ProcessEnv;
      readonly force: true;
    },
  ): Promise<{ started: boolean; pid?: number }>;
  connect(
    socketPath: string,
    options: Pick<InitializeOptions, "experimentalApi">,
  ): Promise<CodexAppServerClient>;
}

const DEFAULT_DEPENDENCIES: CodexSupervisorDependencies = {
  readConfig: readHostConfig,
  probeInstallation: probeCodexInstallation,
  inspect: inspectAppServer,
  ensure: ensureAppServer,
  restart: restartAppServer,
  connect: (socketPath, options) =>
    CodexAppServerClient.connectUnix(socketPath, options),
};

export interface CodexSupervisorPort {
  inspect(): Promise<AppServerInspection>;
  ensure(): Promise<{ started: boolean; pid?: number }>;
  restart(): Promise<{ started: boolean; pid?: number }>;
  connect(): Promise<CodexAppServerClient>;
}

/** Owns serialized lifecycle operations for the user's single app-server. */
export class CodexSupervisor implements CodexSupervisorPort {
  readonly #scope: Scope;
  readonly #paths: HostPaths;
  readonly #userHome: string;
  readonly #dependencies: CodexSupervisorDependencies;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly scope: Scope;
    readonly paths: HostPaths;
    readonly userHome?: string;
    readonly dependencies?: Partial<CodexSupervisorDependencies>;
  }) {
    this.#scope = options.scope.fork("codex-supervisor");
    this.#paths = options.paths;
    this.#userHome = options.userHome ?? homedir();
    this.#dependencies = {
      ...DEFAULT_DEPENDENCIES,
      ...options.dependencies,
    };
  }

  async environment(): Promise<NodeJS.ProcessEnv> {
    this.#scope.throwIfClosed();
    const config = await this.#dependencies.readConfig(this.#paths);
    return codexProcessEnvironment(config.network, {
      userHome: this.#userHome,
    });
  }

  async installation(): Promise<CodexInstallation> {
    const env = await this.environment();
    return this.#dependencies.probeInstallation({
      userHome: this.#userHome,
      env,
    });
  }

  inspect(): Promise<AppServerInspection> {
    this.#scope.throwIfClosed();
    return this.#dependencies.inspect(this.#paths);
  }

  ensure(): Promise<{ started: boolean; pid?: number }> {
    return this.#serialize(async () => {
      const { installation, env } = await this.#runtime();
      return this.#dependencies.ensure(this.#paths, {
        codexBinary: installation.binary,
        env,
      });
    });
  }

  restart(): Promise<{ started: boolean; pid?: number }> {
    return this.#serialize(async () => {
      const { installation, env } = await this.#runtime();
      return this.#dependencies.restart(this.#paths, {
        codexBinary: installation.binary,
        env,
        force: true,
      });
    });
  }

  async connect(): Promise<CodexAppServerClient> {
    await this.ensure();
    this.#scope.throwIfClosed();
    // CE exposes thread/settings/update in Gateway API v2. Codex app-server
    // classifies that method as experimental and rejects it unless every
    // lease-owned connection explicitly opts in during initialize.
    return this.#dependencies.connect(this.#paths.appServerSocket, {
      experimentalApi: true,
    });
  }

  async #runtime(): Promise<{
    readonly installation: CodexInstallation & { readonly installed: true };
    readonly env: NodeJS.ProcessEnv;
  }> {
    this.#scope.throwIfClosed();
    const env = await this.environment();
    const installation = await this.#dependencies.probeInstallation({
      userHome: this.#userHome,
      env,
    });
    if (!installation.installed) {
      throw new Error("Codex is not installed or executable");
    }
    return {
      installation: installation as CodexInstallation & {
        readonly installed: true;
      },
      env,
    };
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.#scope.throwIfClosed();
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
