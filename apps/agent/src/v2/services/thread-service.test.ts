import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Scope } from "@codex-everywhere/kernel";
import {
  gatewayMethodDefinitions,
  THREAD_TITLE_MAX_LENGTH,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { UserStateDatabase } from "../repositories/user-state-database.js";
import { AutoTitleService } from "./auto-title-service.js";
import type { CodexRuntimeGatePort } from "./codex-runtime-gate.js";
import { PreferencesService } from "./preferences-service.js";
import { ThreadLeaseManager } from "./thread-lease-manager.js";
import { ThreadService } from "./thread-service.js";
import { WorkspaceService } from "./workspace-service.js";

const directories: string[] = [];
const scopes: Scope[] = [];
const runtimeGate: CodexRuntimeGatePort = {
  acquire: async () => ({ release: async () => undefined }),
  run: (operation) => operation(),
};

afterEach(async () => {
  await Promise.allSettled(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ThreadService", () => {
  it("bounds old app-server previews to the Gateway thread title limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-list-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const preview = `${"x".repeat(THREAD_TITLE_MAX_LENGTH - 1)}\ud83d\ude80${"y".repeat(10_000)}`;
    const factory = new ThreadListFactory(workspacePath, preview);
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    await workspaces.add(workspacePath, "Workspace");
    const service = new ThreadService({
      scope,
      clients: factory,
      leases: new ThreadLeaseManager({ scope, clientFactory: factory }),
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });

    const result = await service.list({
      version: 1,
      archived: false,
      limit: 50,
    });

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.title).toBe(
      "x".repeat(THREAD_TITLE_MAX_LENGTH - 1),
    );
    expect(
      gatewayMethodDefinitions["thread/list"].output.safeParse(result).success,
    ).toBe(true);
    expect(factory.client.closed).toBe(true);
  });

  it("resumes a shared lease once when two viewers open concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-open-refresh-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    let allowResume: (() => void) | undefined;
    const resumeGate = new Promise<void>((resolve) => {
      allowResume = resolve;
    });
    const factory = new ThreadOpenFactory(workspacePath, resumeGate);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    await workspaces.add(workspacePath, "Workspace");
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });
    const first = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-1",
    });
    const second = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-2",
    });

    const opens = [
      service.open(first, { historyLimit: 100 }),
      service.open(second, { historyLimit: 100 }),
    ];
    try {
      await factory.resumeRequested;
      allowResume?.();
      await Promise.all(opens);
    } finally {
      allowResume?.();
      await Promise.allSettled(opens);
      await Promise.all([first.release(), second.release()]);
    }

    expect(factory.client.methods).toEqual(["thread/resume", "thread/read"]);
  });

  it("returns the authoritative nested working directory only when requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    const workingDirectory = join(workspacePath, "nested", "project");
    await mkdir(workingDirectory, { recursive: true });
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-working-directory-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const factory = new ThreadOpenFactory(workingDirectory);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    await workspaces.add(workspacePath, "Workspace");
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });
    const handle = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-1",
    });

    try {
      const legacy = await service.open(handle, { historyLimit: 100 });
      const requested = await service.open(handle, {
        historyLimit: 100,
        includeWorkingDirectory: true,
      });

      expect(legacy).not.toHaveProperty("workingDirectory");
      expect(requested.workingDirectory).toBe(await realpath(workingDirectory));
      expect(requested.thread.workspaceId).toBe(legacy.thread.workspaceId);
    } finally {
      await handle.release();
    }
  });

  it("resumes again when an idle task receives a new lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-new-lease-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const factory = new ThreadOpenFactory(workspacePath);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    await workspaces.add(workspacePath, "Workspace");
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });

    const first = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-1",
    });
    await service.open(first, { historyLimit: 100 });
    await first.release();
    const second = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-2",
    });
    await service.open(second, { historyLimit: 100 });
    await second.release();

    expect(factory.clients).toHaveLength(2);
    expect(factory.clients.map((client) => client.methods)).toEqual([
      ["thread/resume"],
      ["thread/resume"],
    ]);
  });

  it("starts a new turn after an authoritative terminal system error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-terminal-error-retry-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const factory = new ThreadOpenFactory(
      workspacePath,
      Promise.resolve(),
      "systemError",
    );
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    await workspaces.add(workspacePath, "Workspace");
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });
    const handle = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-1",
    });

    try {
      await expect(
        service.turnStart(handle, "continue after the quota reset"),
      ).resolves.toEqual({
        version: 1,
        threadId: "thread-1",
        turnId: "turn-retry",
      });
      expect(factory.client.methods).toEqual(["thread/read", "turn/start"]);
      expect(handle.lease.state).toBe("running");
    } finally {
      await handle.release();
    }
  });

  it("updates task settings under the persisted permission boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-settings-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const factory = new ThreadSettingsFactory(workspacePath);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    await workspaces.add(workspacePath, "Workspace");
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });
    const handle = await leases.acquire("thread-1", {
      kind: "viewer",
      id: "viewer-1",
    });

    try {
      const opened = await service.open(handle, { historyLimit: 100 });
      const updated = await service.updateSettings(handle, {
        version: 1,
        threadId: "thread-1",
        expectedRevision: opened.settings.revision,
        patch: { sandbox: "danger-full-access", approvalPolicy: "never" },
      });

      expect(updated).toMatchObject({
        revision: 1,
        model: "gpt-5.6-sol",
        effort: "max",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
      expect(factory.client.requests).toEqual([
        expect.objectContaining({ method: "thread/resume" }),
        expect.objectContaining({ method: "thread/read" }),
        {
          method: "thread/settings/update",
          params: {
            threadId: "thread-1",
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        },
      ]);
      await expect(
        state.threadSettings.read("thread-1"),
      ).resolves.toMatchObject({
        revision: 1,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });

      await state.threadSettings.save("thread-1", 1, {
        sandbox: "read-only",
        approvalPolicy: "on-request",
      });
      await expect(
        service.open(handle, { historyLimit: 100 }),
      ).resolves.toMatchObject({
        settings: {
          revision: 2,
          sandbox: "read-only",
          approvalPolicy: "on-request",
        },
      });
    } finally {
      await handle.release();
    }
  });

  it("owns the first turn with a lease before an interaction can arrive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      {
        create: true,
      },
    );
    const scope = new Scope("thread-service-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const factory = new FirstTurnFactory(workspacePath);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    const workspace = await workspaces.add(workspacePath, "Workspace");
    const preferences = new PreferencesService(state.preferences);
    await preferences.update(0, { approvalPolicy: "never" });
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences,
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });

    const result = await service.start({
      version: 2,
      workspaceId: workspace.id,
      prompt: "run a command",
      expectedPreferencesRevision: 1,
      settings: { sandbox: "danger-full-access" },
    });

    expect(result).toMatchObject({
      thread: { id: "thread-1", state: "running" },
      turnId: "turn-1",
    });
    expect(factory.clients).toHaveLength(1);
    expect(factory.clients[0]?.requests[0]).toEqual({
      method: "thread/start",
      params: expect.objectContaining({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      }),
    });
    await expect(state.threadSettings.read("thread-1")).resolves.toMatchObject({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
    expect(factory.clients[0]?.closed).toBe(false);
    expect(factory.clients[0]?.methods).toEqual(["thread/start", "turn/start"]);
    const lease = leases.get("thread-1");
    expect(lease?.state).toBe("waiting-input");
    expect(lease?.referenceCount).toBe(1);
    expect(lease?.listInteractions()).toHaveLength(1);

    await lease?.respondToInteraction("interaction:thread-1:approval-1", {
      version: 1,
      kind: "approval",
      decision: "accept",
    });
    factory.clients[0]?.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await vi.waitFor(() =>
      expect(factory.clients[0]?.methods).toEqual([
        "thread/start",
        "turn/start",
        "thread/read",
        "thread/name/set",
      ]),
    );
    await vi.waitFor(() =>
      expect(leases.size === 0 && factory.clients[0]!.closed).toBe(true),
    );
    expect(factory.clients[0]?.requests.at(-1)).toEqual({
      method: "thread/name/set",
      params: { threadId: "thread-1", name: "run a command" },
    });
  });

  it("rejects a stale default-permission revision before starting Codex", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-default-revision-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    const factory = new FirstTurnFactory(workspacePath);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    const workspace = await workspaces.add(workspacePath, "Workspace");
    const preferences = new PreferencesService(state.preferences);
    await preferences.update(0, { sandbox: "read-only" });
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences,
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });

    const start = service.start({
      version: 2,
      workspaceId: workspace.id,
      prompt: "must not start",
      expectedPreferencesRevision: 0,
      settings: {
        sandbox: "workspace-write",
      },
    });

    await expect(start).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(factory.clients).toHaveLength(0);
  });

  it("keeps inherited permissions stable until Codex accepts thread/start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-service-"));
    directories.push(directory);
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      { create: true },
    );
    const scope = new Scope("thread-default-fence-test");
    scopes.push(scope);
    scope.defer(() => state.close());
    let acceptThreadStart: (() => void) | undefined;
    const threadStartGate = new Promise<void>((resolve) => {
      acceptThreadStart = resolve;
    });
    const factory = new FirstTurnFactory(workspacePath, threadStartGate);
    const leases = new ThreadLeaseManager({ scope, clientFactory: factory });
    const workspaces = new WorkspaceService(state.workspaces, {
      home: directory,
    });
    const workspace = await workspaces.add(workspacePath, "Workspace");
    const preferences = new PreferencesService(state.preferences);
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences,
      settings: state.threadSettings,
      titles: new AutoTitleService({ scope }),
      runtimeGate,
    });

    const start = service.start({
      version: 2,
      workspaceId: workspace.id,
      prompt: "hold defaults stable",
      expectedPreferencesRevision: 0,
    });
    await factory.threadStartRequested;
    let preferencesUpdated = false;
    const update = preferences
      .update(0, { approvalPolicy: "never" })
      .then((result) => {
        preferencesUpdated = true;
        return result;
      });

    const updateBeforeAcceptance = await Promise.race([
      update.then(() => "updated" as const),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 25),
      ),
    ]);
    acceptThreadStart?.();
    expect(updateBeforeAcceptance).toBe("blocked");
    await expect(start).resolves.toMatchObject({
      thread: { id: "thread-1" },
    });
    await expect(update).resolves.toMatchObject({
      revision: 1,
      approvalPolicy: "never",
    });
  });
});

