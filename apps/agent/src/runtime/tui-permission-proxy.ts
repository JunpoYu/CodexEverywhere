import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { ThreadResumeResponse } from "@codex-everywhere/codex-app-server-schema/v2";

import {
  resumeThreadSettingsRepair,
  type ThreadSettingsMutationLease,
  type ThreadSettingsObservation,
  type ThreadSettingsRepository,
} from "../v2/repositories/thread-settings-repository.js";

type JsonRpcMessage = Record<string, unknown>;

export type TuiThreadPermissionObservation = {
  threadId: string;
  approvalPolicy?: unknown;
  approvalsReviewer?: unknown;
  sandboxPolicy?: unknown;
};

export type TuiPermissionProxy = {
  socketPath: string;
  close(): Promise<void>;
};

export type TuiThreadPermissionRepair = {
  update: Record<string, unknown>;
  response: Record<string, unknown>;
};

export function tuiV4ThreadPermissionOptions(
  repository: ThreadSettingsRepository,
): Pick<
  Parameters<typeof startTuiPermissionProxy>[0],
  | "prepareThreadResume"
  | "repairThreadResume"
  | "beginThreadPermissionObservation"
  | "claimThreadPermissionRepair"
  | "acquireThreadPermissionMutation"
  | "onThreadPermissions"
  | "onThreadDeleted"
> {
  return {
    prepareThreadResume: (params) => repository.applyToResume(params),
    repairThreadResume: (requested, response) =>
      resumeThreadSettingsRepair(requested, response as ThreadResumeResponse),
    beginThreadPermissionObservation: (threadId) =>
      repository.beginObservation(threadId),
    claimThreadPermissionRepair: (threadId, expected) =>
      repository.claimRepairObservation(threadId, expected),
    acquireThreadPermissionMutation: (threadId, options) =>
      repository.acquireMutation(threadId, options),
    onThreadPermissions: async (observation, causalObservation) => {
      const { threadId, ...snapshot } = observation;
      await repository.saveObserved(threadId, snapshot, causalObservation);
    },
    onThreadDeleted: (threadId) => repository.remove(threadId),
  };
}

