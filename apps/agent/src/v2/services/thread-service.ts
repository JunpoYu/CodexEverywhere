import { randomUUID } from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayV2Error,
  THREAD_TITLE_MAX_LENGTH,
  jsonValueSchema,
  type InputOf,
  type InteractionResponse,
  type JsonValue,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import type { CodexClient, CodexClientFactoryPort } from "../codex/index.js";
import {
  type StoredThreadSettings,
  type ThreadSettingsRepository,
  ThreadSettingsRevisionConflictError,
} from "../repositories/thread-settings-repository.js";
import { InteractionAlreadyResolvedError } from "./interaction-broker.js";
import type { PreferencesService } from "./preferences-service.js";
import type {
  ThreadLease,
  ThreadLeaseHandle,
  ThreadLeaseManager,
  ThreadLeaseState,
} from "./thread-lease-manager.js";
import type { WorkspaceService, WorkspaceView } from "./workspace-service.js";

type ThreadSummary = OutputOf<"thread/list">["threads"][number];
type TimelineItem = OutputOf<"thread/history">["items"][number];
type ThreadSettingsView = OutputOf<"thread/settings/update">;

interface RuntimeThreadSettings {
  readonly model?: string;
  readonly effort?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
}

export interface ThreadServiceOptions {
  readonly scope: Scope;
  readonly clients: CodexClientFactoryPort;
  readonly leases: ThreadLeaseManager;
  readonly workspaces: WorkspaceService;
  readonly preferences: PreferencesService;
  readonly settings: ThreadSettingsRepository;
  readonly appServerSocketPath?: string;
}

/** Maps authoritative Codex threads into CE task views without owning Agent state. */
export class ThreadService {
  readonly #scope: Scope;
  readonly #clients: CodexClientFactoryPort;
  readonly #leases: ThreadLeaseManager;
  readonly #workspaces: WorkspaceService;
  readonly #preferences: PreferencesService;
  readonly #settings: ThreadSettingsRepository;
  readonly #appServerSocketPath: string | undefined;
  readonly #runtimeSettings = new Map<string, RuntimeThreadSettings>();

  constructor(options: ThreadServiceOptions) {
    this.#scope = options.scope.fork("threads");
    this.#clients = options.clients;
    this.#leases = options.leases;
    this.#workspaces = options.workspaces;
    this.#preferences = options.preferences;
    this.#settings = options.settings;
    this.#appServerSocketPath = options.appServerSocketPath;
  }

