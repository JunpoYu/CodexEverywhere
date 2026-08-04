import { createServer, type Server as HttpServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";

type JsonRpcMessage = Record<string, unknown>;

export type TuiPermissionProxy = {
  socketPath: string;
  close(): Promise<void>;
};

/**
 * The official TUI resumes a remote thread with the TUI process' local
 * approval and sandbox defaults. A reconnect must not silently replace the
 * defaults already stored by app-server for that thread, so this proxy removes
 * only those fields from every TUI resume handshake. Explicit
 * thread/settings/update calls pass through unchanged.
 */
export async function startTuiPermissionProxy(options: {
  upstreamSocketPath: string;
  runtimeDir: string;
}): Promise<TuiPermissionProxy> {
  await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 });
  const socketDirectory = await mkdtemp(join(options.runtimeDir, "tui-"));
  await chmod(socketDirectory, 0o700);
  const socketPath = join(socketDirectory, "app-server.sock");

  const upstream = new WebSocket("ws://localhost", {
    createConnection: () =>
      createConnection({ path: options.upstreamSocketPath }),
    perMessageDeflate: false,
  });
  try {
    await waitForOpen(upstream);
  } catch (error) {
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }

  const httpServer = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  let downstream: WebSocket | undefined;
  let closed = false;

  httpServer.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (socket) => {
    if (downstream && downstream.readyState !== WebSocket.CLOSED) {
      socket.close(1013, "TUI proxy already has a client");
      return;
    }
    downstream = socket;
    socket.on("message", (data, isBinary) => {
      if (upstream.readyState !== WebSocket.OPEN) return;
      const forwarded = stripResumePermissionOverrides(data, isBinary);
      upstream.send(forwarded?.data ?? data, { binary: isBinary });
    });
    socket.on("close", () => upstream.close());
    socket.on("error", () => upstream.close());
  });

  upstream.on("message", (data, isBinary) => {
    if (downstream?.readyState === WebSocket.OPEN)
      downstream.send(data, { binary: isBinary });
  });
  upstream.on("close", () => downstream?.close());
  upstream.on("error", () => downstream?.terminate());

  try {
    await listenUnix(httpServer, socketPath);
    await chmod(socketPath, 0o600);
  } catch (error) {
    upstream.terminate();
    webSocketServer.close();
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    socketPath,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      downstream?.terminate();
      upstream.terminate();
      webSocketServer.close();
      await closeServer(httpServer);
      await rm(socketDirectory, { recursive: true, force: true });
    },
  };
}

export function stripResumePermissionOverrides(
  data: RawData,
  isBinary: boolean,
): { data: string } | undefined {
  if (isBinary) return undefined;
  const message = parseJsonRpcMessage(data);
  if (!message || message.method !== "thread/resume") return undefined;
  const params = isRecord(message.params) ? { ...message.params } : undefined;
  if (!params) return undefined;

  delete params.approvalPolicy;
  delete params.approvalsReviewer;
  delete params.sandbox;
  delete params.sandboxPolicy;
  delete params.permissions;

  if (isRecord(params.config)) {
    const config = { ...params.config };
    for (const key of [
      "approval_policy",
      "approvals_reviewer",
      "sandbox_mode",
      "sandbox_workspace_write",
      "permissions",
      "permission_profile",
    ]) {
      delete config[key];
    }
    params.config = config;
  }

  return { data: JSON.stringify({ ...message, params }) };
}

function parseJsonRpcMessage(data: RawData): JsonRpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(data.toString());
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };
    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

function listenUnix(server: HttpServer, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(socketPath);
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
