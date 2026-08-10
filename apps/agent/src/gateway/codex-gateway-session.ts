import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";

import {
  PROTOCOL_VERSION,
  type EventEnvelope,
  type RequestEnvelope,
} from "@codex-everywhere/protocol";
import type {
  ThreadListResponse,
  ThreadReadResponse,
  ThreadForkResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadStatus,
  TurnSteerResponse,
} from "@codex-everywhere/codex-app-server-schema/v2";

import { WorkspaceRegistry } from "../host/workspaces.js";
import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest,
} from "../runtime/codex-app-server-client.js";
import type { GatewaySession } from "./direct-gateway.js";
import { QueueRegistry } from "../host/queue.js";
import {
  resumePermissionRepair,
  ThreadPermissionRegistry,
} from "../host/thread-permissions.js";
import type {
  QueueDispatcher,
  QueueDispatcherEvent,
} from "../runtime/queue-dispatcher.js";

const FAST_THREAD_LIST_TIMEOUT_MS = 40_000;
const LEGACY_THREAD_LIST_TIMEOUT_MS = 110_000;

export type CodexGatewaySessionOptions = {
  socketPath: string;
  workspaces: WorkspaceRegistry;
  nodeStatus(): Promise<unknown> | unknown;
  queue: QueueRegistry;
  threadPermissions: ThreadPermissionRegistry;
  queueDispatcher?: QueueDispatcher;
};

export class CodexGatewaySession implements GatewaySession {
  readonly #client: CodexAppServerClient;
  readonly #workspaces: WorkspaceRegistry;
  readonly #nodeStatus: () => Promise<unknown> | unknown;
  readonly #queue: QueueRegistry;
  readonly #threadPermissions: ThreadPermissionRegistry;
  readonly #queueDispatcher: QueueDispatcher | undefined;
  readonly #events = new EventEmitter<{ event: [EventEnvelope] }>();
  readonly #serverRequests = new Map<string, CodexServerRequest>();
  readonly #authorizedThreads = new Map<string, number>();
  readonly #unsubscribeQueue: (() => void) | undefined;
  #cursor = 0;