  async list(input: InputOf<"thread/list">): Promise<OutputOf<"thread/list">> {
    const workspaces = await this.#workspaces.list();
    const selected =
      input.workspaceId === undefined
        ? workspaces
        : workspaces.filter((workspace) => workspace.id === input.workspaceId);
    if (input.workspaceId !== undefined && selected.length === 0) {
      throw new GatewayV2Error("WORKSPACE_NOT_FOUND", "Workspace not found");
    }
    if (selected.length === 0) {
      return { version: 1, threads: [], hasMore: false };
    }

    return this.#withClient("thread-list", async (client) => {
      const collected: ThreadSummary[] = [];
      let cursor = input.cursor;
      let nextCursor: string | undefined;
      for (
        let page = 0;
        page < 20 && collected.length < input.limit;
        page += 1
      ) {
        const result = parseThreadListResponse(
          await client.request("thread/list", {
            ...(cursor === undefined ? {} : { cursor }),
            limit: input.limit - collected.length,
            archived: input.archived,
            sortKey: "updated_at",
            sortDirection: "desc",
          }),
        );
        for (const thread of result.threads) {
          const workspace = await this.#authorizedWorkspace(
            requiredString(thread.cwd, "thread cwd"),
          );
          if (
            workspace !== undefined &&
            selected.some((candidate) => candidate.id === workspace.id)
          ) {
            collected.push(threadSummary(thread, workspace, input.archived));
          }
        }
        nextCursor = result.nextCursor;
        if (nextCursor === undefined) break;
        cursor = nextCursor;
      }
      return {
        version: 1,
        threads: collected,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        hasMore: nextCursor !== undefined,
      };
    });
  }

  async open(
    handle: ThreadLeaseHandle,
    input: Pick<InputOf<"thread/open">, "historyCursor" | "historyLimit">,
  ): Promise<OutputOf<"thread/open">> {
    const stored = await this.#settings.read(handle.threadId);
    const response = jsonObject(
      await handle.lease.request("thread/resume", {
        threadId: handle.threadId,
        ...(stored.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: stored.approvalPolicy }),
        ...(stored.sandbox === undefined ? {} : { sandbox: stored.sandbox }),
      }),
      "thread/resume response",
    );
    const thread = requiredObject(response.thread, "resumed thread");
    const state = handle.lease.adoptAuthoritativeThread(thread);
    const workspace = await this.#workspaces.workspaceForPath(
      state.workspacePath,
    );
    const runtime = runtimeSettings(response, stored);
    this.#runtimeSettings.set(handle.threadId, runtime);
    const page = historyPage(
      timelineFromThread(thread),
      input.historyCursor,
      input.historyLimit,
    );
    return {
      version: 1,
      thread: threadSummary(thread, workspace, false),
      state: state.state,
      items: page.items,
      interactions: handle.lease.listInteractions(),
      ...(page.nextCursor === undefined
        ? {}
        : { historyCursor: page.nextCursor }),
      hasEarlierHistory: page.hasMore,
      settings: settingsView(stored.revision, runtime),
    };
  }

  async history(
    handle: ThreadLeaseHandle,
    input: Pick<InputOf<"thread/history">, "cursor" | "limit">,
  ): Promise<OutputOf<"thread/history">> {
    const state = await handle.lease.synchronize(true);
    await this.#workspaces.resolve(state.workspacePath);
    const page = historyPage(
      timelineFromThread(requiredObject(state.thread, "thread")),
      input.cursor,
      input.limit,
    );
    return {
      version: 1,
      items: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      hasMore: page.hasMore,
    };
  }

  async start(
    input: InputOf<"thread/start">,
  ): Promise<OutputOf<"thread/start">> {
    const workspace = await this.#workspaces.get(input.workspaceId);
    const path = await this.#workspaces.resolve(workspace.path);
    const preferences = await this.#preferences.read();
    const requested = input.settings ?? {};
    const sandbox = requested.sandbox ?? preferences.sandbox;
    const approvalPolicy =
      requested.approvalPolicy ?? preferences.approvalPolicy;

    const started = await this.#withClient("thread-start", async (client) =>
      jsonObject(
        await client.request("thread/start", {
          cwd: path,
          ...(requested.model === undefined ? {} : { model: requested.model }),
          approvalPolicy,
          approvalsReviewer: "user",
          sandbox,
          ...(requested.effort === undefined
            ? {}
            : { config: { model_reasoning_effort: requested.effort } }),
        }),
        "thread/start response",
      ),
    );
    const thread = requiredObject(started.thread, "started thread");
    const threadId = requiredString(thread.id, "thread id");
    const currentWorkspace = await this.#workspaces.workspaceForPath(
      requiredString(thread.cwd, "thread cwd"),
    );
    const stored = await this.#settings.save(threadId, 0, {
      sandbox,
      approvalPolicy,
    });
    this.#runtimeSettings.set(threadId, {
      ...runtimeSettings(started, stored),
      ...(requested.model === undefined ? {} : { model: requested.model }),
      ...(requested.effort === undefined ? {} : { effort: requested.effort }),
    });

    // The first turn must be owned by a lease before it can emit an approval
    // or user question. The running state keeps the lease alive even if the
    // browser has not navigated to the new task yet.
    const handle = await this.#leases.acquire(threadId, {
      kind: "queue",
      id: `thread-start:${randomUUID()}`,
    });
    try {
      const resumed = jsonObject(
        await handle.lease.request("thread/resume", {
          threadId,
          approvalPolicy,
          sandbox,
        }),
        "thread/resume response",
      );
      handle.lease.adoptAuthoritativeThread(
        requiredObject(resumed.thread, "resumed thread"),
      );
      const turn = jsonObject(
        await handle.lease.request("turn/start", {
          threadId,
          clientUserMessageId: randomUUID(),
          cwd: currentWorkspace.path,
          input: textInput(input.prompt),
          ...(requested.model === undefined ? {} : { model: requested.model }),
          ...(requested.effort === undefined
            ? {}
            : { effort: requested.effort }),
          approvalPolicy,
          approvalsReviewer: "user",
          sandboxPolicy: sandboxPolicy(sandbox),
        }),
        "turn/start response",
      );
      const turnId = requiredString(
        requiredObject(turn.turn, "started turn").id,
        "turn id",
      );
      handle.lease.noteTurnStarted(turnId);
      return {
        version: 1,
        thread: {
          ...threadSummary(thread, currentWorkspace, false),
          state: "running",
        },
        turnId,
      };
    } finally {
      await handle.release();
    }
  }

  async turnStart(
    handle: ThreadLeaseHandle,
    prompt: string,
  ): Promise<OutputOf<"turn/start">> {
    const state = await handle.lease.synchronize(false);
    await this.#workspaces.resolve(state.workspacePath);
    if (state.state !== "idle") {
      throw new GatewayV2Error(
        "THREAD_NOT_IDLE",
        "Task is not idle; add the message to Queue instead",
      );
    }
    const response = jsonObject(
      await handle.lease.request("turn/start", {
        threadId: handle.threadId,
        clientUserMessageId: randomUUID(),
        input: textInput(prompt),
      }),
      "turn/start response",
    );
    const turnId = requiredString(
      requiredObject(response.turn, "started turn").id,
      "turn id",
    );
    handle.lease.noteTurnStarted(turnId);
    return { version: 1, threadId: handle.threadId, turnId };
  }

  async interrupt(
    handle: ThreadLeaseHandle,
    turnId?: string,
  ): Promise<OutputOf<"turn/interrupt">> {
    const state = await handle.lease.synchronize(true);
    await this.#workspaces.resolve(state.workspacePath);
    const target = turnId ?? state.currentTurnId;
    if (target === undefined) {
      throw new GatewayV2Error("TURN_NOT_RUNNING", "Task has no active turn");
    }
    await handle.lease.request("turn/interrupt", {
      threadId: handle.threadId,
      turnId: target,
    });
    return { version: 1, interrupted: true };
  }

  listInteractions(handle: ThreadLeaseHandle): OutputOf<"interaction/list"> {
    return { version: 1, interactions: handle.lease.listInteractions() };
  }

  async respondToInteraction(
    handle: ThreadLeaseHandle,
    interactionId: string,
    response: InteractionResponse,
  ): Promise<OutputOf<"interaction/respond">> {
    try {
      await handle.lease.respondToInteraction(interactionId, response);
    } catch (error) {
      if (error instanceof InteractionAlreadyResolvedError) {
        throw new GatewayV2Error(
          "INTERACTION_ALREADY_RESOLVED",
          "Another client already resolved this interaction",
        );
      }
      throw error;
    }
    return { version: 1, interactionId, resolved: true };
  }

  async rename(threadId: string, title: string): Promise<ThreadSummary> {
    return this.#withAuthorizedLease(
      threadId,
      "rename",
      async (lease, workspace) => {
        await lease.request("thread/name/set", { threadId, name: title });
        const state = await lease.synchronize(false);
        return threadSummary(
          requiredObject(state.thread, "thread"),
          workspace,
          false,
        );
      },
    );
  }

  async archive(threadId: string): Promise<ThreadSummary> {
    return this.#withAuthorizedLease(
      threadId,
      "archive",
      async (lease, workspace) => {
        await lease.request("thread/archive", { threadId });
        const state = await lease.synchronize(false);
        return threadSummary(
          requiredObject(state.thread, "thread"),
          workspace,
          true,
        );
      },
    );
  }

  async unarchive(threadId: string): Promise<ThreadSummary> {
    return this.#withAuthorizedLease(
      threadId,
      "unarchive",
      async (lease, workspace) => {
        const response = jsonObject(
          await lease.request("thread/unarchive", { threadId }),
          "thread/unarchive response",
        );
        const thread = requiredObject(response.thread, "unarchived thread");
        lease.adoptAuthoritativeThread(thread);
        return threadSummary(thread, workspace, false);
      },
    );
  }

  async delete(threadId: string): Promise<boolean> {
    await this.#withAuthorizedLease(threadId, "delete", async (lease) => {
      await lease.request("thread/delete", { threadId });
    });
    this.#runtimeSettings.delete(threadId);
    await this.#settings.remove(threadId);
    await this.#leases.closeThread(threadId, "thread-deleted");
    return true;
  }

  async updateSettings(
    handle: ThreadLeaseHandle,
    input: InputOf<"thread/settings/update">,
  ): Promise<ThreadSettingsView> {
    const stored = await this.#settings.read(handle.threadId);
    if (stored.revision !== input.expectedRevision) {
      throw revisionConflict();
    }
    const state = await handle.lease.synchronize(false);
    await this.#workspaces.resolve(state.workspacePath);
    let runtime = this.#runtimeSettings.get(handle.threadId);
    if (runtime === undefined) {
      const resumed = jsonObject(
        await handle.lease.request("thread/resume", {
          threadId: handle.threadId,
          ...(stored.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: stored.approvalPolicy }),
          ...(stored.sandbox === undefined ? {} : { sandbox: stored.sandbox }),
        }),
        "thread/resume response",
      );
      runtime = runtimeSettings(resumed, stored);
    }
    const next: RuntimeThreadSettings = {
      ...runtime,
      ...(input.patch.model === undefined ? {} : { model: input.patch.model }),
      ...(input.patch.effort === undefined
        ? {}
        : { effort: input.patch.effort }),
      ...(input.patch.sandbox === undefined
        ? {}
        : { sandbox: input.patch.sandbox }),
      ...(input.patch.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: input.patch.approvalPolicy }),
    };
    await handle.lease.request("thread/settings/update", {
      threadId: handle.threadId,
      ...(input.patch.model === undefined ? {} : { model: input.patch.model }),
      ...(input.patch.effort === undefined
        ? {}
        : { effort: input.patch.effort }),
      ...(input.patch.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: input.patch.approvalPolicy }),
      ...(input.patch.sandbox === undefined
        ? {}
        : { sandboxPolicy: sandboxPolicy(input.patch.sandbox) }),
    });
    let saved: StoredThreadSettings;
    try {
      saved = await this.#settings.save(handle.threadId, stored.revision, {
        ...(next.sandbox === undefined ? {} : { sandbox: next.sandbox }),
        ...(next.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: next.approvalPolicy }),
      });
    } catch (error) {
      if (error instanceof ThreadSettingsRevisionConflictError) {
        throw revisionConflict();
      }
      throw error;
    }
    this.#runtimeSettings.set(handle.threadId, next);
    return settingsView(saved.revision, next);
  }

  async tuiHandoff(threadId: string): Promise<OutputOf<"thread/tui/handoff">> {
    if (this.#appServerSocketPath === undefined) {
      throw new GatewayV2Error(
        "CAPABILITY_UNAVAILABLE",
        "TUI handoff is not configured on this host",
      );
    }
    const state = await this.#withAuthorizedLease(threadId, "tui", (lease) =>
      lease.synchronize(false),
    );
    return {
      version: 1,
      command: [
        "codex",
        "resume",
        "--include-non-interactive",
        "--remote",
        `unix://${this.#appServerSocketPath}`,
        "-C",
        state.workspacePath,
        threadId,
      ]
        .map(shellQuote)
        .join(" "),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async #withClient<Result>(
    name: string,
    operation: (client: CodexClient) => Promise<Result>,
  ): Promise<Result> {
    const scope = this.#scope.fork(`${name}-${randomUUID()}`);
    try {
      return await operation(await this.#clients.create(scope));
    } finally {
      await scope.close("request-completed");
    }
  }

  async #withAuthorizedLease<Result>(
    threadId: string,
    operationName: string,
    operation: (
      lease: ThreadLease,
      workspace: WorkspaceView,
    ) => Promise<Result>,
  ): Promise<Result> {
    const handle = await this.#leases.acquire(threadId, {
      kind: "queue",
      id: `thread-${operationName}:${randomUUID()}`,
    });
    try {
      const state = await handle.lease.synchronize(false);
      const workspace = await this.#workspaces.workspaceForPath(
        state.workspacePath,
      );
      return await operation(handle.lease, workspace);
    } finally {
      await handle.release();
    }
  }

  async #authorizedWorkspace(path: string): Promise<WorkspaceView | undefined> {
    try {
      return await this.#workspaces.workspaceForPath(path);
    } catch {
      return undefined;
    }
  }
}

