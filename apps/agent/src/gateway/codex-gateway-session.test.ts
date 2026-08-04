import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  type EventEnvelope,
} from "@codex-everywhere/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { HostStateStore } from "../host/state-store.js";
import { QueueRegistry } from "../host/queue.js";
import { WorkspaceRegistry } from "../host/workspaces.js";
import {
  CodexGatewaySession,
  threadNeedsResume,
} from "./codex-gateway-session.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("threadNeedsResume", () => {
  it("resumes disk-backed threads before starting another turn", () => {
    expect(threadNeedsResume({ type: "notLoaded" })).toBe(true);
  });

  it("does not resume an already loaded thread", () => {
    expect(threadNeedsResume({ type: "idle" })).toBe(false);
    expect(threadNeedsResume({ type: "active", activeFlags: [] })).toBe(false);
    expect(threadNeedsResume({ type: "systemError" })).toBe(false);
  });
});

describe("CodexGatewaySession notifications", () => {
  it("forwards deltas immediately after one workspace authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-gateway-events-"));
    temporaryDirectories.push(directory);
    const workspacePath = join(directory, "workspace");
    const childWorkspacePath = join(workspacePath, "child");
    const socketPath = join(directory, "app-server.sock");
    await mkdir(childWorkspacePath, { recursive: true });
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const workspaces = new WorkspaceRegistry(state);
    await workspaces.add(workspacePath);
    const queue = new QueueRegistry(state);
    const queued = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "urgent context" }] },
    });

    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    let sendToClient: ((value: unknown) => void) | undefined;
    let threadReads = 0;
    let steerPayload: Record<string, unknown> | undefined;
    let unsubscribePayload: Record<string, unknown> | undefined;
    httpServer.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (socket) => {
      sendToClient = (value) => socket.send(JSON.stringify(value));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.method === "initialize") {
          sendToClient?.({ id: message.id, result: {} });
        } else if (message.method === "thread/read") {
          threadReads += 1;
          sendToClient?.({
            id: message.id,
            result: {
              thread: {
                id: "thread-1",
                cwd: workspacePath,
                status: { type: "idle" },
                turns: [],
              },
            },
          });
        } else if (message.method === "turn/steer") {
          steerPayload = message.params as Record<string, unknown>;
          sendToClient?.({
            id: message.id,
            result: { turnId: "turn-1" },
          });
        } else if (message.method === "turn/start") {
          sendToClient?.({
            id: message.id,
            result: { turn: { id: "turn-2" } },
          });
        } else if (message.method === "thread/unsubscribe") {
          unsubscribePayload = message.params as Record<string, unknown>;
          sendToClient?.({
            id: message.id,
            result: { status: "unsubscribed" },
          });
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(socketPath, resolve);
    });

    const session = await CodexGatewaySession.connect({
      socketPath,
      workspaces,
      queue,
      nodeStatus: () => ({}),
    });
    const events: EventEnvelope[] = [];
    session.onEvent((event) => events.push(event));
    await session.request({
      version: PROTOCOL_VERSION,
      requestId: "read-1",
      idempotencyKey: "read-1",
      method: "thread/read",
      payload: { threadId: "thread-1", includeTurns: true },
    });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "browse-1",
        idempotencyKey: "browse-1",
        method: "workspace/browse",
        payload: { path: workspacePath },
      }),
    ).resolves.toMatchObject({
      path: await realpath(workspacePath),
      directories: [
        { name: "child", path: await realpath(childWorkspacePath) },
      ],
    });
    for (const delta of ["A", "B", "C"]) {
      sendToClient?.({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta,
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(threadReads).toBe(1);
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ delta: "A" }),
      expect.objectContaining({ delta: "B" }),
      expect.objectContaining({ delta: "C" }),
    ]);

    sendToClient?.({
      method: "account/login/completed",
      params: { loginId: "login-1", success: true, error: null },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events.at(-1)).toMatchObject({
      type: "codex/account/login/completed",
      payload: { loginId: "login-1", success: true, error: null },
    });

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "turn-image",
        idempotencyKey: "turn-image",
        method: "turn/start",
        payload: {
          threadId: "thread-1",
          input: [{ type: "localImage", path: "/etc/passwd" }],
        },
      }),
    ).rejects.toThrow("Image attachments are not supported");
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "queue-image",
        idempotencyKey: "queue-image",
        method: "queue/add",
        payload: {
          threadId: "thread-1",
          input: [{ type: "localImage", path: "/etc/passwd" }],
        },
      }),
    ).rejects.toThrow("Image attachments are not supported");

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "steer-1",
        idempotencyKey: "steer-1",
        method: "queue/steer",
        payload: { id: queued.id, expectedTurnId: "turn-1" },
      }),
    ).resolves.toEqual({ itemId: queued.id, turnId: "turn-1" });
    expect(steerPayload).toEqual({
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "urgent context" }],
    });
    expect(await queue.get(queued.id)).toMatchObject({ status: "done" });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "unsubscribe-1",
        idempotencyKey: "unsubscribe-1",
        method: "thread/unsubscribe",
        payload: { threadId: "thread-1" },
      }),
    ).resolves.toEqual({ status: "unsubscribed" });
    expect(unsubscribePayload).toEqual({ threadId: "thread-1" });

    await session.close();
    await new Promise<void>((resolve, reject) =>
      webSocketServer.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    await state.close();
  });
});
