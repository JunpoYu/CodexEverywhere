import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  startTuiPermissionProxy,
  stripResumePermissionOverrides,
} from "./tui-permission-proxy.js";

describe("TUI permission inheritance proxy", () => {
  it("removes only implicit permission fields from bootstrap resume", () => {
    const result = stripResumePermissionOverrides(
      Buffer.from(
        JSON.stringify({
          id: 7,
          method: "thread/resume",
          params: {
            threadId: "thread-1",
            cwd: "/workspace",
            model: "gpt-5.4",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "danger-full-access",
            permissions: "full-access",
            config: {
              approval_policy: "never",
              sandbox_mode: "danger-full-access",
              model_reasoning_effort: "high",
            },
          },
        }),
      ),
      false,
    );

    expect(JSON.parse(result!.data)).toEqual({
      id: 7,
      method: "thread/resume",
      params: {
        threadId: "thread-1",
        cwd: "/workspace",
        model: "gpt-5.4",
        config: { model_reasoning_effort: "high" },
      },
    });
  });

  it("protects every resume while explicit settings updates pass through", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-tui-proxy-test-"));
    const upstreamSocketPath = join(directory, "upstream.sock");
    const upstreamMessages: Array<Record<string, unknown>> = [];
    const observations: Array<Record<string, unknown>> = [];
    let upstreamClient: WebSocket | undefined;
    const upstreamServer = createServer();
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    upstreamServer.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        upstreamWebSockets.emit("connection", webSocket, request);
      });
    });
    upstreamWebSockets.on("connection", (socket) => {
      upstreamClient = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        upstreamMessages.push(message);
        if (message.id !== undefined) {
          const threadId =
            message.method === "thread/start" ? "thread-new" : "thread-1";
          socket.send(
            JSON.stringify({
              id: message.id,
              result:
                message.method === "thread/start" ||
                message.method === "thread/resume"
                  ? {
                      thread: { id: threadId },
                      approvalPolicy: "on-request",
                      approvalsReviewer: "user",
                      sandbox: {
                        type: "readOnly",
                        networkAccess: false,
                      },
                    }
                  : {},
            }),
          );
        }
      });
    });
    await listen(upstreamServer, upstreamSocketPath);

    const proxy = await startTuiPermissionProxy({
      upstreamSocketPath,
      runtimeDir: directory,
      prepareThreadResume: (params) => ({
        ...params,
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandbox: "read-only",
      }),
      onThreadPermissions: (observation) => {
        observations.push(observation);
      },
    });
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: proxy.socketPath }),
      perMessageDeflate: false,
    });
    await waitForOpen(client);

    await sendAndWait(client, resumeRequest(1, "never"));
    await sendAndWait(client, resumeRequest(2, "on-request"));
    await sendAndWait(
      client,
      JSON.stringify({
        id: 3,
        method: "thread/settings/update",
        params: {
          threadId: "thread-1",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      }),
    );
    const settingsNotification = nextMessage(client);
    upstreamClient?.send(
      JSON.stringify({
        method: "thread/settings/updated",
        params: {
          threadId: "thread-1",
          threadSettings: {
            approvalPolicy: "never",
            approvalsReviewer: "auto_review",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        },
      }),
    );
    await settingsNotification;
    await sendAndWait(
      client,
      JSON.stringify({
        id: 4,
        method: "thread/start",
        params: {
          cwd: "/workspace",
          approvalPolicy: "on-request",
          sandbox: "read-only",
        },
      }),
    );

    expect(upstreamMessages.map(permissionFields)).toEqual([
      { id: 1, approvalPolicy: "never", sandbox: "read-only" },
      { id: 2, approvalPolicy: "never", sandbox: "read-only" },
      {
        id: 3,
        approvalPolicy: "on-request",
        sandbox: { type: "readOnly", networkAccess: false },
      },
      { id: 4, approvalPolicy: "on-request", sandbox: "read-only" },
    ]);
    expect(observations).toEqual([
      {
        threadId: "thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      {
        threadId: "thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      {
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      {
        threadId: "thread-new",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    ]);

    client.terminate();
    await proxy.close();
    await closeServer(upstreamServer);
    upstreamWebSockets.close();
    await rm(directory, { recursive: true, force: true });
  });
});

function resumeRequest(id: number, approvalPolicy: string): string {
  return JSON.stringify({
    id,
    method: "thread/resume",
    params: {
      threadId: "thread-1",
      approvalPolicy,
      sandbox:
        approvalPolicy === "never" ? "danger-full-access" : "workspace-write",
    },
  });
}

function permissionFields(message: Record<string, unknown>): {
  id: unknown;
  approvalPolicy: unknown;
  sandbox: unknown;
} {
  const params = message.params as Record<string, unknown>;
  return {
    id: message.id,
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox ?? params.sandboxPolicy,
  };
}

function listen(server: HttpServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("message", () => resolve());
    socket.once("error", reject);
  });
}

async function sendAndWait(socket: WebSocket, message: string): Promise<void> {
  const response = nextMessage(socket);
  socket.send(message);
  await response;
}