interface HistoryPage {
  readonly items: TimelineItem[];
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

function historyPage(
  items: TimelineItem[],
  cursor: string | undefined,
  limit: number,
): HistoryPage {
  let end = items.length;
  if (cursor !== undefined) {
    const boundaryId = decodeHistoryCursor(cursor);
    const boundary = items.findIndex((item) => item.id === boundaryId);
    if (boundary < 0) {
      throw new GatewayV2Error(
        "HISTORY_CURSOR_STALE",
        "History cursor is no longer present in the authoritative task",
      );
    }
    end = boundary;
  }
  const start = Math.max(0, end - limit);
  const page = items.slice(start, end);
  return {
    items: page,
    ...(start === 0 || page.length === 0
      ? {}
      : { nextCursor: encodeHistoryCursor(page[0]!.id) }),
    hasMore: start > 0,
  };
}

function timelineFromThread(
  thread: Readonly<Record<string, JsonValue>>,
): TimelineItem[] {
  if (!Array.isArray(thread.turns)) return [];
  const timeline: TimelineItem[] = [];
  for (const [turnIndex, value] of thread.turns.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      continue;
    const turn = value as Readonly<Record<string, JsonValue>>;
    const turnId =
      typeof turn.id === "string" && turn.id.length > 0
        ? turn.id
        : `turn-${turnIndex}`;
    const createdAt = timestampFromSeconds(turn.startedAt);
    if (Array.isArray(turn.items)) {
      for (const [itemIndex, raw] of turn.items.entries()) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
          continue;
        const item = raw as Readonly<Record<string, JsonValue>>;
        const id =
          typeof item.id === "string" && item.id.length > 0
            ? item.id
            : `${turnId}:item:${itemIndex}`;
        timeline.push({
          version: 1,
          id,
          turnId,
          type: timelineType(item.type),
          ...(createdAt === undefined ? {} : { createdAt }),
          data: item,
        });
      }
    }
    if (turn.error !== null && turn.error !== undefined) {
      const error = jsonValueSchema.safeParse(turn.error);
      timeline.push({
        version: 1,
        id: `${turnId}:error`,
        turnId,
        type: "error",
        ...(createdAt === undefined ? {} : { createdAt }),
        data:
          error.success && isJsonObject(error.data)
            ? error.data
            : { message: "Codex turn failed" },
      });
    }
  }
  return timeline;
}

