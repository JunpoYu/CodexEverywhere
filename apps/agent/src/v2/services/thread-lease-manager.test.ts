import { Scope } from "@codex-everywhere/kernel";
import type { JsonValue } from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { InteractionAlreadyResolvedError } from "./interaction-broker.js";
import {
  ThreadLeaseCapacityError,
  ThreadLeaseManager,
  type ThreadLeaseEvent,
} from "./thread-lease-manager.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  vi.restoreAllMocks();
});

describe("ThreadLeaseManager", () => {
  it("shares one app-server client across multiple viewers", async () => {
    const { manager, factory } = createManager();
    const [first, second] = await Promise.all([
      manager.acquire("thread-1", { kind: "viewer", id: "phone" }),
      manager.acquire("thread-1", { kind: "viewer", id: "desktop" }),
    ]);

    expect(first.lease).toBe(second.lease);
    expect(first.lease.referenceCount).toBe(2);
    expect(factory.clients).toHaveLength(1);

    await first.release();
    expect(manager.size).toBe(1);
    await second.release();
    await eventually(
      () => manager.size === 0 && factory.clients[0]?.closed === true,
    );
    expect(factory.clients[0]?.closed).toBe(true);
  });

  it("reference-counts repeated opens from the same viewer", async () => {
    const { manager } = createManager();
    const first = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const second = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });

    await first.release();
    expect(second.lease.referenceCount).toBe(1);
    expect(manager.size).toBe(1);
    await second.release();
    await eventually(() => manager.size === 0);
  });

  it("retains an active turn after the last browser disconnects", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const client = factory.clients[0]!;
    client.notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    });
    await handle.release();

    expect(manager.size).toBe(1);
    expect(handle.lease.state).toBe("running");
    expect(client.closed).toBe(false);

    client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await eventually(() => manager.size === 0 && client.closed);
    expect(client.closed).toBe(true);
  });

  it("contains and reports a rejected background lease disposal", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const events: ThreadLeaseEvent[] = [];
    handle.lease.onEvent((event) => events.push(event));
    const client = factory.clients[0]!;
    client.notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    });
    await handle.release();
    client.rejectClose();

    client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await eventually(() =>
      events.some(
        (event) =>
          event.type === "lease/failed" &&
          event.reason === "lease-disposal-failed",
      ),
    );
    expect(manager.size).toBe(0);
  });

  it("waits for an idle lease to finish closing before recreating it", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const client = factory.clients[0]!;
    client.notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    });
    await handle.release();
    const allowClose = client.deferClose();
    client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await eventually(() => client.closeRequested);

    let acquired = false;
    const next = manager
      .acquire("thread-1", { kind: "viewer", id: "desktop" })
      .then((value) => {
        acquired = true;
        return value;
      });
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(factory.clients).toHaveLength(1);

    allowClose();
    const nextHandle = await next;
    expect(factory.clients).toHaveLength(2);
    await nextHandle.release();
  });

  it("keeps a pending interaction and accepts only the first device response", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const client = factory.clients[0]!;
    client.notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress" },
    });
    const respond = vi.fn();
    client.serverRequest({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "synthetic command",
      },
      respond,
      reject: vi.fn(),
    });
    const [interaction] = handle.lease.listInteractions();
    expect(interaction).toMatchObject({
      id: "interaction:thread-1:7",
      kind: "approval",
    });
    await handle.release();
    expect(manager.size).toBe(1);

    const outcomes = await Promise.allSettled([
      handle.lease.respondToInteraction(interaction!.id, {
        version: 1,
        kind: "approval",
        decision: "accept",
      }),
      handle.lease.respondToInteraction(interaction!.id, {
        version: 1,
        kind: "approval",
        decision: "decline",
      }),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual(
      [
        expect.objectContaining({
          reason: expect.any(InteractionAlreadyResolvedError),
        }),
      ],
    );
    expect(respond).toHaveBeenCalledOnce();

    client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await eventually(() => manager.size === 0);
  });

  it("does not overwrite waiting-input when an interaction races turn/start", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "queue",
      id: "thread-start",
    });
    factory.clients[0]!.serverRequest({
      id: 8,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      respond: vi.fn(),
      reject: vi.fn(),
    });

    handle.lease.noteTurnStarted("turn-1");

    expect(handle.lease.state).toBe("waiting-input");
    await handle.release();
  });

  it("emits explicit resolution and generic forward-compatible events", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const events: ThreadLeaseEvent[] = [];
    handle.lease.onEvent((event) => events.push(event));
    const client = factory.clients[0]!;
    client.serverRequest({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        questions: [],
      },
      respond: vi.fn(),
      reject: vi.fn(),
    });
    await handle.lease.respondToInteraction("interaction:thread-1:question-1", {
      version: 1,
      kind: "user-input",
      answers: {},
    });
    client.notification("future/item/progress", {
      threadId: "thread-1",
      value: 2,
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "interaction/created" }),
      {
        type: "interaction/resolved",
        interactionId: "interaction:thread-1:question-1",
      },
      {
        type: "codex/generic",
        payload: {
          version: 1,
          method: "future/item/progress",
          params: { threadId: "thread-1", value: 2 },
        },
      },
    ]);
    await handle.release();
  });

  it("fails pending interactions when the app-server client disappears", async () => {
    const { manager, factory } = createManager();
    const handle = await manager.acquire("thread-1", {
      kind: "viewer",
      id: "phone",
    });
    const events: ThreadLeaseEvent[] = [];
    handle.lease.onEvent((event) => events.push(event));
    const reject = vi.fn();
    factory.clients[0]!.serverRequest({
      id: 9,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: null,
        serverName: "synthetic-mcp",
        mode: "form",
      },
      respond: vi.fn(),
      reject,
    });

    factory.clients[0]!.disconnect();
    await eventually(() => manager.size === 0);

    expect(reject).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "interaction/failed",
      interactionId: "interaction:thread-1:9",
      reason: "app-server-client-closed",
    });
    expect(events).toContainEqual({
      type: "lease/failed",
      reason: "app-server-client-closed",
    });
  });

  it("refuses new leases at capacity without evicting an active task", async () => {
    const { manager, factory } = createManager(1);
    const active = await manager.acquire("thread-1", {
      kind: "queue",
      id: "dispatcher",
    });
    factory.clients[0]!.notification("turn/started", {
      threadId: "thread-1",
    });

    await expect(
      manager.acquire("thread-2", { kind: "viewer", id: "phone" }),
    ).rejects.toBeInstanceOf(ThreadLeaseCapacityError);
    expect(manager.get("thread-1")).toBe(active.lease);
    expect(factory.clients).toHaveLength(1);
  });

  it("ties viewer release to its owning Scope", async () => {
    const { manager } = createManager();
    const viewerScope = rootScope().fork("viewer");
    await manager.acquire(
      "thread-1",
      { kind: "viewer", id: "phone" },
      viewerScope,
    );
    expect(manager.size).toBe(1);

    await viewerScope.close();
    await eventually(() => manager.size === 0);
  });
});

