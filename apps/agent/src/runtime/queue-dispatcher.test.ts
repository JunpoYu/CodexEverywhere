import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueRegistry } from "../host/queue.js";
import { HostStateStore } from "../host/state-store.js";
import { WorkspaceRegistry } from "../host/workspaces.js";
import type { CodexAppServerClient } from "./codex-app-server-client.js";
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
    await workspaces.add(workspacePath);
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
      connectClient: async () => client,
    });
    const events: string[] = [];
    dispatcher.onEvent((event) => events.push(event.type));

    await dispatcher.start();

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
});

function fakeClient(
  request: (method: string, params?: unknown) => Promise<unknown>,
): {
  client: CodexAppServerClient;
  notify(notification: { method: string; params: unknown }): void;
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
  };
}
