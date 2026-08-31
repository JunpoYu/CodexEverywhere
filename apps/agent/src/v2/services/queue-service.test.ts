import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { UserStateDatabase } from "../repositories/user-state-database.js";
import { AutoTitleService } from "./auto-title-service.js";
import { QueueService } from "./queue-service.js";
import { ThreadLeaseManager } from "./thread-lease-manager.js";

const directories: string[] = [];
const scopes: Scope[] = [];
const databases: UserStateDatabase[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
  vi.restoreAllMocks();
});

describe("QueueService", () => {
  it("claims durably before a single turn/start and completes the item", async () => {
    const fixture = await createFixture();
    const scheduleTitle = vi.spyOn(fixture.titles, "schedule");
    const item = await fixture.queue.add({
      threadId: "thread-1",
      text: "synthetic queued message",
    });

    await fixture.queue.start();
    await eventually(
      async () =>
        (await fixture.database.queue.get(item.id))?.status === "completed",
    );

    expect(fixture.runtime.turnStarts).toBe(1);
    expect(scheduleTitle).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
      "turn-1",
      "synthetic queued message",
    );
    const methods = fixture.runtime.requests.map((entry) => entry.method);
    expect(methods.indexOf("thread/read")).toBeLessThan(
      methods.indexOf("turn/start"),
    );
    expect(await fixture.database.exportSnapshot()).toMatchObject({
      records: {
        queueItems: [expect.objectContaining({ status: "completed" })],
        queueDeliveryClaims: [
          expect.objectContaining({
            operation: "turn/start",
            outcome: "completed",
            turnId: "turn-1",
          }),
        ],
      },
    });
  });

  it("never silently replays a turn/start whose response is unknown", async () => {
    const fixture = await createFixture();
    fixture.runtime.failTurnStart = true;
    const item = await fixture.queue.add({
      threadId: "thread-1",
      text: "synthetic queued message",
    });

    await fixture.queue.start();
    await eventually(
      async () =>
        (await fixture.database.queue.get(item.id))?.status === "indeterminate",
    );
    await fixture.queue.dispatchOnce();

    expect(fixture.runtime.turnStarts).toBe(1);
    expect(await fixture.database.queue.nextPending()).toBeUndefined();
  });

  it("retries an indeterminate item only after explicit acknowledgement", async () => {
    const fixture = await createFixture();
    fixture.runtime.failTurnStart = true;
    const item = await fixture.queue.add({
      threadId: "thread-1",
      text: "synthetic queued message",
    });
    await fixture.queue.start();
    await eventually(
      async () =>
        (await fixture.database.queue.get(item.id))?.status === "indeterminate",
    );

    fixture.runtime.failTurnStart = false;
    await fixture.queue.acknowledgeIndeterminate(item.id, "retry");
    await eventually(
      async () =>
        (await fixture.database.queue.get(item.id))?.status === "completed",
    );

    expect(fixture.runtime.turnStarts).toBe(2);
    expect(
      (await fixture.database.exportSnapshot()).records.auditEvents,
    ).toEqual([expect.objectContaining({ kind: "queue/indeterminate/retry" })]);
  });

  it("uses turn/steer only when the authoritative task is active", async () => {
    const fixture = await createFixture();
    fixture.runtime.status = "active";
    fixture.runtime.activeTurnId = "active-turn";
    const item = await fixture.queue.add({
      threadId: "thread-1",
      text: "original",
    });
    await fixture.queue.start();
    await fixture.queue.dispatchOnce();
    expect(fixture.runtime.turnStarts).toBe(0);

    const result = await fixture.queue.steer(item.id, "replacement");

    expect(result.status).toBe("completed");
    expect(fixture.runtime.turnSteers).toBe(1);
    expect(
      fixture.runtime.requests.find((entry) => entry.method === "turn/steer")
        ?.params,
    ).toMatchObject({
      threadId: "thread-1",
      expectedTurnId: "active-turn",
      input: [{ type: "text", text: "replacement", text_elements: [] }],
    });
  });

  it("pauses before claiming when workspace authorization changed", async () => {
    const fixture = await createFixture();
    const item = await fixture.queue.add({
      threadId: "thread-1",
      text: "synthetic queued message",
    });
    fixture.runtime.workspacePath = "/work/other";

    await fixture.queue.start();
    await eventually(
      async () =>
        (await fixture.database.queue.get(item.id))?.status === "paused",
    );

    expect(fixture.runtime.turnStarts).toBe(0);
    expect(
      (await fixture.database.exportSnapshot()).records.queueDeliveryClaims,
    ).toEqual([]);
  });

  it("recovers a crash-left delivering claim without calling Codex", async () => {
    const fixture = await createFixture();
    const item = await fixture.database.queue.add({
      id: "queue-crash",
      workspacePath: "/work/project",
      threadId: "thread-1",
      text: "synthetic queued message",
    });
    await fixture.database.queue.claim({
      itemId: item.id,
      expectedRevision: item.revision,
      operation: "turn/start",
      clientUserMessageId: "message-crash",
    });

    await expect(fixture.queue.start()).resolves.toBe(1);

    expect((await fixture.database.queue.get(item.id))?.status).toBe(
      "indeterminate",
    );
    expect(fixture.runtime.turnStarts).toBe(0);
  });
});