function timelineType(value: JsonValue | undefined): TimelineItem["type"] {
  if (
    value === "userMessage" ||
    value === "agentMessage" ||
    value === "reasoning" ||
    value === "hookPrompt"
  )
    return "message";
  if (value === "plan") return "plan";
  if (value === "commandExecution") return "command";
  if (value === "fileChange") return "file-change";
  if (value === "mcpToolCall" || value === "dynamicToolCall") return "mcp";
  if (value === "collabAgentToolCall" || value === "subAgentActivity")
    return "subagent";
  return "generic";
}

function threadSummary(
  thread: Readonly<Record<string, JsonValue>>,
  workspace: WorkspaceView,
  archived: boolean,
): ThreadSummary {
  const name = typeof thread.name === "string" ? thread.name : undefined;
  const preview = typeof thread.preview === "string" ? thread.preview : "";
  return {
    version: 1,
    id: requiredString(thread.id, "thread id"),
    workspaceId: workspace.id,
    title: boundedThreadTitle(name ?? preview),
    state: threadState(thread.status),
    archived,
    createdAt: requiredTimestamp(thread.createdAt, "thread createdAt"),
    updatedAt: requiredTimestamp(thread.updatedAt, "thread updatedAt"),
  };
}

function boundedThreadTitle(value: string): string {
  if (value.length <= THREAD_TITLE_MAX_LENGTH) return value;

  let end = THREAD_TITLE_MAX_LENGTH;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function threadState(value: JsonValue | undefined): ThreadLeaseState {
  const status = requiredObject(value, "thread status");
  if (status.type === "active") return "running";
  if (status.type === "systemError") return "failed";
  return "idle";
}

function settingsView(
  revision: number,
  settings: RuntimeThreadSettings,
): ThreadSettingsView {
  return {
    version: 1,
    revision,
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.effort === undefined ? {} : { effort: settings.effort }),
    ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
    ...(settings.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: settings.approvalPolicy }),
  };
}