class ThreadOpenFactory implements CodexClientFactoryPort {
  readonly clients: ThreadOpenClient[] = [];
  readonly resumeRequested: Promise<void>;
  readonly #workspacePath: string;
  readonly #resumeGate: Promise<void>;
  readonly #markResumeRequested: () => void;

  constructor(
    workspacePath: string,
    resumeGate: Promise<void> = Promise.resolve(),
    private readonly status: "idle" | "systemError" | "active" = "idle",
  ) {
    this.#workspacePath = workspacePath;
    this.#resumeGate = resumeGate;
    let markResumeRequested: (() => void) | undefined;
    this.resumeRequested = new Promise<void>((resolve) => {
      markResumeRequested = resolve;
    });
    this.#markResumeRequested = () => markResumeRequested?.();
  }

  get client(): ThreadOpenClient {
    const client = this.clients[0];
    if (client === undefined) throw new Error("Thread client was not created");
    return client;
  }

  create(scope: Scope): Promise<CodexClient> {
    const client = new ThreadOpenClient(
      this.#workspacePath,
      this.#resumeGate,
      this.status,
      this.#markResumeRequested,
    );
    this.clients.push(client);
    scope.defer(() => client.close());
    return Promise.resolve(client);
  }
}

class ThreadOpenClient implements CodexClient {
  readonly methods: string[] = [];
  closed = false;

