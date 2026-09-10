import { randomUUID } from "node:crypto";
import { Scope, TypedEventBus } from "@codex-everywhere/kernel";
import { GatewayV2Error, type OutputOf } from "@codex-everywhere/protocol/v2";
import {
  isCodexObject,
  parseCodexObject,
  requireCodexObject,
  requireCodexString,
  type CodexObject,
} from "../codex/codex-json.js";
import type { SideChatRepository } from "../repositories/side-chat-repository.js";
import type { SideChatStateRecord } from "../repositories/state-snapshot.js";
import type { CodexRuntimeGatePort } from "./codex-runtime-gate.js";
import type {
  ThreadLease,
  ThreadLeaseHandle,
  ThreadLeaseManager,
} from "./thread-lease-manager.js";
import type { WorkspaceService } from "./workspace-service.js";
import {
  projectThreadSummary,
  projectThreadTimeline,
} from "./thread-projection.js";

/** Native durable forks; CE stores ownership, never a shadow transcript. */
export class SideChatService {
  readonly #scope: Scope;
  readonly events = new TypedEventBus<{
    changed: { parentThreadId: string };
  }>();
  constructor(
    private readonly options: {
      scope: Scope;
      repository: SideChatRepository;
      leases: ThreadLeaseManager;
      workspaces: WorkspaceService;
      runtimeGate: CodexRuntimeGatePort;
    },
  ) {
    this.#scope = options.scope.fork("side-chats");
    this.#scope.defer(() => this.events.clear());
  }

  async read(parentThreadId: string): Promise<OutputOf<"side/read">> {
    const row = await this.options.repository.read(parentThreadId);
    if (row) await this.options.workspaces.get(row.workspaceId);
    else await this.#authorize(parentThreadId);
    return { version: 1, side: row === undefined ? null : sideView(row) };
  }

  forThread(threadId: string) {
    return this.options.repository.forThread(threadId);
  }
  async hiddenThreadIds() {
    return new Set(
      (await this.options.repository.list()).flatMap((row) =>
        row.threadId === undefined ? [] : [row.threadId],
      ),
    );
  }

  async start(parentThreadId: string): Promise<OutputOf<"side/start">> {
    return this.options.runtimeGate.run(async () => {
      const lock = await this.options.repository.lock(
        parentThreadId,
        this.#scope.signal,
      );
      try {
        await this.#authorize(parentThreadId);
        if (await this.forThread(parentThreadId))
          throw unavailable("旁支中不能再创建旁支。");
        const existing = await this.options.repository.read(parentThreadId);
        if (existing !== undefined) {
          if (existing.status !== "ready")
            throw unavailable("上次旁支操作结果需要核对，请勿重复创建。");
          return { version: 1, side: sideView(existing) };
        }
        const parent = await this.options.leases.acquire(parentThreadId, {
          kind: "queue",
          id: `side-source:${randomUUID()}`,
        });
        try {
          const state = await parent.lease.synchronize(false);
          const cwd = await this.options.workspaces.resolve(
            state.workspacePath,
          );
          const latest = await turnPage(parent.lease, undefined, 2);
          const completed = latest.turns.find(
            (turn) =>
              turn.status === "completed" ||
              turn.status === "interrupted" ||
              turn.status === "failed",
          );
          if (completed === undefined)
            throw unavailable("主任务完成第一轮对话后，即可打开旁支问答。");
          const lastTurnId = requireCodexString(
            completed.id,
            "side context boundary",
          );
          const workspace = await this.options.workspaces.workspaceForPath(cwd);
          const config = await questionConfig(parent.lease, cwd);
          let row: SideChatStateRecord = {
            parentThreadId,
            workspaceId: workspace.id,
            status: "creating",
            operationKey: randomUUID(),
            createdAt: new Date().toISOString(),
          };
          if (!(await this.options.repository.claim(row)))
            throw unavailable("工作区已移除，请重新选择工作区后创建旁支。");
          let forkAccepted = false;
          try {
            const created = await this.options.leases.start(
              async (client) => {
                const result = parseCodexObject(
                  await client.request("thread/fork", {
                    threadId: parentThreadId,
                    lastTurnId,
                    ephemeral: false,
                    excludeTurns: true,
                    cwd,
                    sandbox: "read-only",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    config,
                    developerInstructions: SIDE_INSTRUCTIONS,
                  }),
                  "side fork response",
                );
                const thread = requireCodexObject(result.thread, "side thread");
                const threadId = requireCodexString(
                  thread.id,
                  "side thread id",
                );
                forkAccepted = true;
                row = { ...row, threadId };
                await this.options.repository.save(row);
                return { threadId, result };
              },
              { kind: "queue", id: `side-create:${row.operationKey}` },
            );
            try {
              assertReadOnly(created.result);
              const inherited = await turnPage(
                created.handle.lease,
                undefined,
                1,
              );
              const boundary = inherited.turns[0];
              if (boundary === undefined)
                throw unavailable("Codex 未返回旁支的继承边界，已停止提问。");
              row = {
                ...row,
                status: "ready",
                boundaryTurnId: requireCodexString(
                  boundary.id,
                  "fork boundary",
                ),
              };
              await this.options.repository.save(row);
              this.#changed(parentThreadId);
              return { version: 1, side: sideView(row) };
            } finally {
              await created.handle.release();
            }
          } catch (error) {
            if (
              !forkAccepted &&
              error instanceof GatewayV2Error &&
              error.code === "CODEX_REQUEST_REJECTED"
            ) {
              await this.options.repository.remove(parentThreadId);
            } else {
              await this.options.repository.save({
                ...row,
                status: "indeterminate",
              });
            }
            throw error;
          }
        } finally {
          await parent.release();
        }
      } finally {
        await lock.release();
      }
    });
  }