type PendingPermissionRequest = {
  method:
    | "thread/start"
    | "thread/resume"
    | "thread/fork"
    | "thread/settings/update"
    | "thread/delete"
    | "turn/start"
    | "turn/steer";
  params: Record<string, unknown>;
  observation?: ThreadSettingsObservation;
  lease?: ThreadSettingsMutationLease;
  runtimeLease?: { release(): Promise<void> };
  releasePromise?: Promise<void>;
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
  repairThreadResume?(
    requested: Record<string, unknown>,
    response: Record<string, unknown>,
  ):
    | Promise<TuiThreadPermissionRepair | undefined>
    | TuiThreadPermissionRepair
    | undefined;
  beginThreadPermissionObservation?(
    threadId?: string,
  ): Promise<ThreadSettingsObservation>;
  claimThreadPermissionRepair?(
    threadId: string,
    expected: ThreadSettingsObservation,
  ): Promise<ThreadSettingsObservation | undefined>;
  acquireThreadPermissionMutation?(
    threadId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ThreadSettingsMutationLease>;
  acquireRuntimeMutation?(): Promise<{ release(): Promise<void> }>;
  internalRepairTimeoutMs?: number;
  onThreadPermissions?(
    observation: TuiThreadPermissionObservation,
    causalObservation?: ThreadSettingsObservation,
  ): Promise<void> | void;
  onThreadDeleted?(threadId: string): Promise<void> | void;
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
  const lifecycleAbort = new AbortController();
  const abortLifecycle = (message: string) => {
    if (!lifecycleAbort.signal.aborted) {
      lifecycleAbort.abort(new Error(message));
    }
  };
  const permissionRequests = new Map<string, PendingPermissionRequest>();
  let permissionReleaseTail = Promise.resolve();
  let permissionReleaseError: unknown;
  const internalRequests = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
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
          let pending: PendingPermissionRequest | undefined;
          let requestKey: string | undefined;
          try {
            if (!isBinary) {
              const message = parseJsonRpcMessage(outgoing);
              if (message && isRecord(message.params)) {
                const method = permissionRequestMethod(
                  message.method,
                  message.params,
                );
                requestKey = jsonRpcIdKey(message.id);
                if (method) {
                  if (!requestKey) {
                    throw new Error("TUI permission request must have an id");
                  }
                  if (permissionRequests.has(requestKey)) {
                    throw new Error("Duplicate in-flight TUI JSON-RPC id");
                  }
                  const threadId =
                    typeof message.params.threadId === "string"
                      ? message.params.threadId
                      : undefined;
                  const needsMutationLease =
                    method === "thread/resume" ||
                    method === "thread/settings/update" ||
                    method === "thread/delete";
                  if (needsMutationLease && !threadId) {
                    throw new Error(`${method} requires a thread id`);
                  }
                  pending = { method, params: message.params };
                  const needsRuntimeLease =
                    method === "thread/start" ||
                    method === "turn/start" ||
                    method === "turn/steer";
                  if (needsRuntimeLease && options.acquireRuntimeMutation) {
                    pending.runtimeLease =
                      await options.acquireRuntimeMutation();
                  }
                  const lease =
                    needsMutationLease &&
                    threadId &&
                    options.acquireThreadPermissionMutation
                      ? await options.acquireThreadPermissionMutation(
                          threadId,
                          { signal: lifecycleAbort.signal },
                        )
                      : undefined;
                  if (lease) pending.lease = lease;
                  const observesPermissions =
                    method === "thread/start" ||
                    method === "thread/resume" ||
                    method === "thread/fork" ||
                    method === "thread/settings/update";
                  const observation =
                    observesPermissions &&
                    options.beginThreadPermissionObservation
                      ? await options.beginThreadPermissionObservation(
                          method === "thread/resume" ||
                            method === "thread/settings/update"
                            ? threadId
                            : undefined,
                        )
                      : undefined;
                  if (observation) pending.observation = observation;
                }
                if (
                  message.method === "thread/resume" &&
                  options.prepareThreadResume
                ) {
                  if (!requestKey) {
                    throw new Error("TUI resume request must have an id");
                  }
                  const params = await options.prepareThreadResume(
                    message.params,
                  );
                  outgoing = JSON.stringify({ ...message, params });
                  if (pending) pending.params = params;
                }
              }
            }
            if (pending && requestKey)
              permissionRequests.set(requestKey, pending);
            upstream.send(outgoing, { binary: isBinary });
          } catch {
            if (requestKey && permissionRequests.get(requestKey) === pending) {
              permissionRequests.delete(requestKey);
            }
            try {
              await releaseMutationLease(pending);
            } catch (error) {
              permissionReleaseError ??= error;
              upstream.terminate();
            }
            socket.close(1011, "Unable to restore thread permissions");
          }
        });
    });
    socket.on("close", () => {
      abortLifecycle("TUI connection closed");
      upstream.close();
    });
    socket.on("error", () => {
      abortLifecycle("TUI connection failed");
      upstream.close();
    });
  });

  upstream.on("message", (data, isBinary) => {
    if (!isBinary) {
      const message = parseJsonRpcMessage(data);
      const key = jsonRpcIdKey(message?.id);
      const pending = key ? internalRequests.get(key) : undefined;
      if (key && pending && message && message.method === undefined) {
        internalRequests.delete(key);
        clearTimeout(pending.timer);
        if (isRecord(message.error)) {
          pending.reject(
            new Error(
              typeof message.error.message === "string"
                ? message.error.message
                : "TUI permission repair was rejected",
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }
    upstreamTail = upstreamTail
      .catch(() => undefined)
      .then(async () => {
        let outgoing: RawData | string = data;
        const responseMessage = !isBinary
          ? parseJsonRpcMessage(data)
          : undefined;
        const responseKey = jsonRpcIdKey(responseMessage?.id);
        const pending =
          responseKey && responseMessage?.method === undefined
            ? permissionRequests.get(responseKey)
            : undefined;
        try {
          if (
            pending?.method === "thread/resume" &&
            responseMessage &&
            isRecord(responseMessage.result) &&
            options.repairThreadResume
          ) {
            let repair = await options.repairThreadResume(
              pending.params,
              responseMessage.result,
            );
            if (
              repair &&
              pending.observation &&
              options.claimThreadPermissionRepair
            ) {
              const thread = isRecord(repair.response.thread)
                ? repair.response.thread
                : undefined;
              const claimed =
                thread && typeof thread.id === "string"
                  ? await options.claimThreadPermissionRepair(
                      thread.id,
                      pending.observation,
                    )
                  : undefined;
              if (claimed) pending.observation = claimed;
              else repair = undefined;
            }
            if (repair) {
              const thread = isRecord(repair.response.thread)
                ? repair.response.thread
                : undefined;
              if (!thread || typeof thread.id !== "string") {
                throw new Error("TUI resume repair response has no thread id");
              }
              await requestUpstream(
                upstream,
                internalRequests,
                "thread/settings/update",
                { threadId: thread.id, ...repair.update },
                options.internalRepairTimeoutMs ?? 15_000,
              );
              outgoing = JSON.stringify({
                ...responseMessage,
                result: repair.response,
              });
            }
          }
          if (
            pending?.method === "thread/delete" &&
            responseMessage &&
            jsonRpcResponseSucceeded(responseMessage) &&
            typeof pending.params.threadId === "string" &&
            options.onThreadDeleted
          ) {
            await retryPermissionPersistence(() =>
              Promise.resolve(
                options.onThreadDeleted!(pending.params.threadId as string),
              ),
            );
          }
          const observation = extractPermissionObservation(
            outgoing,
            isBinary,
            pending,
          );
          if (observation && options.onThreadPermissions) {
            await retryPermissionPersistence(() =>
              Promise.resolve(
                options.onThreadPermissions!(observation, pending?.observation),
              ),
            );
          }
          await releaseMutationLease(pending);
          if (responseKey && permissionRequests.get(responseKey) === pending) {
            permissionRequests.delete(responseKey);
          }
          if (downstream?.readyState === WebSocket.OPEN) {
            try {
              downstream.send(outgoing, { binary: isBinary });
            } catch {
              // The TUI may close while its final response is being persisted.
            }
          }
        } catch (error) {
          try {
            await releaseMutationLease(pending);
          } catch (releaseError) {
            permissionReleaseError ??= releaseError;
            upstream.terminate();
          }
          if (responseKey && permissionRequests.get(responseKey) === pending) {
            permissionRequests.delete(responseKey);
          }
          if (responseMessage && downstream?.readyState === WebSocket.OPEN) {
            downstream.send(
              JSON.stringify({
                id: responseMessage.id,
                error: {
                  code: -32_000,
                  message:
                    error instanceof Error
                      ? `Unable to restore thread permissions: ${error.message}`
                      : "Unable to restore thread permissions",
                },
              }),
            );
          }
        }
      });
  });
  upstream.on("close", () => {
    abortLifecycle("App-server connection closed");
    rejectInternalRequests(internalRequests, "App-server connection closed");
    schedulePermissionRequestRelease();
    downstream?.close();
  });
  upstream.on("error", () => {
    abortLifecycle("App-server connection failed");
    rejectInternalRequests(internalRequests, "App-server connection failed");
    schedulePermissionRequestRelease();
    downstream?.terminate();
  });

  function schedulePermissionRequestRelease(): void {
    const processingTail = upstreamTail;
    permissionReleaseTail = permissionReleaseTail
      .then(async () => {
        // A close/error can race the response handler that owns the same
        // permission lease. Let that handler persist/repair and release first;
        // the map sweep is only a fallback for requests with no response.
        await processingTail.catch(() => undefined);
        await releasePermissionRequests(permissionRequests);
      })
      .catch((error: unknown) => {
        permissionReleaseError ??= error;
      });
  }

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
      abortLifecycle("TUI permission proxy closed");
      downstream?.terminate();
      upstream.terminate();
      rejectInternalRequests(internalRequests, "TUI permission proxy closed");
      await downstreamTail;
      await upstreamTail;
      schedulePermissionRequestRelease();
      await permissionReleaseTail;
      try {
        await releasePermissionRequests(permissionRequests);
      } catch (error) {
        permissionReleaseError ??= error;
      }
      webSocketServer.close();
      await closeServer(httpServer);
      await rm(socketDirectory, { recursive: true, force: true });
      if (permissionReleaseError) throw permissionReleaseError;
    },
  };
}

function permissionRequestMethod(
  value: unknown,
  params: Record<string, unknown>,
): PendingPermissionRequest["method"] | undefined {
  if (
    value === "thread/start" ||
    value === "thread/resume" ||
    value === "thread/fork" ||
    value === "thread/delete" ||
    value === "turn/start" ||
    value === "turn/steer"
  ) {
    return value;
  }
  return value === "thread/settings/update" && hasThreadPermissionUpdate(params)
    ? value
    : undefined;
}

function requestUpstream(
  upstream: WebSocket,
  requests: Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const id = `ce-tui-permission-repair:${randomUUID()}`;
  const key = jsonRpcIdKey(id)!;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Keep the request tombstone until the socket closes. Terminating the
      // upstream prevents a late response from being forwarded as a TUI RPC
      // response after the mutation fence is released.
      upstream.terminate();
    }, timeoutMs);
    timer.unref();
    requests.set(key, { resolve, reject, timer });
    try {
      upstream.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      requests.delete(key);
      clearTimeout(timer);
      reject(
        error instanceof Error ? error : new Error("App-server send failed"),
      );
    }
  });
}

