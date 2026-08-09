import { createServer, type Server as HttpServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";

type JsonRpcMessage = Record<string, unknown>;

export type TuiThreadPermissionObservation = {
  threadId: string;
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandboxPolicy: unknown;
};

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
  prepareThreadResume?(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  onThreadPermissions?(
    observation: TuiThreadPermissionObservation,
  ): Promise<void> | void;
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
  const permissionRequests = new Set<string>();
  let downstreamTail = Promise.resolve();
  let upstreamTail = Promise.resolve();

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
      downstreamTail = downstreamTail
        .catch(() => undefined)
        .then(async () => {
          if (upstream.readyState !== WebSocket.OPEN) return;
          const forwarded = stripResumePermissionOverrides(data, isBinary);
          let outgoing: RawData | string = forwarded?.data ?? data;
          if (!isBinary && options.prepareThreadResume) {
            const message = parseJsonRpcMessage(outgoing);
            if (
              message?.method === "thread/resume" &&
              isRecord(message.params)
            ) {
              try {
                const params = await options.prepareThreadResume(
                  message.params,
                );
                outgoing = JSON.stringify({ ...message, params });
              } catch {
                socket.close(1011, "Unable to restore thread permissions");
                return;
              }
            }
          }
          rememberPermissionRequest(outgoing, isBinary, permissionRequests);
          upstream.send(outgoing, { binary: isBinary });
        });
    });
    socket.on("close", () => upstream.close());
    socket.on("error", () => upstream.close());
  });

  upstream.on("message", (data, isBinary) => {
    upstreamTail = upstreamTail
      .catch(() => undefined)
      .then(async () => {
        const observation = extractPermissionObservation(
          data,
          isBinary,
          permissionRequests,
        );
        if (observation && options.onThreadPermissions) {
          await Promise.resolve(options.onThreadPermissions(observation)).catch(
            () => undefined,
          );
        }
        if (downstream?.readyState === WebSocket.OPEN) {
          try {
            downstream.send(data, { binary: isBinary });
          } catch {
            // The TUI may close while its final response is being persisted.
          }
        }
      });
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
      await downstreamTail;
      await upstreamTail;
      webSocketServer.close();
      await closeServer(httpServer);
      await rm(socketDirectory, { recursive: true, force: true });
    },
  };
}

function rememberPermissionRequest(
  data: RawData | string,
  isBinary: boolean,
  requests: Set<string>,
): void {
  if (isBinary) return;
  const message = parseJsonRpcMessage(data);
  const key = jsonRpcIdKey(message?.id);
  if (
    key &&
    (message?.method === "thread/start" ||
      message?.method === "thread/resume" ||
      message?.method === "thread/fork")
  ) {
    requests.add(key);
  }
}

function extractPermissionObservation(
  data: RawData,
  isBinary: boolean,
  requests: Set<string>,
): TuiThreadPermissionObservation | undefined {
  if (isBinary) return undefined;
  const message = parseJsonRpcMessage(data);
  if (!message) return undefined;
  if (message.method === "thread/settings/updated") {
    const params = isRecord(message.params) ? message.params : undefined;
    const settings = isRecord(params?.threadSettings)
      ? params.threadSettings
      : undefined;
    if (!params || typeof params.threadId !== "string" || !settings)
      return undefined;
    return {
      threadId: params.threadId,
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      sandboxPolicy: settings.sandboxPolicy,
    };
  }
  const key = jsonRpcIdKey(message.id);
  if (!key || !requests.delete(key) || !isRecord(message.result))
    return undefined;
  const result = message.result;
  if (!isRecord(result.thread) || typeof result.thread.id !== "string")
    return undefined;
  return {
    threadId: result.thread.id,
    approvalPolicy: result.approvalPolicy,
    approvalsReviewer: result.approvalsReviewer,
    sandboxPolicy: result.sandbox,
  };
}

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number" && Number.isFinite(value))
    return `number:${String(value)}`;
  return undefined;
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

function parseJsonRpcMessage(
  data: RawData | string,
): JsonRpcMessage | undefined {
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