  async open(handle: ThreadLeaseHandle): Promise<OutputOf<"thread/open">> {
    const row = await this.#required(handle.threadId);
    const lock = await this.options.repository.lock(
      row.parentThreadId,
      this.#scope.signal,
    );
    try {
      await this.#required(handle.threadId);
      const state = await handle.lease.synchronize(false);
      const cwd = await this.options.workspaces.resolve(state.workspacePath);
      const resumed = parseCodexObject(
        await handle.lease.request("thread/resume", {
          threadId: handle.threadId,
          excludeTurns: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          config: await questionConfig(handle.lease, cwd),
          developerInstructions: SIDE_INSTRUCTIONS,
        }),
        "side resume",
      );
      assertReadOnly(resumed);
      const page = await this.#history(handle.lease, row);
      const thread = page.thread;
      const current = handle.lease.adoptAuthoritativeThread({
        ...thread,
        turns: page.turns,
      });
      const workspace = await this.options.workspaces.workspaceForPath(cwd);
      return {
        version: 1,
        thread: {
          ...projectThreadSummary(thread, workspace, false),
          title: "旁支问答",
        },
        state: current.state,
        items: page.items,
        interactions: handle.lease.listInteractions(),
        hasEarlierHistory: page.hasMore,
        ...(page.nextCursor === undefined
          ? {}
          : { historyCursor: page.nextCursor }),
        settings: {
          version: 1,
          revision: 0,
          sandbox: "read-only",
          approvalPolicy: "never",
          ...(typeof resumed.model === "string"
            ? { model: resumed.model }
            : {}),
        },
      };
    } finally {
      await lock.release();
    }
  }

