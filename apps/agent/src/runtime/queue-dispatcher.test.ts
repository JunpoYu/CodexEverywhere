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
import { QueueDispatcher } from "./queue-dispatcher.js";

describe("QueueDispatcher", () => {
  let directory: string | undefined;
  let state: HostStateStore | undefined;

  afterEach(async () => {
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
      turnPayload: { input: [{ type: "text", text: "next" }] },
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
    dispatcher.onEvent((event) => events.push(event.type));

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
    });
    expect(await queue.get(item.id)).toMatchObject({ status: "done" });
    expect(events).toContain("queue/started");
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