  constructor(
    private readonly workspacePath: string,
    private readonly resumeGate: Promise<void>,
    private readonly status: "idle" | "systemError" | "active",
    private readonly markResumeRequested: () => void,
  ) {}

  async request<Result = unknown>(method: string): Promise<Result> {
    this.methods.push(method);
    if (method === "thread/resume") {
      this.markResumeRequested();
      await this.resumeGate;
      return {
        thread: thread(this.workspacePath, this.status),
        approvalPolicy: "on-request",
        sandbox: workspaceWriteSandbox(),
      } as Result;
    }
    if (method === "thread/read") {
      return { thread: thread(this.workspacePath, this.status) } as Result;
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-retry" } } as Result;
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  onNotification(): () => void {
    return () => undefined;
  }

  onServerRequest(): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class ThreadSettingsFactory implements CodexClientFactoryPort {
  readonly client: ThreadSettingsClient;

  constructor(workspacePath: string) {
    this.client = new ThreadSettingsClient(workspacePath);
  }

  create(scope: Scope): Promise<CodexClient> {
    scope.defer(() => this.client.close());
    return Promise.resolve(this.client);
  }
}

class ThreadSettingsClient implements CodexClient {
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  constructor(private readonly workspacePath: string) {}

  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "thread/resume") {
      return Promise.resolve({
        thread: thread(this.workspacePath),
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        approvalPolicy: "on-request",
        sandbox: workspaceWriteSandbox(),
      } as Result);
    }
    if (method === "thread/read") {
      return Promise.resolve({ thread: thread(this.workspacePath) } as Result);
    }
    if (method === "thread/settings/update") {
      return Promise.resolve({} as Result);
    }
    return Promise.reject(new Error(`Unexpected request: ${method}`));
  }

  onNotification(): () => void {
    return () => undefined;
  }

  onServerRequest(): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class ThreadListFactory implements CodexClientFactoryPort {
  readonly client: ThreadListClient;

  constructor(workspacePath: string, preview: string) {
    this.client = new ThreadListClient(workspacePath, preview);
  }

  create(scope: Scope): Promise<CodexClient> {
    scope.defer(() => this.client.close());
    return Promise.resolve(this.client);
  }
}

class ThreadListClient implements CodexClient {
  closed = false;

  constructor(
    private readonly workspacePath: string,
    private readonly preview: string,
  ) {}

  request<Result = unknown>(method: string): Promise<Result> {
    if (method !== "thread/list") {
      return Promise.reject(new Error(`Unexpected request: ${method}`));
    }
    return Promise.resolve({
      data: [
        {
          ...thread(this.workspacePath),
          name: null,
          preview: this.preview,
        },
      ],
      nextCursor: null,
    } as Result);
  }

  onNotification(): () => void {
    return () => undefined;
  }

  onServerRequest(): () => void {
    return () => undefined;
  }

  onClose(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FirstTurnFactory implements CodexClientFactoryPort {
  readonly clients: FirstTurnClient[] = [];
  readonly threadStartRequested: Promise<void>;
  readonly #markThreadStartRequested: () => void;

  constructor(
    private readonly workspacePath: string,
    private readonly threadStartGate: Promise<void> = Promise.resolve(),
  ) {
    let markThreadStartRequested: (() => void) | undefined;
    this.threadStartRequested = new Promise<void>((resolve) => {
      markThreadStartRequested = resolve;
    });
    this.#markThreadStartRequested = () => markThreadStartRequested?.();
  }

  create(scope: Scope): Promise<CodexClient> {
    const client = new FirstTurnClient(
      this.workspacePath,
      this.threadStartGate,
      this.#markThreadStartRequested,
    );
    this.clients.push(client);
    scope.defer(() => client.close());
    return Promise.resolve(client);
  }
}

class FirstTurnClient implements CodexClient {
  readonly methods: string[] = [];
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly #notifications = new Set<
    (notification: CodexNotification) => void
  >();
  readonly #serverRequests = new Set<(request: CodexServerRequest) => void>();
  readonly #closeListeners = new Set<() => void>();
  closed = false;

  constructor(
    private readonly workspacePath: string,
    private readonly threadStartGate: Promise<void>,
    private readonly markThreadStartRequested: () => void,
  ) {}

  async request<Result = unknown>(
    method: string,
    params?: unknown,
  ): Promise<Result> {
    this.methods.push(method);
    this.requests.push({
      method,
      ...(params === undefined ? {} : { params }),
    });
    if (method === "thread/start") {
      this.markThreadStartRequested();
      await this.threadStartGate;
      return {
        thread: thread(this.workspacePath),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: workspaceWriteSandbox(),
      } as Result;
    }
    if (method === "turn/start") {
      for (const listener of [...this.#serverRequests]) {
        listener({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "item-1",
            command: "synthetic",
          },
          respond: vi.fn(),
          reject: vi.fn(),
        });
      }
      return { turn: { id: "turn-1" } } as Result;
    }
    if (method === "thread/read") {
      return { thread: thread(this.workspacePath) } as Result;
    }
    if (method === "thread/name/set") {
      return {} as Result;
    }
    throw new Error(`Unexpected first-turn request: ${method}`);
  }

  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.#serverRequests.add(listener);
    return () => this.#serverRequests.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const listener of [...this.#closeListeners]) listener();
    return Promise.resolve();
  }

  notification(method: string, params: unknown): void {
    for (const listener of [...this.#notifications]) {
      listener({ method, params });
    }
  }
}

function thread(
  workspacePath: string,
  status: "idle" | "systemError" | "active" = "idle",
) {
  return {
    id: "thread-1",
    cwd: workspacePath,
    name: null,
    preview: "First task",
    createdAt: 1_776_297_600,
    updatedAt: 1_776_297_600,
    status:
      status === "active"
        ? { type: status, activeFlags: [] }
        : { type: status },
    turns:
      status === "systemError"
        ? [
            {
              id: "turn-failed",
              status: "failed",
              error: {
                message: "Scenario usage limit exceeded",
                codexErrorInfo: "UsageLimitExceeded",
              },
            },
          ]
        : [],
  };
}

function workspaceWriteSandbox() {
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
