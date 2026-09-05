import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { UserStateDatabase } from "../v2/repositories/user-state-database.js";
import {
  startTuiPermissionProxy,
  stripResumePermissionOverrides,
  tuiV4ThreadPermissionOptions,
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
    let runtimeAcquisitions = 0;
    let runtimeReleases = 0;
    const runtimeDepthsAtUpstream: number[] = [];
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
        if (
          message.method === "thread/start" ||
          message.method === "thread/compact/start" ||
          message.method === "turn/start" ||
          message.method === "review/start"
        ) {
          runtimeDepthsAtUpstream.push(runtimeAcquisitions - runtimeReleases);
        }
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

    const state = await UserStateDatabase.open(
      join(directory, "state.sqlite"),
      {
        create: true,
      },
    );
    const repository = state.threadSettings;
    await repository.saveObserved("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    const permissionOptions = tuiV4ThreadPermissionOptions(repository);
    const proxy = await startTuiPermissionProxy({
      upstreamSocketPath,
      runtimeDir: directory,
      ...permissionOptions,
      acquireRuntimeMutation: async () => {
        runtimeAcquisitions += 1;
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            runtimeReleases += 1;
          },
        };
      },
      onThreadPermissions: async (observation, causalObservation) => {
        observations.push(observation);
        await permissionOptions.onThreadPermissions!(
          observation,
          causalObservation,
        );
      },
    });
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: proxy.socketPath }),
      perMessageDeflate: false,
    });
    await waitForOpen(client);

    const firstResume = await sendAndWait(client, resumeRequest(1, "never"));
    const secondResume = await sendAndWait(
      client,
      resumeRequest(2, "on-request"),
    );
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
    await sendAndWait(
      client,
      JSON.stringify({
        id: 5,
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
        },
      }),
    );
    await sendAndWait(
      client,
      JSON.stringify({
        id: 6,
        method: "review/start",
        params: {
          threadId: "thread-1",
          target: { type: "uncommittedChanges" },
        },
      }),
    );
    await sendAndWait(
      client,
      JSON.stringify({
        id: 7,
        method: "thread/compact/start",
        params: { threadId: "thread-1" },
      }),
    );

    expect(
      upstreamMessages
        .filter((message) => message.method === "thread/resume")
        .map(permissionFields),
    ).toEqual([
      { id: 1, approvalPolicy: "never", sandbox: "danger-full-access" },
      { id: 2, approvalPolicy: "never", sandbox: "danger-full-access" },
    ]);
    expect(
      upstreamMessages
        .filter(
          (message) =>
            message.method === "thread/settings/update" &&
            typeof message.id === "string" &&
            message.id.startsWith("ce-tui-permission-repair:"),
        )
        .map(permissionFields),
    ).toEqual([
      {
        id: expect.any(String),
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
      {
        id: expect.any(String),
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
    ]);
    expect(
      upstreamMessages
        .filter(
          (message) =>
            message.method !== "thread/resume" &&
            !(typeof message.id === "string"),
        )
        .map(permissionFields),
    ).toEqual([
      {
        id: 3,
        approvalPolicy: "on-request",
        sandbox: { type: "readOnly", networkAccess: false },
      },
      { id: 4, approvalPolicy: "on-request", sandbox: "read-only" },
      { id: 5, approvalPolicy: undefined, sandbox: undefined },
      { id: 6, approvalPolicy: undefined, sandbox: undefined },
      { id: 7, approvalPolicy: undefined, sandbox: undefined },
    ]);
    expect(firstResume.result).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
    });
    expect(secondResume.result).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
    });
    expect(observations).toEqual([
      {
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      {
        threadId: "thread-1",
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      {
        threadId: "thread-1",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      {
        threadId: "thread-new",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    ]);
    expect(runtimeAcquisitions).toBe(4);
    expect(runtimeReleases).toBe(4);
    expect(runtimeDepthsAtUpstream).toEqual([1, 1, 1, 1]);
    await expect(
      repository.applyToResume({ threadId: "thread-1" }),
    ).resolves.toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "read-only",
    });
    await expect(
      repository.applyToResume({ threadId: "thread-new" }),
    ).resolves.toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "read-only",
    });
    await sendAndWait(
      client,
      JSON.stringify({
        id: 8,
        method: "thread/delete",
        params: { threadId: "thread-new" },
      }),
    );
    await expect(
      repository.applyToResume({ threadId: "thread-new" }),
    ).resolves.toEqual({ threadId: "thread-new" });

    client.terminate();
    await proxy.close();
    await state.close();
    await closeServer(upstreamServer);
    upstreamWebSockets.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("fails closed on duplicate in-flight ids and awaits pending lock release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-tui-proxy-test-"));
    const upstreamSocketPath = join(directory, "upstream.sock");
    const upstreamServer = createServer();
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    let firstRequest!: () => void;
    const firstRequestReceived = new Promise<void>((resolve) => {
      firstRequest = resolve;
    });
    upstreamServer.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        upstreamWebSockets.emit("connection", webSocket, request);
      });
    });
    upstreamWebSockets.on("connection", (socket) => {
      socket.once("message", () => firstRequest());
    });
    await listen(upstreamServer, upstreamSocketPath);

    let releaseLock!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let releaseStarted!: () => void;
    const releaseWasStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let releases = 0;
    const proxy = await startTuiPermissionProxy({
      upstreamSocketPath,
      runtimeDir: directory,
      beginThreadPermissionObservation: async () => ({
        generation: 1,
        observedAt: new Date().toISOString(),
      }),
      acquireThreadPermissionMutation: async () => ({
        release: async () => {
          releaseStarted();
          await releaseGate;
          releases += 1;
        },
      }),
    });
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: proxy.socketPath }),
      perMessageDeflate: false,
    });
    await waitForOpen(client);
    client.send(resumeRequest(7, "never"));
    await firstRequestReceived;
    const clientClosed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );
    client.send(resumeRequest(7, "never"));
    await clientClosed;
    await releaseWasStarted;

    let closeSettled = false;
    const closing = proxy.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closeSettled).toBe(false);
    releaseLock();
    await closing;
    expect(releases).toBe(1);

    await closeServer(upstreamServer);
    upstreamWebSockets.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("closes promptly while a real permission lock acquisition is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-tui-proxy-test-"));
    const upstreamSocketPath = join(directory, "upstream.sock");
    const upstreamServer = createServer();
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    let upstreamRequests = 0;
    upstreamServer.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        upstreamWebSockets.emit("connection", webSocket, request);
      });
    });
    upstreamWebSockets.on("connection", (socket) => {
      socket.on("message", () => {
        upstreamRequests += 1;
      });
    });
    await listen(upstreamServer, upstreamSocketPath);

    const statePath = join(directory, "state.sqlite");
    const ownerState = await UserStateDatabase.open(statePath, {
      create: true,
    });
    const tuiState = await UserStateDatabase.open(statePath);
    const heldLease =
      await ownerState.threadSettings.acquireMutation("thread-1");
    const permissionOptions = tuiV4ThreadPermissionOptions(
      tuiState.threadSettings,
    );
    let acquisitionStarted!: () => void;
    const acquisitionWasStarted = new Promise<void>((resolve) => {
      acquisitionStarted = resolve;
    });
    const proxy = await startTuiPermissionProxy({
      upstreamSocketPath,
      runtimeDir: directory,
      ...permissionOptions,
      acquireThreadPermissionMutation: (threadId, options) => {
        acquisitionStarted();
        return permissionOptions.acquireThreadPermissionMutation!(
          threadId,
          options,
        );
      },
    });
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: proxy.socketPath }),
      perMessageDeflate: false,
    });
    await waitForOpen(client);
    client.send(resumeRequest(10, "never"));
    await acquisitionWasStarted;

    await expect(settlesWithin(proxy.close(), 1_000)).resolves.toBeUndefined();
    expect(upstreamRequests).toBe(0);

    await heldLease.release();
    await tuiState.close();
    await ownerState.close();
    await closeServer(upstreamServer);
    upstreamWebSockets.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("retries explicit settings persistence under the lock and surfaces failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-tui-proxy-test-"));
    const upstreamSocketPath = join(directory, "upstream.sock");
    const upstreamServer = createServer();
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    upstreamServer.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        upstreamWebSockets.emit("connection", webSocket, request);
      });
    });
    upstreamWebSockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      });
    });
    await listen(upstreamServer, upstreamSocketPath);

    const events: string[] = [];
    const observed: Array<Record<string, unknown>> = [];
    const proxy = await startTuiPermissionProxy({
      upstreamSocketPath,
      runtimeDir: directory,
      beginThreadPermissionObservation: async () => ({
        generation: 1,
        observedAt: new Date().toISOString(),
      }),
      acquireThreadPermissionMutation: async () => ({
        release: async () => {
          events.push("release");
        },
      }),
      onThreadPermissions: async (observation) => {
        events.push("persist");
        observed.push(observation);
        throw new Error("state unavailable");
      },
    });
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: proxy.socketPath }),
      perMessageDeflate: false,
    });
    await waitForOpen(client);
    const response = await sendAndWait(
      client,
      JSON.stringify({
        id: 8,
        method: "thread/settings/update",
        params: {
          threadId: "thread-1",
          approvalPolicy: "never",
          approvalsReviewer: null,
          sandboxPolicy: null,
        },
      }),
    );

    expect(response).toMatchObject({
      id: 8,
      error: { message: expect.stringContaining("state unavailable") },
    });
    expect(events).toEqual(["persist", "persist", "release"]);
    expect(observed).toEqual([
      { threadId: "thread-1", approvalPolicy: "never" },
      { threadId: "thread-1", approvalPolicy: "never" },
    ]);

    client.terminate();
    await proxy.close();
    await closeServer(upstreamServer);
    upstreamWebSockets.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("closes an ambiguous repair timeout before releasing its lock once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-tui-proxy-test-"));
    const upstreamSocketPath = join(directory, "upstream.sock");
    const upstreamServer = createServer();
    const upstreamWebSockets = new WebSocketServer({ noServer: true });
    const upstreamMethods: unknown[] = [];
    upstreamServer.on("upgrade", (request, socket, head) => {
      upstreamWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        upstreamWebSockets.emit("connection", webSocket, request);
      });
    });
    upstreamWebSockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        upstreamMethods.push(message.method);
        if (message.method === "thread/resume") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: {
                thread: { id: "thread-1" },
                approvalPolicy: "on-request",
              },
            }),
          );
        }
        // Intentionally leave the internal settings/update outcome unknown.
      });
    });
    await listen(upstreamServer, upstreamSocketPath);

    let releases = 0;
    const proxy = await startTuiPermissionProxy({
      upstreamSocketPath,
      runtimeDir: directory,
      internalRepairTimeoutMs: 30,
      prepareThreadResume: (params) => ({
        ...params,
        approvalPolicy: "never",
      }),
      repairThreadResume: (_requested, response) => ({
        update: { approvalPolicy: "never" },
        response: { ...response, approvalPolicy: "never" },
      }),
      beginThreadPermissionObservation: async () => ({
        generation: 1,
        observedAt: new Date().toISOString(),
      }),
      claimThreadPermissionRepair: async () => ({
        generation: 2,
        observedAt: new Date().toISOString(),
      }),
      acquireThreadPermissionMutation: async () => ({
        release: async () => {
          releases += 1;
        },
      }),
    });
    const client = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: proxy.socketPath }),
      perMessageDeflate: false,
    });
    await waitForOpen(client);
    const clientClosed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );
    client.send(resumeRequest(9, "never"));
    await clientClosed;
    await proxy.close();

    expect(upstreamMethods).toEqual([
      "thread/resume",
      "thread/settings/update",
    ]);
    expect(releases).toBe(1);
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

function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Operation did not settle within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
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

async function sendAndWait(
  socket: WebSocket,
  message: string,
): Promise<Record<string, unknown>> {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once("message", (raw) => {
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    });
    socket.once("error", reject);
  });
  socket.send(message);
  return response;
}
