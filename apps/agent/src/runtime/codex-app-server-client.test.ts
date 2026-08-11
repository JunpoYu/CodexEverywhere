import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  CodexAppServerClient,
  CodexRpcError,
} from "./codex-app-server-client.js";

type Harness = {
  client: CodexAppServerClient;
  httpServer: HttpServer;
  socketDirectory: string;
};

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.client.close();
    await new Promise<void>((resolve, reject) =>
      harness.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(harness.socketDirectory, { recursive: true, force: true });
  }
});

async function createHarness(
  onMessage: (
    message: Record<string, unknown>,
    send: (message: unknown) => void,
  ) => void,
): Promise<Harness> {
  const socketDirectory = await mkdtemp(join(tmpdir(), "ce-rpc-test-"));
  const socketPath = join(socketDirectory, "server.sock");
  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      onMessage(message, (response) => socket.send(JSON.stringify(response)));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(socketPath, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const client = await CodexAppServerClient.connectUnix(socketPath);
  const harness = { client, httpServer, socketDirectory };
  harnesses.push(harness);
  return harness;
}

describe("CodexAppServerClient", () => {
  it("handles a WebSocket opening timeout without an unhandled socket error", async () => {
    const socketDirectory = await mkdtemp(join(tmpdir(), "ce-rpc-timeout-"));
    const socketPath = join(socketDirectory, "server.sock");
    const connections = new Set<Socket>();
    const server = createNetServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      // Accept the Unix connection but never complete the WebSocket upgrade.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      await expect(
        CodexAppServerClient.connectUnix(socketPath, { timeoutMs: 25 }),
      ).rejects.toThrow("Timed out connecting to Codex app-server");
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(socketDirectory, { recursive: true, force: true });
    }
  });

  it("initializes and resolves requests", async () => {
    const methods: string[] = [];
    const { client } = await createHarness((message, send) => {
      methods.push(String(message.method));
      if (message.id !== undefined)
        send({ id: message.id, result: { ok: true } });
    });

    await expect(client.request("thread/list", { limit: 5 })).resolves.toEqual({
      ok: true,
    });
    expect(methods).toEqual(["initialize", "initialized", "thread/list"]);
  });

  it("turns JSON-RPC errors into typed errors", async () => {
    const { client } = await createHarness((message, send) => {
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "thread/read") {
        send({ id: message.id, error: { code: 404, message: "missing" } });
      }
    });

    await expect(
      client.request("thread/read", { threadId: "none" }),
    ).rejects.toMatchObject({
      name: "CodexRpcError",
      code: 404,
      message: "missing",
    } satisfies Partial<CodexRpcError>);
  });

  it("times out one request without closing the app-server connection", async () => {
    const { client } = await createHarness((message, send) => {
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "thread/read") {
        send({ id: message.id, result: { thread: { id: "thread-1" } } });
      }
    });

    await expect(
      client.request("thread/list", {}, { timeoutMs: 10 }),
    ).rejects.toThrow("Timed out waiting for Codex app-server response");
    await expect(
      client.request("thread/read", { threadId: "thread-1" }),
    ).resolves.toMatchObject({ thread: { id: "thread-1" } });
  });

  it("emits notifications and responds to server requests", async () => {
    let sendToClient: ((message: unknown) => void) | undefined;
    const responses: Record<string, unknown>[] = [];
    let resolveResponse: (() => void) | undefined;
    const responsePromise = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });
    const { client } = await createHarness((message, send) => {
      sendToClient = send;
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === undefined && message.id === "approval-1") {
        responses.push(message);
        resolveResponse?.();
      }
    });

    const notificationPromise = client.waitForNotification(
      (notification) => notification.method === "turn/started",
    );
    const requestPromise = new Promise<void>((resolve) => {
      client.once("serverRequest", (request) => {
        expect(request.method).toBe("item/commandExecution/requestApproval");
        request.respond({ decision: "accept" });
        resolve();
      });
    });

    sendToClient?.({
      method: "turn/started",
      params: { turn: { id: "turn-1" } },
    });
    sendToClient?.({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1" },
    });

    await expect(notificationPromise).resolves.toMatchObject({
      method: "turn/started",
    });
    await requestPromise;
    await responsePromise;
    expect(responses).toEqual([
      { id: "approval-1", result: { decision: "accept" } },
    ]);
  });
});