  async history(
    handle: ThreadLeaseHandle,
    cursor?: string,
  ): Promise<OutputOf<"thread/history">> {
    const row = await this.#required(handle.threadId);
    const page = await this.#history(handle.lease, row, cursor);
    return {
      version: 1,
      items: page.items,
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async send(
    handle: ThreadLeaseHandle,
    prompt: string,
  ): Promise<OutputOf<"turn/start">> {
    return this.options.runtimeGate.run(async () => {
      const row = await this.#required(handle.threadId);
      const lock = await this.options.repository.lock(
        row.parentThreadId,
        this.#scope.signal,
      );
      try {
        await this.#required(handle.threadId);
        const state = await handle.lease.synchronize(false);
        const cwd = await this.options.workspaces.resolve(state.workspacePath);
        if (state.state === "running" || state.state === "waiting-input")
          throw unavailable("旁支仍在回答，请稍后再提问。");
        const resumed = parseCodexObject(
          await handle.lease.request("thread/resume", {
            threadId: handle.threadId,
            excludeTurns: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            config: await questionConfig(handle.lease, cwd),
            developerInstructions: SIDE_INSTRUCTIONS,
          }),
          "side resume",
        );
        assertReadOnly(resumed);
        const stop = handle.lease.observeTurnStartResponse();
        try {
          const response = parseCodexObject(
            await handle.lease.request("turn/start", {
              threadId: handle.threadId,
              clientUserMessageId: randomUUID(),
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
              input: [{ type: "text", text: prompt, text_elements: [] }],
            }),
            "side turn",
          );
          const turnId = requireCodexString(
            requireCodexObject(response.turn, "side turn").id,
            "turn id",
          );
          handle.lease.noteTurnStarted(turnId);
          return { version: 1, threadId: handle.threadId, turnId };
        } finally {
          stop();
        }
      } finally {
        await lock.release();
      }
    });
  }

  async abandon(
    parentThreadId: string,
    creationKey: string,
  ): Promise<OutputOf<"side/abandon">> {
    const lock = await this.options.repository.lock(
      parentThreadId,
      this.#scope.signal,
    );
    try {
      const row = await this.options.repository.read(parentThreadId);
      if (row !== undefined) {
        await this.options.workspaces.get(row.workspaceId);
        if (row.status !== "indeterminate" || row.operationKey !== creationKey)
          throw unavailable(
            "旁支状态已变化，请刷新后核对；正常旁支须通过结束并删除处理。",
          );
        await this.options.repository.remove(parentThreadId);
        this.#changed(parentThreadId);
      }
      return { version: 1, abandoned: true };
    } finally {
      await lock.release();
    }
  }

  async delete(parentThreadId: string): Promise<OutputOf<"side/delete">> {
    return this.options.runtimeGate.run(() => this.#delete(parentThreadId));
  }

  async #delete(parentThreadId: string): Promise<OutputOf<"side/delete">> {
    const lock = await this.options.repository.lock(
      parentThreadId,
      this.#scope.signal,
    );
    try {
      const row = await this.options.repository.read(parentThreadId);
      if (row === undefined) return { version: 1, deleted: true };
      await this.options.workspaces.get(row.workspaceId);
      if (row.threadId === undefined)
        throw unavailable(
          "旁支创建结果未知，需要先在宿主机核对，不能假定已删除。",
        );
      const handle = await this.options.leases.acquire(row.threadId, {
        kind: "queue",
        id: `side-delete:${randomUUID()}`,
      });
      let removed = false;
      try {
        await this.options.repository.save({ ...row, status: "deleting" });
        const state = await handle.lease.synchronize(false);
        await this.options.workspaces.resolve(state.workspacePath);
        if (state.state === "running" || state.state === "waiting-input") {
          const latest = await turnPage(handle.lease, undefined, 1);
          const active = latest.turns.find(
            (turn) => turn.status === "inProgress",
          );
          if (active === undefined)
            throw unavailable("无法确认正在运行的旁支，请刷新后重试。");
          const activeTurnId = requireCodexString(
            active.id,
            "active side turn",
          );
          const stopped = waitUntilStopped(
            handle.lease,
            activeTurnId,
            this.#scope,
          );
          try {
            await handle.lease.request("turn/interrupt", {
              threadId: row.threadId,
              turnId: activeTurnId,
            });
            await stopped.done;
          } finally {
            await stopped.close();
          }
        }
        await handle.lease.request("thread/delete", { threadId: row.threadId });
        await this.options.repository.remove(parentThreadId);
        removed = true;
        this.#changed(parentThreadId);
        await this.options.leases.closeThread(row.threadId, "side-deleted");
        return { version: 1, deleted: true };
      } catch (error) {
        if (!removed) {
          await this.options.repository.save({
            ...row,
            status: "indeterminate",
          });
          this.#changed(parentThreadId);
        }
        throw error;
      } finally {
        await handle.release();
      }
    } finally {
      await lock.release();
    }
  }

  async withoutSide<T>(
    parentThreadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = await this.options.repository.lock(
      parentThreadId,
      this.#scope.signal,
    );
    try {
      if (await this.options.repository.read(parentThreadId))
        throw unavailable("请先结束并删除该任务的旁支问答。");
      return await operation();
    } finally {
      await lock.release();
    }
  }

  #changed(parentThreadId: string): void {
    try {
      this.events.emit("changed", { parentThreadId });
    } catch {
      /* Notification listeners do not change mutation outcomes. */
    }
  }

  async assertOrdinary(threadId: string): Promise<void> {
    if (await this.forThread(threadId))
      throw unavailable("旁支仅用于问答，不支持此操作。");
  }

  async #required(threadId: string): Promise<SideChatStateRecord> {
    const row = await this.forThread(threadId);
    if (row === undefined || row.status !== "ready")
      throw unavailable("旁支不可用或操作结果待核对。");
    await this.options.workspaces.get(row.workspaceId);
    return row;
  }