class FakeCodexClient implements CodexClient {
  readonly #notifications = new Set<
    (notification: CodexNotification) => void
  >();
  readonly #requests = new Set<(request: CodexServerRequest) => void>();
  readonly #closeListeners = new Set<() => void>();
  closed = false;
  closeRequested = false;
  #closeGate: Promise<void> = Promise.resolve();
  #closeError: Error | undefined;

  request<Result = unknown>(
    _method: string,
    _params?: unknown,
  ): Promise<Result> {
    return Promise.resolve({} as Result);
  }

  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  deferClose(): () => void {
    let allow: (() => void) | undefined;
    this.#closeGate = new Promise<void>((resolve) => {
      allow = resolve;
    });
    return () => allow?.();
  }

  rejectClose(): void {
    this.#closeError = new Error("synthetic client close failure");
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    await this.#closeGate;
    if (this.#closeError !== undefined) throw this.#closeError;
    this.closed = true;
    for (const listener of [...this.#closeListeners]) listener();
  }

  notification(method: string, params: JsonValue): void {
    for (const listener of [...this.#notifications])
      listener({ method, params });
  }

  serverRequest(request: CodexServerRequest): void {
    for (const listener of [...this.#requests]) listener(request);
  }

  disconnect(): void {
    this.closed = true;
    for (const listener of [...this.#closeListeners]) listener();
  }
}

class FakeFactory implements CodexClientFactoryPort {
  readonly clients: FakeCodexClient[] = [];

  create(scope: Scope): Promise<CodexClient> {
    const client = new FakeCodexClient();
    this.clients.push(client);
    scope.defer(() => client.close());
    return Promise.resolve(client);
  }
}

function createManager(maximumLeases = 128): {
  manager: ThreadLeaseManager;
  factory: FakeFactory;
} {
  const factory = new FakeFactory();
  const manager = new ThreadLeaseManager({
    scope: rootScope(),
    clientFactory: factory,
    maximumLeases,
  });
  return { manager, factory };
}

function rootScope(): Scope {
  const scope = new Scope("test");
  scopes.push(scope);
  return scope;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met");
}
