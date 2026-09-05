import { Scope } from "@codex-everywhere/kernel";
import type { CodexInstallProgressPhase } from "@codex-everywhere/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostConfig, HostConfigCoordination } from "../../host/config.js";
import { resolveHostPaths } from "../../host/paths.js";
import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { SetupService, type SetupServiceEvent } from "./setup-service.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  vi.restoreAllMocks();
});

describe("SetupService", () => {
  it("reports authoritative install, account, and app-server readiness", async () => {
    const fixture = createFixture();
    fixture.runtime.account = { type: "chatgpt" };

    const result = await fixture.service.handlers["setup/status"](
      { version: 1 },
      undefined as never,
    );

    expect(result).toEqual({
      version: 1,
      networkConfigured: true,
      networkMode: "direct",
      codexInstalled: true,
      codexVersion: "codex-cli 1.2.3",
      codexAuthenticated: true,
      appServerHealthy: true,
      ready: true,
    });
    expect(fixture.supervisor.ensure).not.toHaveBeenCalled();
  });

  it("updates proxy configuration through the v0.4 coordination seam", async () => {
    const fixture = createFixture();

    const result = await fixture.service.handlers["setup/network/configure"](
      {
        version: 1,
        mode: "proxy",
        httpsProxy: "https://proxy.example:8443",
        noProxy: "localhost",
      },
      undefined as never,
    );

    expect(result).toEqual({ version: 1, configured: true, mode: "proxy" });
    expect(fixture.config.network).toEqual({
      mode: "proxy",
      httpsProxy: "https://proxy.example:8443",
      noProxy: "localhost",
    });
    expect(fixture.coordination.acquireCoordinationLock).toHaveBeenCalledWith(
      "host-config",
      expect.any(Object),
    );
  });

  it("accepts one scoped installation and emits deterministic progress", async () => {
    const fixture = createFixture();
    const events: SetupServiceEvent[] = [];
    fixture.service.events.on("event", (event) => events.push(event));

    const result = await fixture.service.handlers["setup/codex/install"](
      { version: 1, versionConstraint: "1.4.0" },
      undefined as never,
    );
    await eventually(() =>
      events.some(
        (event) =>
          event.type === "setup/codex/install/progress" &&
          event.payload.phase === "completed",
      ),
    );

    expect(result).toMatchObject({ version: 1, accepted: true });
    expect(fixture.install).toHaveBeenCalledWith(
      expect.objectContaining({
        versionConstraint: "1.4.0",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(
      events
        .filter((event) => event.type === "setup/codex/install/progress")
        .map((event) => event.payload.phase),
    ).toEqual(["preparing", "installing", "verifying", "completed"]);
    expect(fixture.supervisor.restart).toHaveBeenCalledOnce();
  });

  it("refuses an update before changing the binary when restart is unsafe", async () => {
    const fixture = createFixture({ restartSafe: false });

    await expect(
      fixture.service.handlers["setup/codex/install"](
        { version: 1 },
        undefined as never,
      ),
    ).rejects.toThrow("active task");
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.supervisor.restart).not.toHaveBeenCalled();
  });

  it("does not update while an app-server task outside CE is active", async () => {
    const fixture = createFixture();
    fixture.runtime.threads = [
      { id: "tui-task", status: { type: "active", activeFlags: [] } },
    ];

    await expect(
      fixture.service.handlers["setup/codex/install"](
        { version: 1 },
        undefined as never,
      ),
    ).rejects.toMatchObject({ code: "APP_SERVER_BUSY" });
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.supervisor.restart).not.toHaveBeenCalled();
  });

  it("does not miss an active task in the archived catalog", async () => {
    const fixture = createFixture();
    fixture.runtime.archivedThreads = [
      { id: "archived-task", status: { type: "active", activeFlags: [] } },
    ];

    await expect(
      fixture.service.handlers["setup/app-server/restart"](
        { version: 1 },
        undefined as never,
      ),
    ).rejects.toMatchObject({ code: "APP_SERVER_BUSY" });
    expect(fixture.supervisor.restart).not.toHaveBeenCalled();
  });

  it("owns device-code login until the matching completion notification", async () => {
    const fixture = createFixture();
    const events: SetupServiceEvent[] = [];
    fixture.service.events.on("event", (event) => events.push(event));

    const result = await fixture.service.handlers["setup/codex/login/start"](
      { version: 1 },
      undefined as never,
    );
    const client = fixture.runtime.clients.at(-1)!;
    client.notification("account/login/completed", {
      loginId: result.operationId,
      success: true,
      error: null,
      onboardingEntrypoint: null,
    });
    await eventually(() => client.closed);

    expect(fixture.supervisor.ensure).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      operationId: "login-1",
      verificationUri: "https://example.test/device",
      userCode: "ABCD-EFGH",
    });
    expect(events).toContainEqual({
      type: "setup/codex/login/completed",
      payload: {
        version: 1,
        operationId: "login-1",
        success: true,
      },
    });
  });

  it("checks active work before forcing an app-server restart", async () => {
    const fixture = createFixture({ restartSafe: false });

    await expect(
      fixture.service.handlers["setup/app-server/restart"](
        { version: 1 },
        undefined as never,
      ),
    ).rejects.toThrow("active task");
    expect(fixture.supervisor.restart).not.toHaveBeenCalled();
  });

  it("does not remove Codex credentials while a task or interaction is active", async () => {
    const fixture = createFixture({ restartSafe: false });

    await expect(
      fixture.service.handlers["setup/codex/logout"](
        { version: 1 },
        undefined as never,
      ),
    ).rejects.toThrow("active task");
    expect(fixture.runtime.clients).toHaveLength(0);
  });
});