function runtimeSettings(
  response: Readonly<Record<string, JsonValue>>,
  stored: StoredThreadSettings,
): RuntimeThreadSettings {
  const model = typeof response.model === "string" ? response.model : undefined;
  const effort =
    typeof response.reasoningEffort === "string"
      ? response.reasoningEffort
      : typeof response.effort === "string"
        ? response.effort
        : undefined;
  const approvalPolicy =
    approvalFromValue(response.approvalPolicy) ?? stored.approvalPolicy;
  const sandbox = sandboxFromValue(response.sandbox) ?? stored.sandbox;
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  };
}

function approvalFromValue(
  value: JsonValue | undefined,
): RuntimeThreadSettings["approvalPolicy"] {
  return value === "untrusted" || value === "on-request" || value === "never"
    ? value
    : undefined;
}

function sandboxFromValue(
  value: JsonValue | undefined,
): RuntimeThreadSettings["sandbox"] {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  )
    return value;
  if (!isJsonObject(value)) return undefined;
  if (value.type === "readOnly") return "read-only";
  if (value.type === "workspaceWrite") return "workspace-write";
  if (value.type === "dangerFullAccess") return "danger-full-access";
  return undefined;
}

function sandboxPolicy(
  value: "read-only" | "workspace-write" | "danger-full-access",
): Readonly<Record<string, JsonValue>> {
  if (value === "read-only") return { type: "readOnly", networkAccess: false };
  if (value === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: "dangerFullAccess" };
}

