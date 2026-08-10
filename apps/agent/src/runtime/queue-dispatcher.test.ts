import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueRegistry } from "../host/queue.js";
import { HostStateStore } from "../host/state-store.js";
import { ThreadPermissionRegistry } from "../host/thread-permissions.js";
import { WorkspaceRegistry } from "../host/workspaces.js";
import type {
  CodexAppServerClient,
  CodexServerRequest,
} from "./codex-app-server-client.js";
import { QueueConsumptionRepairer } from "./queue-consumption.js";
import { QueueDispatcher } from "./queue-dispatcher.js";

describe("QueueDispatcher", () => {
  let directory: string | undefined;
  let state: HostStateStore | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await state?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("starts a pending turn without relying on a browser session", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-dispatcher-"));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const workspaces = new WorkspaceRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    await workspaces.add(workspacePath);
    await threadPermissions.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const item = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: {
        input: [{ type: "text", text: "next" }],
        clientUserMessageId: "operation-next",
      },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "idle" },
          },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
        };
      }
      if (method === "turn/start") return { turn: { id: "turn-2" } };
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { client, notify } = fakeClient(request);
    const dispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: async () => client,
    });
    const events: string[] = [];
    dispatcher.onEvent((event) => {
      events.push(event.type);
      if (event.type === "queue/started") {
        throw new Error("injected post-completion observer failure");
      }
    });

    await dispatcher.start();

    expect(request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    expect(request).toHaveBeenCalledWith("turn/start", {
      input: [{ type: "text", text: "next" }],
      threadId: "thread-1",
      clientUserMessageId: "operation-next",
    });
    expect(await queue.get(item.id)).toMatchObject({ status: "done" });
    expect(events).toContain("queue/started");
    expect(events).not.toContain("queue/paused");
    expect(request).not.toHaveBeenCalledWith("thread/unsubscribe", {
      threadId: "thread-1",
    });

    notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "completed" },
      },
    });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("thread/unsubscribe", {
        threadId: "thread-1",
      }),
    );
    await dispatcher.close();
  });

  it("pauses queued work when its workspace is removed before the next turn", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-workspace-revoke-"));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const workspaces = new WorkspaceRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    await workspaces.add(workspacePath);
    await threadPermissions.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    const item = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "must not run" }] },
    });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "active", activeFlags: [] },
          },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
        };
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      if (method === "turn/start") return { turn: { id: "unexpected" } };
      throw new Error(`Unexpected method: ${method}`);
    });
    const { client, notify, requestServer } = fakeClient(request);
    const dispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: async () => client,
    });

    await dispatcher.start();
    const rejectApproval = vi.fn();
    requestServer({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
      respond: vi.fn(),
      reject: rejectApproval,
    });
    await workspaces.remove(workspacePath);
    notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    await vi.waitFor(async () => {
      expect(await queue.get(item.id)).toMatchObject({ status: "paused" });
    });
    expect(request).not.toHaveBeenCalledWith("turn/start", expect.anything());
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", {
      threadId: "thread-1",
    });
    await expect(
      dispatcher.respondToServerRequest({
        requestId: "queue:approval-1",
        result: { decision: "accept" },
      }),
    ).rejects.toThrow("Workspace authorization was revoked");
    expect(rejectApproval).toHaveBeenCalledWith({
      code: -32_000,
      message: "Workspace authorization was revoked",
    });
    await dispatcher.close();
  });

  it("never replays a turn/start whose accepted response was lost across restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-dispatch-unknown-"));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    let queue = new QueueRegistry(state);
    const workspaces = new WorkspaceRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    await workspaces.add(workspacePath);
    const item = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-disconnect",
        input: [{ type: "text", text: "PRIVATE DISPATCH PROMPT" }],
      },
    });
    let turnStarts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "idle" },
          },
        };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        throw new Error("connection closed after app-server accepted request");
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const firstClient = fakeClient(request).client;
    const firstDispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: async () => firstClient,
    });
    const events: string[] = [];
    firstDispatcher.onEvent((event) => events.push(event.type));

    await firstDispatcher.start();

    expect(turnStarts).toBe(1);
    await expect(queue.get(item.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
    expect(events).toContain("queue/delivering");
    expect(events).toContain("queue/indeterminate");
    const durableClaim = await state.read(
      (database) =>
        database.exec(
          "SELECT operation, thread_id, client_user_message_id, outcome FROM queue_consumption_claims WHERE queue_item_id = ?",
          [item.id],
        )[0]?.values[0],
    );
    expect(durableClaim).toEqual([
      "turn/start",
      "thread-1",
      "operation-disconnect",
      "indeterminate",
    ]);
    expect(JSON.stringify(durableClaim)).not.toContain(
      "PRIVATE DISPATCH PROMPT",
    );
    await firstDispatcher.close();
    await state.close();

    state = await HostStateStore.open(statePath);
    queue = new QueueRegistry(state);
    const secondDispatcher = new QueueDispatcher({
      queue,
      workspaces: new WorkspaceRegistry(state),
      threadPermissions: new ThreadPermissionRegistry(state),
      connectClient: async () => {
        throw new Error("restart must not reconnect for an unresolved item");
      },
    });
    await secondDispatcher.start();
    expect(turnStarts).toBe(1);
    await expect(queue.get(item.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
    await secondDispatcher.close();
  });

  it("emits indeterminate after a transient background mark repair without replaying turn/start", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-dispatch-repair-"));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const workspaces = new WorkspaceRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    await workspaces.add(workspacePath);
    const item = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-background-repair",
        input: [{ type: "text", text: "accepted once" }],
      },
    });
    const repair = queue.ensureConsumptionIndeterminate.bind(queue);
    vi.spyOn(queue, "ensureConsumptionIndeterminate")
      .mockRejectedValueOnce(new Error("injected immediate mark failure"))
      .mockRejectedValueOnce(new Error("injected retry mark failure"))
      .mockImplementation(repair);
    const consumptionRepairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 8,
    });
    let turnStarts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "idle" },
          },
        };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        throw new Error("connection closed after accepted turn/start");
      }
      if (method === "thread/unsubscribe") return { status: "unsubscribed" };
      throw new Error(`Unexpected method: ${method}`);
    });
    const dispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: async () => fakeClient(request).client,
      consumptionRepairer,
    });
    const events: string[] = [];
    dispatcher.onEvent((event) => events.push(event.type));

    await dispatcher.start();
    expect(turnStarts).toBe(1);
    await vi.waitFor(async () => {
      expect(await queue.get(item.id)).toMatchObject({
        status: "indeterminate",
      });
      expect(
        events.filter((event) => event === "queue/indeterminate"),
      ).toHaveLength(1);
    });
    expect(turnStarts).toBe(1);
    await dispatcher.close();
    await consumptionRepairer.close();
  });

  it("restores a reservation when beginConsumption definitely failed before publication", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-dispatch-preclaim-"));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const workspaces = new WorkspaceRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    await workspaces.add(workspacePath);
    const item = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "not submitted" }] },
    });
    vi.spyOn(queue, "beginConsumption").mockRejectedValueOnce(
      new Error("injected pre-publication claim failure"),
    );
    let turnStarts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "idle" },
          },
        };
      }
      if (method === "turn/start") turnStarts += 1;
      if (method === "thread/unsubscribe") return { status: "unsubscribed" };
      throw new Error(`Unexpected method: ${method}`);
    });
    const dispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: async () => fakeClient(request).client,
    });

    await dispatcher.start();

    expect(turnStarts).toBe(0);
    await expect(queue.get(item.id)).resolves.toMatchObject({
      status: "paused",
    });
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT queue_item_id FROM queue_consumption_claims WHERE queue_item_id = ?",
            [item.id],
          )[0]?.values,
      ),
    ).resolves.toBeUndefined();
    await dispatcher.close();
  });

  it("does not dispatch an old-Agent restore after a new-old-new rollback", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-rollback-barrier-"));
    const workspacePath = join(directory, "workspace");
    await mkdir(workspacePath);
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    let queue = new QueueRegistry(state);
    let workspaces = new WorkspaceRegistry(state);
    await workspaces.add(workspacePath);
    const currentItem = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-current-pending",
        input: [{ type: "text", text: "safe current item" }],
      },
    });
    await state.transaction((database) => {
      database.run(
        "INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'paused', ?, ?)",
        [
          "old-restored",
          workspacePath,
          JSON.stringify({
            threadId: "thread-1",
            turnPayload: {
              clientUserMessageId: "operation-old-restored",
              input: [{ type: "text", text: "PRIVATE OLD ACCEPTED CONTENT" }],
            },
          }),
          "2026-08-09T00:00:00.000Z",
          "2026-08-10T00:00:00.000Z",
        ],
      );
    });
    await state.close();

    state = await HostStateStore.open(statePath);
    queue = new QueueRegistry(state);
    workspaces = new WorkspaceRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    let turnStarts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") {
        return {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "idle" },
          },
        };
      }
      if (method === "turn/start") {
        turnStarts += 1;
        return { turn: { id: "must-not-start" } };
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const { client } = fakeClient(request);
    const dispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: async () => client,
    });

    await dispatcher.start();

    expect(turnStarts).toBe(0);
    await expect(queue.get("old-restored")).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(queue.get(currentItem.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(queue.claimForSteer(currentItem.id)).resolves.toBeUndefined();
    const claimRecord = await state.read(
      (database) =>
        database.exec(
          "SELECT operation, client_user_message_id, outcome FROM queue_consumption_claims WHERE queue_item_id = 'old-restored'",
        )[0]?.values[0],
    );
    expect(claimRecord).toEqual([
      "legacy",
      "operation-old-restored",
      "indeterminate",
    ]);
    expect(JSON.stringify(claimRecord)).not.toContain(
      "PRIVATE OLD ACCEPTED CONTENT",
    );
    await dispatcher.close();
  });

  it.each(["permission persistence", "claim completion"] as const)(
    "keeps a verified turn indeterminate when %s fails",
    async (failure) => {
      directory = await mkdtemp(join(tmpdir(), "ce-queue-post-start-"));
      const workspacePath = join(directory, "workspace");
      await mkdir(workspacePath);
      state = await HostStateStore.open(join(directory, "state.sqlite"));
      const queue = new QueueRegistry(state);
      const workspaces = new WorkspaceRegistry(state);
      const threadPermissions = new ThreadPermissionRegistry(state);
      await workspaces.add(workspacePath);
      const item = await queue.add({
        workspacePath,
        threadId: "thread-1",
        turnPayload: {
          clientUserMessageId: `operation-${failure}`,
          input: [{ type: "text", text: "next" }],
          ...(failure === "permission persistence"
            ? { approvalPolicy: "never" }
            : {}),
        },
      });
      if (failure === "permission persistence") {
        vi.spyOn(threadPermissions, "saveSettingsUpdate").mockRejectedValueOnce(
          new Error("injected permission persistence failure"),
        );
      } else {
        vi.spyOn(queue, "completeConsumption").mockRejectedValueOnce(
          new Error("injected claim completion failure"),
        );
      }
      let turnStarts = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "thread/read" || method === "thread/resume") {
          return {
            thread: {
              id: "thread-1",
              cwd: workspacePath,
              status: { type: "idle" },
            },
          };
        }
        if (method === "turn/start") {
          turnStarts += 1;
          return { turn: { id: "turn-accepted" } };
        }
        if (method === "thread/unsubscribe") {
          return { status: "unsubscribed" };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { client } = fakeClient(request);
      const dispatcher = new QueueDispatcher({
        queue,
        workspaces,
        threadPermissions,
        connectClient: async () => client,
      });

      await dispatcher.start();

      expect(turnStarts).toBe(1);
      await expect(queue.get(item.id)).resolves.toMatchObject({
        status: "indeterminate",
      });
      await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
      await dispatcher.close();
    },
  );
});

function fakeClient(
  request: (method: string, params?: unknown) => Promise<unknown>,
): {
  client: CodexAppServerClient;
  notify(notification: { method: string; params: unknown }): void;
  requestServer(request: CodexServerRequest): void;
} {
  const emitter = new EventEmitter() as EventEmitter & {
    closed: boolean;
    request: typeof request;
    close(): Promise<void>;
  };
  emitter.closed = false;
  emitter.request = request;
  emitter.close = async () => {
    if (emitter.closed) return;
    emitter.closed = true;
    emitter.emit("close");
  };
  return {
    client: emitter as unknown as CodexAppServerClient,
    notify: (notification) => emitter.emit("notification", notification),
    requestServer: (request) => emitter.emit("serverRequest", request),
  };
}
