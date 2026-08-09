import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROTOCOL_VERSION,
  type EventEnvelope,
} from "@codex-everywhere/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { HostStateStore } from "../host/state-store.js";
import { QueueRegistry } from "../host/queue.js";
import { ThreadPermissionRegistry } from "../host/thread-permissions.js";
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
    const threadPermissions = new ThreadPermissionRegistry(state);
    await threadPermissions.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
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
    let initializePayload: Record<string, unknown> | undefined;
    let threadListPayload: Record<string, unknown> | undefined;
    let threadResumePayload: Record<string, unknown> | undefined;
    const slashMethodPayloads = new Map<string, unknown>();
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
          initializePayload = message.params as Record<string, unknown>;
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
        } else if (message.method === "thread/list") {
          threadListPayload = message.params as Record<string, unknown>;
          sendToClient?.({
            id: message.id,
            result: {
              data: [
                { id: "thread-1", cwd: workspacePath },
                { id: "thread-2", cwd: childWorkspacePath },
                { id: "thread-outside", cwd: directory },
              ],
              nextCursor: null,
            },
          });
        } else if (message.method === "thread/resume") {
          threadResumePayload = message.params as Record<string, unknown>;
          sendToClient?.({
            id: message.id,
            result: {
              thread: {
                id: "thread-1",
                cwd: workspacePath,
                status: { type: "idle" },
                turns: [],
              },
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
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
        } else if (message.method === "thread/fork") {
          slashMethodPayloads.set(message.method, message.params);
          sendToClient?.({
            id: message.id,
            result: {
              thread: {
                id: "thread-fork",
                cwd: workspacePath,
                status: { type: "idle" },
                turns: [],
              },
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: { type: "dangerFullAccess" },
            },
          });
        } else if (
          [
            "thread/compact/start",
            "thread/goal/set",
            "thread/goal/get",
            "thread/goal/clear",
            "review/start",
            "skills/list",
            "mcpServerStatus/list",
            "account/rateLimits/read",
            "account/usage/read",
            "thread/settings/update",
            "thread/turns/list",
          ].includes(String(message.method))
        ) {
          slashMethodPayloads.set(String(message.method), message.params);
          sendToClient?.({ id: message.id, result: {} });
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
      threadPermissions,
      nodeStatus: () => ({}),
    });
    const events: EventEnvelope[] = [];
    session.onEvent((event) => events.push(event));
    expect(initializePayload).toMatchObject({
      capabilities: { experimentalApi: true },
    });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "resume-1",
        idempotencyKey: "resume-1",
        method: "thread/resume",
        payload: { threadId: "thread-1" },
      }),
    ).resolves.toMatchObject({ thread: { id: "thread-1" } });
    expect(threadResumePayload).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    await session.request({
      version: PROTOCOL_VERSION,
      requestId: "resume-explicit",
      idempotencyKey: "resume-explicit",
      method: "thread/resume",
      payload: {
        threadId: "thread-1",
        approvalPolicy: "on-request",
        sandbox: "read-only",
      },
    });
    expect(threadResumePayload).toEqual({
      threadId: "thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    await session.request({
      version: PROTOCOL_VERSION,
      requestId: "read-1",
      idempotencyKey: "read-1",
      method: "thread/read",
      payload: { threadId: "thread-1", includeTurns: true },
    });
    await session.request({
      version: PROTOCOL_VERSION,
      requestId: "turns-1",
      idempotencyKey: "turns-page-1",
      method: "thread/turns/list",
      payload: {
        threadId: "thread-1",
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      },
    });
    expect(slashMethodPayloads.get("thread/turns/list")).toEqual({
      threadId: "thread-1",
      limit: 20,
      sortDirection: "desc",
      itemsView: "full",
    });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "settings-1",
        idempotencyKey: "settings-1",
        method: "thread/settings/update",
        payload: {
          threadId: "thread-1",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      }),
    ).resolves.toEqual({});
    expect(slashMethodPayloads.get("thread/settings/update")).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    sendToClient?.({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(threadPermissions.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "read-only",
    });
    expect(events.at(-1)).toMatchObject({
      type: "codex/thread/settings/updated",
      payload: {
        threadId: "thread-1",
        threadSettings: {
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      },
    });
    sendToClient?.({
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          approvalPolicy: "future-policy",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "externalSandbox",
            networkAccess: "restricted",
          },
        },
      },
    });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "codex/thread/settings/updated",
        payload: {
          threadSettings: { approvalPolicy: "future-policy" },
        },
      }),
    );
    await expect(threadPermissions.read("thread-1")).resolves.toEqual({
      approvalsReviewer: "user",
      updatedAt: expect.any(String),
    });
    events.length = 0;
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
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "list-1",
        idempotencyKey: "list-1",
        method: "thread/list",
        payload: { limit: 100, useStateDbOnly: true },
      }),
    ).resolves.toMatchObject({
      data: [{ id: "thread-1" }, { id: "thread-2" }],
      nextCursor: null,
    });
    expect(threadListPayload).toEqual({
      limit: 100,
      useStateDbOnly: true,
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

    expect(threadReads).toBe(5);
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

    for (const [index, method] of [
      "thread/compact/start",
      "thread/goal/set",
      "thread/goal/get",
      "thread/goal/clear",
      "review/start",
    ].entries()) {
      await expect(
        session.request({
          version: PROTOCOL_VERSION,
          requestId: `slash-${index}`,
          idempotencyKey: `slash-${index}`,
          method,
          payload: { threadId: "thread-1" },
        }),
      ).resolves.toEqual({});
      expect(slashMethodPayloads.get(method)).toEqual({
        threadId: "thread-1",
      });
    }

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "slash-fork",
        idempotencyKey: "slash-fork",
        method: "thread/fork",
        payload: { threadId: "thread-1" },
      }),
    ).resolves.toMatchObject({ thread: { id: "thread-fork" } });

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "slash-skills",
        idempotencyKey: "slash-skills",
        method: "skills/list",
        payload: { cwds: [childWorkspacePath] },
      }),
    ).resolves.toEqual({});
    expect(slashMethodPayloads.get("skills/list")).toEqual({
      cwds: [await realpath(childWorkspacePath)],
    });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "slash-skills-escape",
        idempotencyKey: "slash-skills-escape",
        method: "skills/list",
        payload: { cwds: [directory] },
      }),
    ).rejects.toThrow("outside registered workspace roots");
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "slash-skills-empty",
        idempotencyKey: "slash-skills-empty",
        method: "skills/list",
        payload: { cwds: [] },
      }),
    ).rejects.toThrow("at least one workspace cwd");

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "slash-fork-escape",
        idempotencyKey: "slash-fork-escape",
        method: "thread/fork",
        payload: { threadId: "thread-1", cwd: directory },
      }),
    ).rejects.toThrow("outside registered workspace roots");

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "slash-mcp",
        idempotencyKey: "slash-mcp",
        method: "mcpServerStatus/list",
        payload: { threadId: "thread-1", detail: "toolsAndAuthOnly" },
      }),
    ).resolves.toEqual({});
    expect(slashMethodPayloads.get("mcpServerStatus/list")).toEqual({
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
    });

    for (const [index, method] of [
      "account/rateLimits/read",
      "account/usage/read",
    ].entries()) {
      await expect(
        session.request({
          version: PROTOCOL_VERSION,
          requestId: `slash-account-${index}`,
          idempotencyKey: `slash-account-${index}`,
          method,
          payload: {},
        }),
      ).resolves.toEqual({});
      expect(slashMethodPayloads.get(method)).toEqual({});
    }

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