function rejectInternalRequests(
  requests: Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >,
  message: string,
): void {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  requests.clear();
}

async function releasePermissionRequests(
  requests: Map<string, PendingPermissionRequest>,
): Promise<void> {
  const errors: unknown[] = [];
  await Promise.all(
    [...requests.entries()].map(async ([key, request]) => {
      try {
        await releaseMutationLease(request);
        if (requests.get(key) === request) requests.delete(key);
      } catch (error) {
        errors.push(error);
      }
    }),
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Unable to release TUI permission locks");
  }
}

async function releaseMutationLease(
  pending: PendingPermissionRequest | undefined,
): Promise<void> {
  if (!pending || (!pending.lease && !pending.runtimeLease)) return;
  if (pending.releasePromise) {
    await pending.releasePromise;
    return;
  }
  const releasePromise = (async () => {
    try {
      await pending.lease?.release();
      await pending.runtimeLease?.release();
    } catch {
      // A failed ownership-safe release remains retryable. Retry once before
      // surfacing the failure and keeping the proxy from closing Host state.
      await pending.lease?.release();
      await pending.runtimeLease?.release();
    }
    delete pending.lease;
    delete pending.runtimeLease;
  })();
  pending.releasePromise = releasePromise;
  try {
    await releasePromise;
  } finally {
    if (pending.releasePromise === releasePromise) {
      delete pending.releasePromise;
    }
  }
}

