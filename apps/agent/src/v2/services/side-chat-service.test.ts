import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scope } from "@codex-everywhere/kernel";
import { GatewayV2Error, type JsonValue } from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexNotification } from "../../runtime/codex-app-server-client.js";
import type { CodexClient } from "../codex/client.js";
import { UserStateDatabase } from "../repositories/user-state-database.js";
import { SideChatService, questionConfig } from "./side-chat-service.js";
import { ThreadLeaseManager } from "./thread-lease-manager.js";
import { WorkspaceService } from "./workspace-service.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("durable question side chats", () => {
  it("forks once under concurrent requests, excludes inherited turns and recovers after reopening state", async () => {
    const { service, state, leases, native, path } = await setup();
    const [a, b] = await Promise.all([
      service.start("parent"),
      service.start("parent"),
    ]);
    expect(a).toEqual(b);
    expect(
      native.calls.filter((call) => call.method === "thread/fork"),
    ).toHaveLength(1);
    expect(
      native.calls.find((call) => call.method === "thread/fork")?.params,
    ).toMatchObject({
      lastTurnId: "boundary",
      excludeTurns: true,
      ephemeral: false,
    });
    const child = await leases.acquire("child", { kind: "queue", id: "test" });
    cleanup.push(() => child.release());
    native.staleResume = true;
    const empty = await service.open(child);
    expect(empty.items).toEqual([]);
    expect(empty.state).toBe("idle");
    native.staleResume = false;
    native.turns = [
      turn("side-4"),
      turn("side-3"),
      turn("side-2"),
      turn("side-1"),
      turn("boundary"),
      turn("inherited-old"),
    ];
    const first = await service.open(child);
    expect(first.items.map((item) => item.turnId)).toEqual([
      "side-2",
      "side-3",
      "side-4",
    ]);
    const earlier = await service.history(child, first.historyCursor);
    expect(earlier.items.map((item) => item.turnId)).toEqual(["side-1"]);
    expect(earlier.hasMore).toBe(false);
    const reopened = await UserStateDatabase.open(path);
    cleanup.push(() => reopened.close());
    await reopened.sideChats.recover();
    expect(await reopened.sideChats.read("parent")).toEqual(
      await state.sideChats.read("parent"),
    );
    await expect(service.start("child")).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
    await expect(
      service.withoutSide("parent", async () => true),
    ).rejects.toMatchObject({ code: "SIDE_UNAVAILABLE" });
    await expect(service.assertOrdinary("child")).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
  });

  it("reapplies read-only permissions on every send and rejects writes when Codex does not confirm them", async () => {
    const { service, native, leases } = await setup();
    await service.start("parent");
    const child = await leases.acquire("child", { kind: "queue", id: "test" });
    cleanup.push(() => child.release());
    native.sandbox = "workspaceWrite";
    await expect(
      service.send(child, "Explain the result"),
    ).rejects.toMatchObject({ code: "SIDE_UNAVAILABLE" });
    expect(native.calls.some((call) => call.method === "turn/start")).toBe(
      false,
    );
    native.sandbox = "readOnly";
    await service.send(child, "Explain the result");
    expect(native.calls.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        approvalPolicy: "never",
      },
    });
  });

  it("does not duplicate a fork after transport loss and retains an accepted child for cleanup", async () => {
    const { service, native } = await setup();
    native.failFork = new Error("connection lost");
    await expect(service.start("parent")).rejects.toThrow("connection lost");
    expect((await service.read("parent")).side?.status).toBe("indeterminate");
    await expect(service.start("parent")).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
    await expect(service.delete("parent")).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
    expect(
      native.calls.filter((call) => call.method === "thread/fork"),
    ).toHaveLength(1);
    const creationKey = (await service.read("parent")).side!.creationKey!;
    await expect(service.abandon("parent", "stale-key")).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
    await service.abandon("parent", creationKey);
    expect((await service.read("parent")).side).toBeNull();
    expect(await service.withoutSide("parent", async () => "unblocked")).toBe(
      "unblocked",
    );
    native.failFork = undefined;
    native.sandbox = "workspaceWrite";
    await expect(service.start("parent")).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
    expect((await service.read("parent")).side).toMatchObject({
      threadId: "child",
      status: "indeterminate",
    });
    await expect(service.abandon("parent", creationKey)).rejects.toMatchObject({
      code: "SIDE_UNAVAILABLE",
    });
    expect(native.calls.some((call) => call.method === "thread/delete")).toBe(
      false,
    );
    await service.delete("parent");
    expect((await service.read("parent")).side).toBeNull();
  });

  it("allows retry after a definitive rejection and waits for interruption before deleting", async () => {
    const { service, native, state } = await setup();
    native.failFork = new GatewayV2Error(
      "CODEX_REQUEST_REJECTED",
      "unsupported",
    );
    await expect(service.start("parent")).rejects.toThrow("unsupported");
    expect(await state.sideChats.read("parent")).toBeUndefined();
    native.failFork = undefined;
    await service.start("parent");
    native.running = true;
    native.turns = [turn("active", "inProgress"), turn("boundary")];
    await service.delete("parent");
    const mutations = native.calls.filter((call) =>
      ["turn/interrupt", "thread/delete"].includes(call.method),
    );
    expect(mutations.map((call) => call.method)).toEqual([
      "turn/interrupt",
      "thread/delete",
    ]);
    expect((await service.read("parent")).side).toBeNull();
  });

  it("lets the user detach a known child after a successful delete loses its response", async () => {
    const { service, native, state } = await setup();
    await service.start("parent");
    const row = (await state.sideChats.read("parent"))!;
    await expect(
      service.abandon("parent", row.operationKey),
    ).rejects.toMatchObject({ code: "SIDE_UNAVAILABLE" });
    native.loseDeleteResponse = true;
    await expect(service.delete("parent")).rejects.toThrow(
      "delete response lost",
    );
    await expect(service.delete("parent")).rejects.toThrow(
      "child no longer exists",
    );
    const side = (await service.read("parent")).side!;
    expect(side).toMatchObject({
      status: "indeterminate",
      threadId: "child",
      creationKey: row.operationKey,
    });
    await service.abandon("parent", side.creationKey!);
    expect((await service.read("parent")).side).toBeNull();
    expect(await service.withoutSide("parent", async () => true)).toBe(true);
  });

  it("atomically retains workspace authorization while a side exists", async () => {
    const { service, state, workspaces } = await setup();
    const workspace = (await workspaces.list())[0]!;
    await service.start("parent");
    const row = (await state.sideChats.read("parent"))!;
    await expect(
      workspaces.remove(workspace.id, workspace.revision),
    ).rejects.toMatchObject({ code: "WORKSPACE_IN_USE" });
    await service.delete("parent");
    await expect(
      workspaces.remove(workspace.id, workspace.revision),
    ).resolves.toBe(true);
    expect(await state.sideChats.claim(row)).toBe(false);
    expect(await state.sideChats.read("parent")).toBeUndefined();
  });

  it("disables explicitly configured MCP servers and apps as well as defaults", async () => {
    const config = await questionConfig(
      {
        request: async <T>() =>
          ({
            config: {
              mcp_servers: { remote: { url: "https://example.invalid/mcp" } },
              apps: { custom: { enabled: true } },
            },
          }) as T,
      },
      "/workspace",
    );
    expect(config).toMatchObject({
      mcp_servers: { remote: { enabled: false } },
      apps: { _default: { enabled: false }, custom: { enabled: false } },
      "features.shell_tool": false,
      "features.hooks": false,
      "features.multi_agent": false,
      web_search: "disabled",
    });
  });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "ce-side-service-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const path = join(directory, "state.sqlite");
  const state = await UserStateDatabase.open(path, { create: true });
  cleanup.push(() => state.close());
  const scope = new Scope("side-service-test");
  cleanup.push(() => scope.close("test-complete"));
  const workspaces = new WorkspaceService(state.workspaces, {
    home: directory,
  });
  await workspaces.add(workspacePath, "Workspace");
  const native = new NativeSide(await realpath(workspacePath));
  const leases = new ThreadLeaseManager({
    scope,
    clientFactory: {
      create: async (owner) => {
        const client = native.client();
        owner.defer(() => client.close());
        return client;
      },
    },
  });
  const service = new SideChatService({
    scope,
    repository: state.sideChats,
    leases,
    workspaces,
    runtimeGate: {
      acquire: async () => ({ release: async () => undefined }),
      run: (operation) => operation(),
    },
  });
  return { service, state, leases, native, path, workspaces };
}
function turn(id: string, status = "completed") {
  return {
    id,
    status,
    items: [
      {
        id: `item-${id}`,
        type: "agentMessage",
        text: id,
        phase: "final_answer",
      },
    ],
  };
}
class NativeSide {
  calls: Array<{ method: string; params: Record<string, JsonValue> }> = [];
  turns = [turn("boundary"), turn("inherited-old")];
  sandbox = "readOnly";
  failFork: Error | undefined;
  running = false;
  staleResume = false;
  loseDeleteResponse = false;
  deleted = false;
  readonly listeners = new Set<(notification: CodexNotification) => void>();
  constructor(private readonly cwd: string) {}
  client(): CodexClient {
    return {
      request: async <T>(method: string, params?: unknown): Promise<T> =>
        this.request(
          method,
          (params ?? {}) as Record<string, JsonValue>,
        ) as Promise<T>,
      onNotification: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      onServerRequest: () => () => undefined,
      onClose: () => () => undefined,
      close: async () => undefined,
    };
  }
  async request(
    method: string,
    params: Record<string, JsonValue>,
  ): Promise<unknown> {
    this.calls.push({ method, params });
    const id = method === "thread/fork" ? "child" : String(params.threadId);
    if (method === "thread/fork" && this.failFork) throw this.failFork;
    if (
      id === "child" &&
      this.deleted &&
      ["thread/read", "thread/resume"].includes(method)
    )
      throw new Error("child no longer exists");
    if (["thread/read", "thread/resume", "thread/fork"].includes(method))
      return {
        thread: {
          id,
          cwd: this.cwd,
          name: "test",
          createdAt: 1,
          updatedAt: 1,
          status: {
            type:
              id === "child" &&
              (this.running || (method === "thread/resume" && this.staleResume))
                ? "active"
                : "idle",
          },
          turns: [],
        },
        sandbox: { type: this.sandbox },
        approvalPolicy: "never",
      };
    if (method === "config/read") return { config: {} };
    if (method === "thread/turns/list") {
      const turns =
        id === "parent"
          ? [turn("parent-active", "inProgress"), turn("boundary")]
          : this.turns;
      const offset = Number(params.cursor ?? 0),
        limit = Number(params.limit);
      return {
        data: turns.slice(offset, offset + limit),
        nextCursor:
          offset + limit < turns.length ? String(offset + limit) : null,
      };
    }
    if (method === "turn/start") return { turn: { id: "question" } };
    if (method === "turn/interrupt") {
      this.running = false;
      for (const listener of this.listeners)
        listener({
          method: "thread/status/changed",
          params: { threadId: "child", status: { type: "idle" } },
        });
      return {};
    }
    if (method === "thread/delete") {
      expect(this.running).toBe(false);
      if (this.loseDeleteResponse) {
        this.deleted = true;
        throw new Error("delete response lost");
      }
      return {};
    }
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    throw new Error(`Unexpected method: ${method}`);
  }
}