  async #authorize(threadId: string): Promise<void> {
    const handle = await this.options.leases.acquire(threadId, {
      kind: "queue",
      id: `side-authorize:${randomUUID()}`,
    });
    try {
      const state = await handle.lease.synchronize(false);
      await this.options.workspaces.resolve(state.workspacePath);
    } finally {
      await handle.release();
    }
  }

  async #history(
    lease: ThreadLease,
    row: SideChatStateRecord,
    cursor?: string,
  ) {
    const state = await lease.synchronize(false);
    await this.options.workspaces.resolve(state.workspacePath);
    const page = await turnPage(lease, cursor, 3);
    const boundary = page.turns.findIndex(
      (turn) => turn.id === row.boundaryTurnId,
    );
    const turns = (
      boundary < 0 ? page.turns : page.turns.slice(0, boundary)
    ).reverse();
    const nextCursor = boundary < 0 ? page.nextCursor : undefined;
    return {
      thread: requireCodexObject(state.thread, "side history thread"),
      turns,
      items: projectThreadTimeline({ turns }),
      hasMore: nextCursor !== undefined,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
}

export function sideView(
  row: SideChatStateRecord,
): NonNullable<OutputOf<"side/read">["side"]> {
  return {
    version: 1,
    parentThreadId: row.parentThreadId,
    status: row.status,
    ...(row.status === "indeterminate"
      ? { creationKey: row.operationKey }
      : {}),
    ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
    ...(row.boundaryTurnId === undefined
      ? {}
      : { boundaryTurnId: row.boundaryTurnId }),
  };
}

async function turnPage(
  lease: ThreadLease,
  cursor: string | undefined,
  limit: number,
) {
  const response = parseCodexObject(
    await lease.request("thread/turns/list", {
      threadId: lease.threadId,
      limit,
      sortDirection: "desc",
      itemsView: "full",
      ...(cursor === undefined ? {} : { cursor }),
    }),
    "side history",
  );
  if (!Array.isArray(response.data))
    throw unavailable("当前 Codex 不支持可恢复的旁支历史。");
  const turns = response.data.map((turn) => requireCodexObject(turn, "turn"));
  const nextCursor =
    typeof response.nextCursor === "string" ? response.nextCursor : undefined;
  return { turns, nextCursor };
}

export async function questionConfig(
  lease: Pick<ThreadLease, "request">,
  cwd: string,
): Promise<CodexObject> {
  const read = parseCodexObject(
    await lease.request("config/read", { cwd, includeLayers: false }),
    "side config",
  );
  const effective = requireCodexObject(read.config, "side config");
  const config: Record<
    string,
    import("@codex-everywhere/protocol/v2").JsonValue
  > = {
    "features.shell_tool": false,
    "features.unified_exec": false,
    "features.apply_patch_freeform": false,
    "features.multi_agent": false,
    "features.hooks": false,
    "features.codex_hooks": false,
    "features.apps": false,
    "features.plugins": false,
    "features.remote_plugin": false,
    "features.js_repl": false,
    "features.browser_use": false,
    "features.computer_use": false,
    "features.goals": false,
    web_search: "disabled",
    mcp_servers: {},
    apps: { _default: { enabled: false } },
  };
  // Override each named server/app too: project config may merge tables.
  for (const group of ["mcp_servers", "apps"] as const) {
    if (!isCodexObject(effective[group])) continue;
    const disabled: Record<
      string,
      import("@codex-everywhere/protocol/v2").JsonValue
    > = Object.fromEntries(
      Object.keys(effective[group]).map((name) => [name, { enabled: false }]),
    );
    if (group === "apps") disabled._default = { enabled: false };
    config[group] = disabled;
  }
  return config;
}

function assertReadOnly(response: CodexObject): void {
  if (
    !isCodexObject(response.sandbox) ||
    response.sandbox.type !== "readOnly" ||
    response.approvalPolicy !== "never"
  )
    throw unavailable("Codex 未确认旁支的只读权限，已停止提问。");
}
function unavailable(message: string) {
  return new GatewayV2Error("SIDE_UNAVAILABLE", message);
}
const SIDE_INSTRUCTIONS =
  "This is a side conversation for questions and explanations only. Answer using inherited context. Do not modify files, invoke external actions, spawn agents, or continue the parent task. If context is insufficient, ask the user. Do not send anything to the parent conversation.";

function waitUntilStopped(lease: ThreadLease, turnId: string, parent: Scope) {
  const scope = parent.fork("side-interrupt");
  scope.defer(lease.observeTerminalTurn(turnId));
  const done = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (
        ["completed", "interrupted", "failed"].includes(
          lease.terminalTurnStatus(turnId) ?? "",
        )
      )
        resolve();
    };
    scope.defer(
      lease.onEvent((event) => {
        if (event.type === "lease/failed")
          reject(unavailable("Codex 连接中断，无法确认旁支已停止。"));
        else check();
      }),
    );
    check();
    scope.defer(() =>
      reject(unavailable("旁支停止等待已结束，请核对会话状态。")),
    );
    scope.setTimeout(
      () => reject(unavailable("旁支尚未停止，未删除会话。")),
      15_000,
    );
  });
  // The interrupt request itself can fail before the waiter is awaited.
  void done.catch(() => undefined);
  return { done, close: () => scope.close("side-interrupt-finished") };
}
