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
      turnPayload: {
        input: [{ type: "text", text: "urgent context" }],
        clientUserMessageId: "operation-steer-1",
      },
    });

    const httpServer = createServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    let sendToClient: ((value: unknown) => void) | undefined;
    let threadReads = 0;
    let steerPayload: Record<string, unknown> | undefined;
    const turnStartPayloads: Record<string, unknown>[] = [];
    let unsubscribePayload: Record<string, unknown> | undefined;
    let initializePayload: Record<string, unknown> | undefined;
    let threadListPayload: Record<string, unknown> | undefined;
    let threadResumePayload: Record<string, unknown> | undefined;
    let delayNextResume = false;
    let delayedResumeMessage: Record<string, unknown> | undefined;
    let revokedServerRequestResponse: Record<string, unknown> | undefined;
    let revisionFailureResponse: Record<string, unknown> | undefined;
    const slashMethodPayloads = new Map<string, unknown>();
    const settingsUpdatePayloads: unknown[] = [];
    const sendResumeResponse = (message: Record<string, unknown>) => {
      sendToClient?.({
        id: message.id,
        result: {
          thread: {
            id: "thread-1",
            cwd: workspacePath,
            status: { type: "idle" },
            turns: [],
          },
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
        },
      });
    };
    httpServer.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (socket) => {
      sendToClient = (value) => socket.send(JSON.stringify(value));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (
          message.method === undefined &&
          message.id === "approval-after-revocation"
        ) {
          revokedServerRequestResponse = message;
        } else if (
          message.method === undefined &&
          message.id === "approval-after-revision-failure"
        ) {
          revisionFailureResponse = message;
        } else if (message.method === "initialize") {
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
          if (delayNextResume) {
            delayNextResume = false;
            delayedResumeMessage = message;
          } else {
            sendResumeResponse(message);
          }
        } else if (message.method === "turn/steer") {
          steerPayload = message.params as Record<string, unknown>;
          sendToClient?.({
            id: message.id,
            result: { turnId: "turn-1" },
          });
        } else if (message.method === "turn/start") {
          turnStartPayloads.push(message.params as Record<string, unknown>);
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
          const forkParams = message.params as Record<string, unknown>;
          sendToClient?.({
            id: message.id,
            result: {
              thread: {
                id: "thread-fork",
                cwd: workspacePath,
                status: { type: "idle" },
                turns: [],
                forkedFromId: "thread-1",
                ephemeral: forkParams.ephemeral === true,
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
          if (message.method === "thread/settings/update") {
            settingsUpdatePayloads.push(message.params);
          }
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
    const resumed = await session.request({
      version: PROTOCOL_VERSION,
      requestId: "resume-1",
      idempotencyKey: "resume-1",
      method: "thread/resume",
      payload: { threadId: "thread-1" },
    });
    expect(resumed).toMatchObject({
      thread: { id: "thread-1" },
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(threadResumePayload).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    const eventCountBeforeRevisionFailure = events.length;
    const failedNotificationRevision = vi
      .spyOn(workspaces, "authorizationRevision")
      .mockRejectedValueOnce(new Error("transient state reload failure"));
    sendToClient?.({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-revision-failure",
        itemId: "item-revision-failure",
        delta: "must be dropped safely",
      },
    });
    await vi.waitFor(() =>
      expect(failedNotificationRevision).toHaveBeenCalled(),
    );
    expect(events).toHaveLength(eventCountBeforeRevisionFailure);
    failedNotificationRevision.mockRestore();

    const failedRequestRevision = vi
      .spyOn(workspaces, "authorizationRevision")
      .mockRejectedValueOnce(new Error("transient state reload failure"));
    sendToClient?.({
      id: "approval-after-revision-failure",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-revision-failure",
        itemId: "item-revision-failure",
      },
    });
    await vi.waitFor(() =>
      expect(revisionFailureResponse).toMatchObject({
        id: "approval-after-revision-failure",
        error: { message: "Unable to verify workspace authorization" },
      }),
    );
    expect(failedRequestRevision).toHaveBeenCalled();
    failedRequestRevision.mockRestore();
    expect(slashMethodPayloads.get("thread/settings/update")).toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
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
          approvalPolicy: "untrusted",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      }),
    ).resolves.toEqual({});
    expect(slashMethodPayloads.get("thread/settings/update")).toEqual({
      threadId: "thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    await expect(threadPermissions.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
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
    // Broadcast settings notifications have no server revision and may arrive
    // out of order on independent Gateway/TUI connections. They are forwarded
    // to the UI but cannot overwrite the causally persisted explicit request.
    await expect(threadPermissions.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
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
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      updatedAt: expect.any(String),
    });

    await threadPermissions.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    const settingsUpdatesBeforeRacingResume = settingsUpdatePayloads.length;
    delayNextResume = true;
    const racingResume = session.request({
      version: PROTOCOL_VERSION,
      requestId: "resume-racing-notification",
      idempotencyKey: "resume-racing-notification",
      method: "thread/resume",
      payload: { threadId: "thread-1" },
    });
    await vi.waitFor(() => expect(delayedResumeMessage).toBeDefined());
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
    await expect(threadPermissions.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    const racingUpdate = session.request({
      version: PROTOCOL_VERSION,
      requestId: "settings-after-racing-resume",
      idempotencyKey: "settings-after-racing-resume",
      method: "thread/settings/update",
      payload: {
        threadId: "thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settingsUpdatePayloads).toHaveLength(
      settingsUpdatesBeforeRacingResume,
    );
    const delayed = delayedResumeMessage;
    if (!delayed) throw new Error("Expected a delayed resume request");
    delayedResumeMessage = undefined;
    sendResumeResponse(delayed);
    await expect(racingResume).resolves.toMatchObject({
      thread: { id: "thread-1" },
    });
    await expect(racingUpdate).resolves.toEqual({});
    expect(settingsUpdatePayloads).toHaveLength(
      settingsUpdatesBeforeRacingResume + 2,
    );
    await expect(threadPermissions.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "read-only",
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
    const readsBeforeDeltas = threadReads;
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

    expect(threadReads).toBe(readsBeforeDeltas);
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
      clientUserMessageId: "operation-steer-1",
    });
    expect(await queue.get(queued.id)).toMatchObject({ status: "done" });

    const unresolved = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-unresolved",
        input: [{ type: "text", text: "possibly accepted" }],
      },
    });
    const following = await queue.add({
      workspacePath,
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-after-ack",
        input: [{ type: "text", text: "safe next message" }],
      },
    });
    const unresolvedClaim = await queue.claimNext("thread-1");
    if (!unresolvedClaim) throw new Error("Expected unresolved queue claim");
    await queue.beginConsumption(unresolvedClaim, "turn/start");
    await queue.markConsumptionIndeterminate(unresolvedClaim, "turn/start");
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    const removeAfterPublish = queue.remove.bind(queue);
    vi.spyOn(queue, "remove").mockImplementationOnce(async (id, options) => {
      expect(await removeAfterPublish(id, options)).toBe(true);
      throw new Error("injected remove post-publication durability failure");
    });

    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "queue-ack-1",
        idempotencyKey: "queue-ack-1",
        method: "queue/remove",
        payload: {
          id: unresolved.id,
          acknowledgeIndeterminate: true,
        },
      }),
    ).rejects.toThrow("remove post-publication durability failure");
    await vi.waitFor(async () => {
      expect(await queue.get(following.id)).toMatchObject({ status: "done" });
    });
    expect(turnStartPayloads).toContainEqual({
      input: [{ type: "text", text: "safe next message" }],
      threadId: "thread-1",
      clientUserMessageId: "operation-after-ack",
    });

    const addAfterPublish = queue.add.bind(queue);
    vi.spyOn(queue, "add").mockImplementationOnce(async (input) => {
      await addAfterPublish(input);
      throw new Error("injected add post-publication durability failure");
    });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "queue-add-post-publish",
        idempotencyKey: "queue-add-post-publish",
        method: "queue/add",
        payload: {
          threadId: "thread-1",
          clientUserMessageId: "operation-add-post-publish",
          input: [{ type: "text", text: "published despite error" }],
        },
      }),
    ).rejects.toThrow("add post-publication durability failure");
    await vi.waitFor(() =>
      expect(turnStartPayloads).toContainEqual({
        input: [{ type: "text", text: "published despite error" }],
        threadId: "thread-1",
        clientUserMessageId: "operation-add-post-publish",
      }),
    );
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
        payload: { threadId: "thread-1", ephemeral: true },
      }),
    ).resolves.toMatchObject({ thread: { id: "thread-fork" } });
    await expect(threadPermissions.read("thread-fork")).resolves.toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "side-unsubscribe",
        idempotencyKey: "side-unsubscribe",
        method: "thread/unsubscribe",
        payload: { threadId: "thread-fork" },
      }),
    ).resolves.toEqual({ status: "unsubscribed" });
    await expect(
      threadPermissions.read("thread-fork"),
    ).resolves.toBeUndefined();

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

    sendToClient?.({
      id: "approval-after-revocation",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-before-revocation",
        itemId: "item-before-revocation",
      },
    });
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: "codex/serverRequest",
        payload: { requestId: "approval-after-revocation" },
      }),
    );
    await workspaces.remove(workspacePath);
    await expect(
      session.request({
        version: PROTOCOL_VERSION,
        requestId: "respond-after-revocation",
        idempotencyKey: "respond-after-revocation",
        method: "codex/server-request/respond",
        payload: {
          requestId: "approval-after-revocation",
          result: { decision: "accept" },
        },
      }),
    ).rejects.toThrow("Workspace authorization was revoked");
    await vi.waitFor(() =>
      expect(revokedServerRequestResponse).toMatchObject({
        id: "approval-after-revocation",
        error: { message: "Workspace authorization was revoked" },
      }),
    );
    const eventCountBeforeRevocation = events.length;
    const readsBeforeRevokedDelta = threadReads;
    sendToClient?.({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-after-revocation",
        itemId: "item-after-revocation",
        delta: "must not escape",
      },
    });
    await vi.waitFor(() =>
      expect(threadReads).toBe(readsBeforeRevokedDelta + 1),
    );
    expect(events).toHaveLength(eventCountBeforeRevocation);

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