interface Fixture {
  readonly database: UserStateDatabase;
  readonly queue: QueueService;
  readonly runtime: FakeCodexRuntime;
  readonly titles: AutoTitleService;
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-queue-test-"));
  directories.push(directory);
  const database = await UserStateDatabase.open(
    join(directory, "state.sqlite"),
    { create: true },
  );
  databases.push(database);
  const scope = new Scope("queue-test");
  scopes.push(scope);
  const runtime = new FakeCodexRuntime();
  const leases = new ThreadLeaseManager({
    scope,
    clientFactory: runtime,
  });
  const titles = new AutoTitleService({ scope });
  const queue = new QueueService({
    scope,
    repository: database.queue,
    leases,
    titles,
    authorizeWorkspace: async (path) => path,
    dispatchIntervalMs: 60_000,
  });
  return { database, queue, runtime, titles };
}

class FakeCodexRuntime implements CodexClientFactoryPort {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  status: "idle" | "active" | "systemError" = "idle";
  activeTurnId: string | undefined;
  workspacePath = "/work/project";
  failTurnStart = false;
  turnStarts = 0;
  turnSteers = 0;

  create(scope: Scope): Promise<CodexClient> {
    const client = new FakeCodexClient(this);
    scope.defer(() => client.close());
    return Promise.resolve(client);
  }
}

class FakeCodexClient implements CodexClient {
  readonly #runtime: FakeCodexRuntime;
  readonly #notifications = new Set<(event: CodexNotification) => void>();
  readonly #requests = new Set<(request: CodexServerRequest) => void>();
  readonly #closes = new Set<() => void>();
  #closed = false;

  constructor(runtime: FakeCodexRuntime) {
    this.#runtime = runtime;
  }

  async request<Result = unknown>(
    method: string,
    params?: unknown,
  ): Promise<Result> {
    this.#runtime.requests.push({ method, params });
    if (method === "thread/read") {
      return {
        thread: {
          id: "thread-1",
          cwd: this.#runtime.workspacePath,
          status:
            this.#runtime.status === "active"
              ? { type: "active", activeFlags: [] }
              : { type: this.#runtime.status },
          turns:
            this.#runtime.activeTurnId === undefined
              ? []
              : [
                  {
                    id: this.#runtime.activeTurnId,
                    status: "inProgress",
                    items: [],
                  },
                ],
        },
      } as Result;
    }
    if (method === "turn/start") {
      this.#runtime.turnStarts += 1;
      if (this.#runtime.failTurnStart) throw new Error("connection lost");
      return { turn: { id: "turn-1" } } as Result;
    }
    if (method === "turn/steer") {
      this.#runtime.turnSteers += 1;
      return { turnId: this.#runtime.activeTurnId } as Result;
    }
    throw new Error(`Unexpected Codex method: ${method}`);
  }

  onNotification(listener: (event: CodexNotification) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    for (const listener of this.#closes) listener();
    return Promise.resolve();
  }
}

async function eventually(
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition did not become true");
}