function createFixture(options: { restartSafe?: boolean } = {}) {
  const scope = new Scope("setup-test");
  scopes.push(scope);
  const paths = resolveHostPaths({
    CE_HOME: "/tmp/ce-v4-setup-test",
    CE_RUNTIME_DIR: "/tmp/ce-v4-setup-runtime-test",
  });
  let config: HostConfig = {
    version: 1,
    nodeId: "host-test",
    transport: { mode: "unconfigured" },
    network: { mode: "direct" },
  };
  const runtime = new FakeRuntime();
  const coordination = {
    acquireCoordinationLock: vi.fn(async () => ({
      release: vi.fn(async () => undefined),
    })),
  } satisfies HostConfigCoordination;
  const supervisor = {
    inspect: vi.fn(async () => ({
      health: "healthy" as const,
      socketExists: true,
    })),
    ensure: vi.fn(async () => ({ started: false })),
    restart: vi.fn(async () => ({ started: true })),
  };
  const install = vi.fn(
    async (input: { onProgress(phase: CodexInstallProgressPhase): void }) => {
      input.onProgress("preparing");
      input.onProgress("installing");
      input.onProgress("verifying");
      input.onProgress("completed");
      return {
        installed: true,
        binary: "/home/alice/.local/bin/codex",
        version: "codex-cli 1.4.0",
      };
    },
  );
  const service = new SetupService({
    scope,
    paths,
    userHome: "/home/alice",
    coordination,
    supervisor,
    clients: runtime,
    assertRestartSafe: () => {
      if (options.restartSafe === false) throw new Error("active task");
    },
    dependencies: {
      readConfig: async () => config,
      updateConfig: async (_paths, lock, update, updateOptions) => {
        const lease = await lock.acquireCoordinationLock("host-config", {
          signal: updateOptions.signal,
        });
        try {
          config = update(config);
          return config;
        } finally {
          await lease.release();
        }
      },
      probeInstallation: async () => ({
        installed: true,
        binary: "/home/alice/.local/bin/codex",
        version: "codex-cli 1.2.3",
      }),
      install,
      probeLatestVersion: async () => "1.2.3",
    },
  });
  return {
    service,
    runtime,
    coordination,
    supervisor,
    install,
    get config() {
      return config;
    },
  };
}

class FakeRuntime implements CodexClientFactoryPort {
  readonly clients: FakeClient[] = [];
  account: Record<string, unknown> | null = null;
  threads: Record<string, unknown>[] = [];
  archivedThreads: Record<string, unknown>[] = [];

  create(scope: Scope): Promise<CodexClient> {
    const client = new FakeClient(this);
    this.clients.push(client);
    scope.defer(() => client.close());
    return Promise.resolve(client);
  }
}

class FakeClient implements CodexClient {
  readonly #runtime: FakeRuntime;
  readonly #notifications = new Set<(event: CodexNotification) => void>();
  readonly #serverRequests = new Set<(event: CodexServerRequest) => void>();
  readonly #closes = new Set<() => void>();
  closed = false;

  constructor(runtime: FakeRuntime) {
    this.#runtime = runtime;
  }

  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    if (method === "account/read") {
      return Promise.resolve({
        account: this.#runtime.account,
        requiresOpenaiAuth: true,
      } as Result);
    }
    if (method === "account/login/start") {
      return Promise.resolve({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://example.test/device",
        userCode: "ABCD-EFGH",
      } as Result);
    }
    if (method === "thread/list") {
      const archived =
        typeof params === "object" &&
        params !== null &&
        "archived" in params &&
        params.archived === true;
      return Promise.resolve({
        data: archived ? this.#runtime.archivedThreads : this.#runtime.threads,
        nextCursor: null,
      } as Result);
    }
    return Promise.resolve({} as Result);
  }

  onNotification(listener: (event: CodexNotification) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onServerRequest(listener: (event: CodexServerRequest) => void): () => void {
    this.#serverRequests.add(listener);
    return () => this.#serverRequests.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  notification(method: string, params: unknown): void {
    for (const listener of [...this.#notifications])
      listener({ method, params });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const listener of [...this.#closes]) listener();
    return Promise.resolve();
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition did not become true");
}