  private constructor(
    client: CodexAppServerClient,
    options: CodexGatewaySessionOptions,
  ) {
    this.#client = client;
    this.#workspaces = options.workspaces;
    this.#nodeStatus = options.nodeStatus;
    this.#queue = options.queue;
    this.#threadPermissions = options.threadPermissions;
    this.#queueDispatcher = options.queueDispatcher;
    this.#unsubscribeQueue = options.queueDispatcher?.onEvent(
      (event) => void this.#forwardQueueEvent(event),
    );
    client.on(
      "notification",
      (notification) => void this.#forwardNotification(notification),
    );
    client.on(
      "serverRequest",
      (request) => void this.#forwardServerRequest(request),
    );
  }

  static async connect(
    options: CodexGatewaySessionOptions,
  ): Promise<CodexGatewaySession> {
    const client = await CodexAppServerClient.connectUnix(options.socketPath, {
      experimentalApi: true,
    });
    return new CodexGatewaySession(client, options);
  }

  onEvent(listener: (event: EventEnvelope) => void): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  async request(request: RequestEnvelope): Promise<unknown> {
    const payload = asRecord(request.payload);
    switch (request.method) {
      case "node/status":
        return this.#nodeStatus();
      case "workspace/list":
        return this.#workspaces.profile();
      case "workspace/browse": {
        const path = optionalString(payload, "path");
        if (path !== undefined) requireAbsoluteWorkspacePath(path);
        return this.#workspaces.browse(path);
      }
      case "workspace/add": {
        const path = requiredString(payload, "path");
        requireAbsoluteWorkspacePath(path);
        return this.#workspaces.add(path);
      }
      case "workspace/remove": {
        const path = requiredString(payload, "path");
        requireAbsoluteWorkspacePath(path);
        const result = await this.#workspaces.remove(path);
        this.#authorizedThreads.clear();
        return result;
      }
      case "workspace/default/set": {
        const path = requiredString(payload, "path");
        requireAbsoluteWorkspacePath(path);
        return this.#workspaces.setDefault(path);
      }
      case "model/list":
        return this.#client.request("model/list", payload);
      case "codex/account/read":
        return this.#client.request("account/read", { refreshToken: false });
      case "codex/account/login/start":
        return this.#client.request("account/login/start", {
          type: "chatgptDeviceCode",
        });
      case "codex/account/login/cancel":
        return this.#client.request("account/login/cancel", {
          loginId: requiredString(payload, "loginId"),
        });
      case "codex/account/logout":
        return this.#client.request("account/logout", {});
      case "account/rateLimits/read":
      case "account/usage/read":
        return this.#client.request(request.method, {});
      case "skills/list": {
        if (!Array.isArray(payload.cwds) || payload.cwds.length === 0)
          throw new Error("skills/list requires at least one workspace cwd");
        const cwds = payload.cwds;
        const resolvedCwds = await Promise.all(
          cwds.map(async (cwd) => {
            if (typeof cwd !== "string")
              throw new Error("skills/list requires string cwd values");
            return this.#workspaces.resolve(cwd);
          }),
        );
        return this.#client.request("skills/list", {
          ...payload,
          cwds: resolvedCwds,
        });
      }
      case "thread/list":
        return this.#listThreads(payload);
      case "thread/read":
        return this.#readAuthorizedThread(payload);
      case "thread/turns/list": {
        const threadId = requiredString(payload, "threadId");
        await this.#authorizeThread(threadId);
        return this.#client.request(request.method, payload);
      }
      case "queue/list":
        return this.#listQueue();
      case "queue/add":
        return this.#addQueueItem(payload);
      case "queue/remove":
        return this.#removeQueueItem(payload);
      case "queue/steer":
        return this.#steerQueueItem(payload);
      case "thread/start": {
        if (typeof payload.cwd !== "string")
          throw new Error("thread/start requires cwd");
        const cwd = await this.#workspaces.resolve(payload.cwd);
        const permissionObservation =
          await this.#threadPermissions.beginObservation();
        const response = await this.#client.request<ThreadStartResponse>(
          "thread/start",
          { ...payload, cwd },
        );
        const authorization = await this.#workspaces.resolveWithRevision(
          response.thread.cwd,
        );
        this.#authorizedThreads.set(response.thread.id, authorization.revision);
        await this.#threadPermissions.saveResponse(
          response,
          permissionObservation,
        );
        return response;
      }
      case "thread/resume": {
        const threadId = requiredString(payload, "threadId");
        await this.#authorizeThread(threadId);
        return this.#resumeThread(payload);
      }
      case "thread/unsubscribe":
      case "thread/name/set":
      case "thread/archive":
      case "thread/unarchive": {
        const threadId = requiredString(payload, "threadId");
        await this.#authorizeThread(threadId);
        return this.#client.request(request.method, payload);
      }
      case "thread/settings/update": {
        const threadId = requiredString(payload, "threadId");
        await this.#authorizeThread(threadId);
        const update = { ...payload };
        if (update.cwd !== undefined && update.cwd !== null) {
          if (typeof update.cwd !== "string")
            throw new Error("thread/settings/update cwd must be a string");
          update.cwd = await this.#workspaces.resolve(update.cwd);
        }
        return this.#threadPermissions.serializeMutation(threadId, async () => {
          const permissionObservation =
            await this.#threadPermissions.beginObservation(threadId);
          const response = await this.#client.request(request.method, update);
          await this.#threadPermissions.saveSettingsUpdate(
            threadId,
            update,
            permissionObservation,
          );
          return response;
        });
      }
      case "thread/delete": {
        const threadId = requiredString(payload, "threadId");
        await this.#authorizeThread(threadId);
        return this.#threadPermissions.serializeMutation(threadId, async () => {
          const result = await this.#client.request(request.method, payload);
          this.#authorizedThreads.delete(threadId);
          await this.#threadPermissions.remove(threadId);
          return result;
        });
      }
      case "thread/fork": {
        const threadId = requiredString(payload, "threadId");
        await this.#authorizeThread(threadId);
        const forkPayload = { ...payload };
        if (forkPayload.cwd !== undefined && forkPayload.cwd !== null) {
          if (typeof forkPayload.cwd !== "string")
            throw new Error("thread/fork cwd must be a string");
          forkPayload.cwd = await this.#workspaces.resolve(forkPayload.cwd);
        }
        const permissionObservation =
          await this.#threadPermissions.beginObservation();
        const response = await this.#client.request<ThreadForkResponse>(
          "thread/fork",
          forkPayload,
        );
        const authorization = await this.#workspaces.resolveWithRevision(
          response.thread.cwd,
        );
        this.#authorizedThreads.set(response.thread.id, authorization.revision);
        await this.#threadPermissions.saveResponse(
          response,
          permissionObservation,
        );
        return response;
      }
      case "thread/compact/start":
      case "thread/goal/set":
      case "thread/goal/get":
      case "thread/goal/clear":
      case "review/start": {
        const threadId = requiredString(payload, "threadId");
        await this.#ensureThreadLoaded(threadId);
        return this.#client.request(request.method, payload);
      }
      case "mcpServerStatus/list": {
        const threadId = optionalString(payload, "threadId");
        if (threadId) await this.#authorizeThread(threadId);
        return this.#client.request(request.method, payload);
      }
      case "turn/start":
      case "turn/steer":
      case "turn/interrupt": {
        const threadId = requiredString(payload, "threadId");
        await this.#ensureThreadLoaded(threadId);
        if (request.method !== "turn/interrupt") {
          rejectLocalImageInput(payload.input);
        }
        if (
          request.method === "turn/start" &&
          hasThreadPermissionUpdate(payload)
        ) {
          return this.#threadPermissions.serializeMutation(
            threadId,
            async () => {
              const observation =
                await this.#threadPermissions.beginObservation(threadId);
              const response = await this.#client.request(
                request.method,
                payload,
              );
              await this.#threadPermissions.saveSettingsUpdate(
                threadId,
                payload,
                observation,
              );
              return response;
            },
          );
        }
        return this.#client.request(request.method, payload);
      }
      case "codex/server-request/respond":
        return this.#respondToServerRequest(payload);
      default:
        throw new Error(`Unsupported gateway method: ${request.method}`);
    }
  }

  close(): Promise<void> {
    this.#unsubscribeQueue?.();
    this.#serverRequests.clear();
    return this.#client.close();
  }

  async #listThreads(
    payload: Record<string, unknown>,
  ): Promise<ThreadListResponse> {
    const response = await this.#client.request<ThreadListResponse>(
      "thread/list",
      payload,
      {
        timeoutMs:
          payload.useStateDbOnly === true
            ? FAST_THREAD_LIST_TIMEOUT_MS
            : LEGACY_THREAD_LIST_TIMEOUT_MS,
      },
    );
    const authorization = await this.#workspaces.allowedPathsWithRevision(
      response.data.map((thread) => thread.cwd),
    );
    return {
      ...response,
      data: response.data.filter((thread) => {
        if (authorization.paths.has(thread.cwd)) {
          this.#authorizedThreads.set(thread.id, authorization.revision);
          return true;
        }
        return false;
      }),
    };
  }

  async #readAuthorizedThread(
    payload: Record<string, unknown>,
  ): Promise<ThreadReadResponse> {
    const response = await this.#client.request<ThreadReadResponse>(
      "thread/read",
      payload,
    );
    const authorization = await this.#workspaces.resolveWithRevision(
      response.thread.cwd,
    );
    this.#authorizedThreads.set(response.thread.id, authorization.revision);
    return response;
  }

  async #authorizeThread(threadId: string): Promise<ThreadReadResponse> {
    return this.#readAuthorizedThread({ threadId, includeTurns: false });
  }

  async #ensureThreadLoaded(threadId: string): Promise<void> {
    const current = await this.#authorizeThread(threadId);
    if (!threadNeedsResume(current.thread.status)) return;
    await this.#resumeThread({ threadId });
  }

  async #resumeThread(
    payload: Record<string, unknown>,
  ): Promise<ThreadResumeResponse> {
    const threadId = requiredString(payload, "threadId");
    return this.#threadPermissions.serializeMutation(threadId, async () => {
      const permissionObservation =
        await this.#threadPermissions.beginObservation(threadId);
      let resumePayload = await this.#threadPermissions.applyToResume(payload);
      if (
        !(await this.#threadPermissions.observationIsCurrent(
          threadId,
          permissionObservation,
        ))
      ) {
        // A newer explicit update/notification arrived while this resume was
        // waiting. Do not inject an older stored snapshot back into app-server.
        resumePayload = { ...payload };
      }
      const response = await this.#client.request<ThreadResumeResponse>(
        "thread/resume",
        resumePayload,
      );
      const authorization = await this.#workspaces.resolveWithRevision(
        response.thread.cwd,
      );
      this.#authorizedThreads.set(response.thread.id, authorization.revision);
      const repair = resumePermissionRepair(resumePayload, response);
      if (!repair) {
        await this.#threadPermissions.saveResponse(
          response,
          permissionObservation,
        );
        return response;
      }
      const repairObservation =
        await this.#threadPermissions.claimRepairObservation(
          threadId,
          permissionObservation,
        );
      if (!repairObservation) {
        await this.#threadPermissions.saveResponse(
          response,
          permissionObservation,
        );
        return response;
      }
      await this.#client.request("thread/settings/update", {
        threadId,
        ...repair.update,
      });
      await this.#threadPermissions.saveResponse(
        repair.response,
        repairObservation,
      );
      return repair.response;
    });
  }

  async #listQueue(): Promise<{ items: unknown[] }> {
    const items = await this.#queue.list();
    const allowed = await Promise.all(
      items.map(async (item) => {
        try {
          await this.#workspaces.resolve(item.workspacePath);
          return item;
        } catch {
          return undefined;
        }
      }),
    );
    return { items: allowed.filter((item) => item !== undefined) };
  }

  async #addQueueItem(payload: Record<string, unknown>): Promise<unknown> {
    const threadId = requiredString(payload, "threadId");
    const thread = await this.#readAuthorizedThread({
      threadId,
      includeTurns: false,
    });
    const { threadId: _threadId, ...turnPayload } = payload;
    if (!Array.isArray(turnPayload.input))
      throw new Error("queue/add requires input");
    rejectLocalImageInput(turnPayload.input);
    const item = await this.#queue.add({
      workspacePath: thread.thread.cwd,
      threadId,
      turnPayload,
    });
    void this.#queueDispatcher?.watchThread(threadId).catch(() => undefined);
    return item;
  }

  async #removeQueueItem(
    payload: Record<string, unknown>,
  ): Promise<{ removed: boolean }> {
    const id = requiredString(payload, "id");
    const item = await this.#queue.get(id);
    if (!item) return { removed: false };
    await this.#workspaces.resolve(item.workspacePath);
    return { removed: await this.#queue.remove(id) };
  }

  async #steerQueueItem(payload: Record<string, unknown>): Promise<unknown> {
    const id = requiredString(payload, "id");
    const expectedTurnId = requiredString(payload, "expectedTurnId");
    const claim = await this.#queue.claimForSteer(id);
    if (!claim) throw new Error("Queued message is no longer available");
    try {
      await this.#workspaces.resolve(claim.item.workspacePath);
      await this.#ensureThreadLoaded(claim.item.threadId);
      const input = claim.item.turnPayload.input;
      if (!Array.isArray(input)) throw new Error("Queued message has no input");
      const response = await this.#client.request<TurnSteerResponse>(
        "turn/steer",
        {
          threadId: claim.item.threadId,
          expectedTurnId,
          input,
          ...(typeof claim.item.turnPayload.clientUserMessageId === "string"
            ? {
                clientUserMessageId: claim.item.turnPayload.clientUserMessageId,
              }
            : {}),
        },
      );
      await this.#queue.finish(claim.item.id);
      if (this.#queueDispatcher) {
        this.#queueDispatcher.notifySteered(claim.item.id, claim.item.threadId);
      } else {
        this.#emit("queue/steered", {
          itemId: claim.item.id,
          threadId: claim.item.threadId,
        });
      }
      return { itemId: claim.item.id, turnId: response.turnId };
    } catch (error) {
      await this.#queue.restoreSteerClaim(claim.item.id, claim.previousStatus);
      throw error;
    }
  }

  async #drainQueue(threadId: string): Promise<void> {
    const item = await this.#queue.claimNext(threadId);
    if (!item) return;
    try {
      const turnPayload = {
        ...item.turnPayload,
        threadId,
      };
      if (hasThreadPermissionUpdate(turnPayload)) {
        await this.#threadPermissions.serializeMutation(threadId, async () => {
          const observation =
            await this.#threadPermissions.beginObservation(threadId);
          await this.#client.request("turn/start", turnPayload);
          await this.#threadPermissions.saveSettingsUpdate(
            threadId,
            turnPayload,
            observation,
          );
        });
      } else {
        await this.#client.request("turn/start", turnPayload);
      }
      await this.#queue.finish(item.id);
      this.#emit("queue/started", { itemId: item.id, threadId });
    } catch (error) {
      await this.#queue.pause(item.id);
      this.#emit("queue/paused", {
        itemId: item.id,
        threadId,
        reason: error instanceof Error ? error.message : "Queue start failed",
      });
    }
  }

  async #respondToServerRequest(
    payload: Record<string, unknown>,
  ): Promise<{ accepted: true }> {
    const requestId = requiredString(payload, "requestId");
    const pending = this.#serverRequests.get(requestId);
    if (!pending) {
      const error = isRecord(payload.error)
        ? {
            code: safeErrorCode(payload.error.code),
            message: String(payload.error.message ?? "Rejected by user"),
          }
        : undefined;
      if (
        await this.#queueDispatcher?.respondToServerRequest({
          requestId,
          ...(error ? { error } : { result: payload.result }),
        })
      ) {
        return { accepted: true };
      }
      throw new Error("Codex server request is no longer pending");
    }
    const threadId = extractThreadId(pending.params);
    if (threadId) {
      try {
        await this.#authorizeThread(threadId);
      } catch {
        this.#serverRequests.delete(requestId);
        pending.reject({
          code: -32_000,
          message: "Workspace authorization was revoked",
        });
        throw new Error(
          "Workspace authorization was revoked for this server request",
        );
      }
    }
    this.#serverRequests.delete(requestId);
    if (isRecord(payload.error)) {
      const message = String(payload.error.message ?? "Rejected by user");
      pending.reject({
        code: safeErrorCode(payload.error.code),
        message,
      });
    } else {
      pending.respond(payload.result);
    }
    return { accepted: true };
  }

  async #forwardNotification(notification: CodexNotification): Promise<void> {
    const threadId = extractThreadId(notification.params);
    if (threadId && !(await this.#threadAuthorizationIsCurrent(threadId))) {
      try {
        await this.#authorizeThread(threadId);
      } catch {
        return;
      }
    }
    this.#emit(`codex/${notification.method}`, notification.params);
    if (
      !this.#queueDispatcher &&
      notification.method === "turn/completed" &&
      turnCompletedSuccessfully(notification.params) &&
      threadId
    ) {
      await this.#drainQueue(threadId);
    } else if (
      !this.#queueDispatcher &&
      notification.method === "turn/completed" &&
      threadId
    ) {
      const paused = await this.#queue.pausePending(threadId);
      for (const item of paused) {
        this.#emit("queue/paused", {
          itemId: item.id,
          threadId,
          reason: "Previous turn did not complete successfully",
        });
      }
    }
  }

  async #forwardServerRequest(request: CodexServerRequest): Promise<void> {
    const threadId = extractThreadId(request.params);
    if (!threadId) return;
    if (!(await this.#threadAuthorizationIsCurrent(threadId))) {
      try {
        await this.#authorizeThread(threadId);
      } catch {
        return;
      }
    }
    const requestId = String(request.id);
    this.#serverRequests.set(requestId, request);
    this.#emit("codex/serverRequest", {
      requestId,
      method: request.method,
      params: request.params,
    });
  }

  async #forwardQueueEvent(event: QueueDispatcherEvent): Promise<void> {
    const threadId =
      extractThreadId(event.payload) ?? extractThreadId(event.payload.params);
    if (threadId && !(await this.#threadAuthorizationIsCurrent(threadId))) {
      try {
        await this.#authorizeThread(threadId);
      } catch {
        return;
      }
    }
    this.#emit(event.type, event.payload);
  }

  async #threadAuthorizationIsCurrent(threadId: string): Promise<boolean> {
    return (
      this.#authorizedThreads.get(threadId) ===
      (await this.#workspaces.authorizationRevision())
    );
  }

  #emit(type: string, payload: unknown): void {
    const cursor = String(++this.#cursor);
    this.#events.emit("event", {
      version: PROTOCOL_VERSION,
      eventId: randomUUID(),
      cursor,
      type,
      payload,
    });
  }
}

