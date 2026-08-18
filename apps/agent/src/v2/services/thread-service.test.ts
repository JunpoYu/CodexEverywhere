import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
import { PreferencesService } from "./preferences-service.js";
import { ThreadLeaseManager } from "./thread-lease-manager.js";
import { ThreadService } from "./thread-service.js";
import { WorkspaceService } from "./workspace-service.js";

const directories: string[] = [];
const scopes: Scope[] = [];

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
    const service = new ThreadService({
      scope,
      clients: factory,
      leases,
      workspaces,
      preferences: new PreferencesService(state.preferences),
      settings: state.threadSettings,
    });

    const result = await service.start({
      version: 1,
      workspaceId: workspace.id,
      prompt: "run a command",
    });

    expect(result).toMatchObject({
      thread: { id: "thread-1", state: "running" },
      turnId: "turn-1",
    });
    expect(factory.clients).toHaveLength(2);
    expect(factory.clients[0]?.closed).toBe(true);
    expect(factory.clients[1]?.closed).toBe(false);
    expect(factory.clients[1]?.methods).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    const lease = leases.get("thread-1");
    expect(lease?.state).toBe("waiting-input");
    expect(lease?.listInteractions()).toHaveLength(1);

    await lease?.respondToInteraction("interaction:thread-1:approval-1", {
      version: 1,
      kind: "approval",
      decision: "accept",
    });
    factory.clients[1]?.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await eventually(() => leases.size === 0 && factory.clients[1]!.closed);
  });
});

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

  constructor(private readonly workspacePath: string) {}

  create(scope: Scope): Promise<CodexClient> {
    const client = new FirstTurnClient(
      this.clients.length === 0 ? "bootstrap" : "lease",
      this.workspacePath,
    );
    this.clients.push(client);
    scope.defer(() => client.close());
    return Promise.resolve(client);
  }
}

class FirstTurnClient implements CodexClient {
  readonly methods: string[] = [];
  readonly #notifications = new Set<
    (notification: CodexNotification) => void
  >();
  readonly #serverRequests = new Set<(request: CodexServerRequest) => void>();
  readonly #closeListeners = new Set<() => void>();
  closed = false;

  constructor(
    private readonly role: "bootstrap" | "lease",
    private readonly workspacePath: string,
  ) {}

  request<Result = unknown>(method: string): Promise<Result> {
    this.methods.push(method);
    if (this.role === "bootstrap" && method === "thread/start") {
      return Promise.resolve({
        thread: thread(this.workspacePath),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: workspaceWriteSandbox(),
      } as Result);
    }
    if (this.role === "lease" && method === "thread/resume") {
      return Promise.resolve({
        thread: thread(this.workspacePath),
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: workspaceWriteSandbox(),
      } as Result);
    }
    if (this.role === "lease" && method === "turn/start") {
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
      return Promise.resolve({ turn: { id: "turn-1" } } as Result);
    }
    return Promise.reject(
      new Error(`Unexpected ${this.role} request: ${method}`),
    );
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

function thread(workspacePath: string) {
  return {
    id: "thread-1",
    cwd: workspacePath,
    name: "First task",
    preview: "First task",
    createdAt: 1_776_297_600,
    updatedAt: 1_776_297_600,
    status: { type: "idle" },
    turns: [],
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

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met");
}
