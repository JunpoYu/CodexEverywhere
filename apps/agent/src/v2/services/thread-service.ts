import { randomUUID } from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayV2Error,
  type InputOf,
  type InteractionResponse,
  type JsonValue,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import type { CodexClient, CodexClientFactoryPort } from "../codex/index.js";
import {
  parseCodexObject,
  requireCodexObject,
  requireCodexString,
} from "../codex/codex-json.js";
import type { ThreadSettingsRepository } from "../repositories/thread-settings-repository.js";
import { InteractionAlreadyResolvedError } from "./interaction-broker.js";
import type { PreferencesService } from "./preferences-service.js";
import type {
  ThreadLease,
  ThreadLeaseHandle,
  ThreadLeaseManager,
} from "./thread-lease-manager.js";
import { ThreadSessionCoordinator } from "./thread-session-coordinator.js";
import type { WorkspaceService, WorkspaceView } from "./workspace-service.js";
import {
  parseThreadListResponse,
  projectThreadHistory,
  projectThreadSummary,
} from "./thread-projection.js";
import {
  codexSandboxPolicy,
  type RuntimeThreadSettings,
} from "./thread-settings.js";

type ThreadSummary = OutputOf<"thread/list">["threads"][number];
type ThreadSettingsView = OutputOf<"thread/settings/update">;

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
  readonly #sessions: ThreadSessionCoordinator;
  readonly #appServerSocketPath: string | undefined;

  constructor(options: ThreadServiceOptions) {
    this.#scope = options.scope.fork("threads");
    this.#clients = options.clients;
    this.#leases = options.leases;
    this.#workspaces = options.workspaces;
    this.#preferences = options.preferences;
    this.#sessions = new ThreadSessionCoordinator({
      scope: this.#scope,
      settings: options.settings,
      workspaces: options.workspaces,
    });
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
            requireCodexString(thread.cwd, "thread cwd"),
          );
          if (
            workspace !== undefined &&
            selected.some((candidate) => candidate.id === workspace.id)
          ) {
            collected.push(
              projectThreadSummary(thread, workspace, input.archived),
            );
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
    const { thread, state, settings } = await this.#sessions.open(handle);
    const workspace = await this.#workspaces.workspaceForPath(
      state.workspacePath,
    );
    const page = projectThreadHistory(
      thread,
      input.historyCursor,
      input.historyLimit,
    );
    return {
      version: 1,
      thread: projectThreadSummary(thread, workspace, false),
      state: state.state,
      items: page.items,
      interactions: handle.lease.listInteractions(),
      ...(page.nextCursor === undefined
        ? {}
        : { historyCursor: page.nextCursor }),
      hasEarlierHistory: page.hasMore,
      settings,
    };
  }

  async history(
    handle: ThreadLeaseHandle,
    input: Pick<InputOf<"thread/history">, "cursor" | "limit">,
  ): Promise<OutputOf<"thread/history">> {
    const state = await handle.lease.synchronize(true);
    await this.#workspaces.resolve(state.workspacePath);
    const page = projectThreadHistory(
      requireCodexObject(state.thread, "thread"),
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
    const requested = input.settings ?? {};
    const startWithPermissions = async (
      sandbox: NonNullable<RuntimeThreadSettings["sandbox"]>,
      approvalPolicy: NonNullable<RuntimeThreadSettings["approvalPolicy"]>,
    ) =>
      this.#leases.start(
        async (client) => {
          const started = parseCodexObject(
            await client.request("thread/start", {
              cwd: path,
              ...(requested.model === undefined
                ? {}
                : { model: requested.model }),
              approvalPolicy,
              approvalsReviewer: "user",
              sandbox,
              ...(requested.effort === undefined
                ? {}
                : { config: { model_reasoning_effort: requested.effort } }),
            }),
            "thread/start response",
          );
          const thread = requireCodexObject(started.thread, "started thread");
          return {
            threadId: requireCodexString(thread.id, "thread id"),
            result: { sandbox, approvalPolicy, started },
          };
        },
        {
          kind: "queue",
          id: `thread-start:${randomUUID()}`,
        },
      );
    let accepted: Awaited<ReturnType<typeof startWithPermissions>>;
    if (
      requested.sandbox === undefined ||
      requested.approvalPolicy === undefined
    ) {
      const mutation = await this.#preferences.acquireMutation({
        signal: this.#scope.signal,
      });
      try {
        const preferences = await this.#preferences.read();
        if (input.expectedPreferencesRevision !== preferences.revision) {
          throw new GatewayV2Error(
            "REVISION_CONFLICT",
            "Default preferences changed; refresh before starting the task",
          );
        }
        accepted = await startWithPermissions(
          requested.sandbox ?? preferences.sandbox,
          requested.approvalPolicy ?? preferences.approvalPolicy,
        );
      } finally {
        await mutation.release();
      }
    } else {
      accepted = await startWithPermissions(
        requested.sandbox,
        requested.approvalPolicy,
      );
    }
    const {
      handle,
      result: { approvalPolicy, sandbox, started },
    } = accepted;
    const thread = requireCodexObject(started.thread, "started thread");
    const threadId = handle.threadId;
    let settingsRemembered = false;
    try {
      const currentWorkspace = await this.#workspaces.workspaceForPath(
        requireCodexString(thread.cwd, "thread cwd"),
      );
      handle.lease.adoptAuthoritativeThread(thread);
      const startedSettings = await this.#sessions.rememberStarted({
        threadId,
        started,
        sandbox,
        approvalPolicy,
        ...(requested.model === undefined ? {} : { model: requested.model }),
        ...(requested.effort === undefined ? {} : { effort: requested.effort }),
      });
      settingsRemembered = true;
      this.#sessions.markResumed(handle.lease, startedSettings);

      // The same lease-owned client that created the empty thread starts its
      // first turn. Codex does not publish a resumable rollout until that
      // boundary, and interactions may arrive immediately after turn/start.
      const turn = parseCodexObject(
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
          sandboxPolicy: codexSandboxPolicy(sandbox),
        }),
        "turn/start response",
      );
      const turnId = requireCodexString(
        requireCodexObject(turn.turn, "started turn").id,
        "turn id",
      );
      handle.lease.noteTurnStarted(turnId);
      return {
        version: 1,
        thread: {
          ...projectThreadSummary(thread, currentWorkspace, false),
          state: "running",
        },
        turnId,
      };
    } catch (error) {
      if (
        settingsRemembered &&
        error instanceof GatewayV2Error &&
        error.code === "CODEX_REQUEST_REJECTED"
      ) {
        await this.#sessions.remove(threadId).catch(() => undefined);
      }
      throw error;
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
    const response = parseCodexObject(
      await handle.lease.request("turn/start", {
        threadId: handle.threadId,
        clientUserMessageId: randomUUID(),
        input: textInput(prompt),
      }),
      "turn/start response",
    );
    const turnId = requireCodexString(
      requireCodexObject(response.turn, "started turn").id,
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
        return projectThreadSummary(
          requireCodexObject(state.thread, "thread"),
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
        return projectThreadSummary(
          requireCodexObject(state.thread, "thread"),
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
        const response = parseCodexObject(
          await lease.request("thread/unarchive", { threadId }),
          "thread/unarchive response",
        );
        const thread = requireCodexObject(response.thread, "unarchived thread");
        lease.adoptAuthoritativeThread(thread);
        return projectThreadSummary(thread, workspace, false);
      },
    );
  }

  async delete(threadId: string): Promise<boolean> {
    await this.#withAuthorizedLease(threadId, "delete", async (lease) => {
      await lease.request("thread/delete", { threadId });
    });
    await this.#sessions.remove(threadId);
    await this.#leases.closeThread(threadId, "thread-deleted");
    return true;
  }

  async updateSettings(
    handle: ThreadLeaseHandle,
    input: InputOf<"thread/settings/update">,
  ): Promise<ThreadSettingsView> {
    return this.#sessions.updateSettings(handle, input);
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

function textInput(text: string): readonly JsonValue[] {
  return [{ type: "text", text, text_elements: [] }];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
