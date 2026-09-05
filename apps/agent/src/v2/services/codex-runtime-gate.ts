import { Scope } from "@codex-everywhere/kernel";

import type { HostConfigCoordination } from "../../host/config.js";

export const CODEX_RUNTIME_GATE_LOCK = "codex-runtime";

export interface CodexRuntimeGateLease {
  release(): Promise<void>;
}

export interface CodexRuntimeGatePort {
  acquire(): Promise<CodexRuntimeGateLease>;
  run<Result>(operation: () => Promise<Result>): Promise<Result>;
}

/**
 * Cross-process fence between app-server lifecycle changes and requests that
 * can begin Codex work. It coordinates CE Web, Queue, and the `ce tui` proxy;
 * clients that connect directly to app-server remain outside CE's boundary.
 */
export class CodexRuntimeGate implements CodexRuntimeGatePort {
  readonly #scope: Scope;
  readonly #coordination: HostConfigCoordination;

  constructor(options: {
    readonly scope: Scope;
    readonly coordination: HostConfigCoordination;
  }) {
    this.#scope = options.scope.fork("codex-runtime-gate");
    this.#coordination = options.coordination;
  }

  acquire(): Promise<CodexRuntimeGateLease> {
    this.#scope.throwIfClosed();
    return this.#coordination.acquireCoordinationLock(CODEX_RUNTIME_GATE_LOCK, {
      signal: this.#scope.signal,
    });
  }

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const lease = await this.acquire();
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }
}