async function retryPermissionPersistence(
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch {
    // Retry once while the per-thread mutation fence is still held. A second
    // failure is surfaced to the TUI instead of silently leaving app-server
    // and the persisted resume intent divergent.
    await operation();
  }
}

function extractPermissionObservation(
  data: RawData | string,
  isBinary: boolean,
  pending: PendingPermissionRequest | undefined,
): TuiThreadPermissionObservation | undefined {
  if (isBinary || !pending) return undefined;
  const message = parseJsonRpcMessage(data);
  if (!message || !jsonRpcResponseSucceeded(message)) {
    return undefined;
  }
  if (pending.method === "thread/settings/update") {
    if (typeof pending.params.threadId !== "string") return undefined;
    return {
      threadId: pending.params.threadId,
      ...(Object.hasOwn(pending.params, "approvalPolicy") &&
      pending.params.approvalPolicy != null
        ? { approvalPolicy: pending.params.approvalPolicy }
        : {}),
      ...(Object.hasOwn(pending.params, "approvalsReviewer") &&
      pending.params.approvalsReviewer != null
        ? { approvalsReviewer: pending.params.approvalsReviewer }
        : {}),
      ...(Object.hasOwn(pending.params, "sandboxPolicy") &&
      pending.params.sandboxPolicy != null
        ? { sandboxPolicy: pending.params.sandboxPolicy }
        : {}),
    };
  }
  const result = message.result;
  if (!isRecord(result)) return undefined;
  if (!isRecord(result.thread) || typeof result.thread.id !== "string")
    return undefined;
  return {
    threadId: result.thread.id,
    ...(Object.hasOwn(result, "approvalPolicy") && result.approvalPolicy != null
      ? { approvalPolicy: result.approvalPolicy }
      : {}),
    ...(Object.hasOwn(result, "approvalsReviewer") &&
    result.approvalsReviewer != null
      ? { approvalsReviewer: result.approvalsReviewer }
      : {}),
    ...(Object.hasOwn(result, "sandbox") && result.sandbox != null
      ? { sandboxPolicy: result.sandbox }
      : {}),
  };
}

function hasThreadPermissionUpdate(payload: Record<string, unknown>): boolean {
  return ["approvalPolicy", "approvalsReviewer", "sandboxPolicy"].some(
    (key) => Object.hasOwn(payload, key) && payload[key] != null,
  );
}

function jsonRpcResponseSucceeded(message: JsonRpcMessage): boolean {
  return (
    message.method === undefined &&
    Object.hasOwn(message, "result") &&
    !Object.hasOwn(message, "error")
  );
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
  if (
    !message ||
    (message.method !== "thread/resume" && message.method !== "turn/start")
  )
    return undefined;
  const params = isRecord(message.params) ? { ...message.params } : undefined;
  if (!params) return undefined;

  delete params.approvalPolicy;
  delete params.approvalsReviewer;
  delete params.sandboxPolicy;
  if (message.method === "thread/resume") {
    delete params.sandbox;
    delete params.permissions;
  }

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