function textInput(text: string): readonly JsonValue[] {
  return [{ type: "text", text, text_elements: [] }];
}

function parseThreadListResponse(value: unknown): {
  readonly threads: Readonly<Record<string, JsonValue>>[];
  readonly nextCursor?: string;
} {
  const response = jsonObject(value, "thread/list response");
  if (!Array.isArray(response.data)) throw new Error("Thread list has no data");
  const threads = response.data.map((entry) => requiredObject(entry, "thread"));
  const nextCursor =
    typeof response.nextCursor === "string" && response.nextCursor.length > 0
      ? response.nextCursor
      : undefined;
  return { threads, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function jsonObject(
  value: unknown,
  field: string,
): Readonly<Record<string, JsonValue>> {
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || !isJsonObject(parsed.data)) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed.data;
}

function requiredObject(
  value: JsonValue | undefined,
  field: string,
): Readonly<Record<string, JsonValue>> {
  if (!isJsonObject(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function requiredTimestamp(
  value: JsonValue | undefined,
  field: string,
): string {
  const timestamp = timestampFromSeconds(value);
  if (timestamp === undefined) throw new Error(`Invalid ${field}`);
  return timestamp;
}

function timestampFromSeconds(
  value: JsonValue | undefined,
): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return undefined;
  return new Date(value * 1_000).toISOString();
}

function encodeHistoryCursor(itemId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, beforeItemId: itemId }),
  ).toString("base64url");
}

function decodeHistoryCursor(value: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).version === 1 &&
      typeof (parsed as Record<string, unknown>).beforeItemId === "string"
    ) {
      return (parsed as { beforeItemId: string }).beforeItemId;
    }
  } catch {
    // Converted into a stable public protocol error below.
  }
  throw new GatewayV2Error("INVALID_CURSOR", "History cursor is invalid");
}

function revisionConflict(): GatewayV2Error {
  return new GatewayV2Error(
    "REVISION_CONFLICT",
    "Task settings changed; refresh before saving",
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