function requireAbsoluteWorkspacePath(path: string): void {
  if (!isAbsolute(path))
    throw new Error(
      "Workspace path must be an absolute path on the Codex host",
    );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Request payload must be an object");
  return value;
}

function hasThreadPermissionUpdate(payload: Record<string, unknown>): boolean {
  return (
    payload.approvalPolicy != null ||
    payload.approvalsReviewer != null ||
    payload.sandboxPolicy != null
  );
}

function requiredString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Request requires ${key}`);
  }
  return value[key];
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  if (value[key] === undefined) return undefined;
  return requiredString(value, key);
}

function rejectLocalImageInput(value: unknown): void {
  if (!Array.isArray(value)) return;
  if (value.some((part) => isRecord(part) && part.type === "localImage")) {
    throw new Error("Image attachments are not supported by the Web client");
  }
}

function extractThreadId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.threadId === "string") return value.threadId;
  if (isRecord(value.thread) && typeof value.thread.id === "string") {
    return value.thread.id;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function turnCompletedSuccessfully(value: unknown): boolean {
  return (
    isRecord(value) && isRecord(value.turn) && value.turn.status === "completed"
  );
}

function safeErrorCode(value: unknown): number {
  const code = Number(value);
  return Number.isSafeInteger(code) ? code : -32_000;
}

export function threadNeedsResume(status: ThreadStatus): boolean {
  return status.type === "notLoaded";
}
