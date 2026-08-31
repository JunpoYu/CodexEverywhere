import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadLeaseEvent } from "./thread-lease-manager.js";
import { deriveAutomaticTitle } from "./auto-title.js";
import {
  AutoTitleService,
  type AutoTitleLeasePort,
} from "./auto-title-service.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
});

describe("deriveAutomaticTitle", () => {
  it("extracts a concise first request without courtesy or Markdown", () => {
    expect(
      deriveAutomaticTitle(
        "# 请求\n请帮我修复登录握手期间连接关闭，并补充对应测试。",
      ),
    ).toBe("修复登录握手期间连接关闭");
    expect(
      deriveAutomaticTitle(
        "Could you improve the task settings interaction, then verify it?",
      ),
    ).toBe("improve the task settings interaction");
    expect(deriveAutomaticTitle("# Fix login handshake failures")).toBe(
      "Fix login handshake failures",
    );
  });

  it("defers generic follow-up prompts until the goal is meaningful", () => {
    expect(deriveAutomaticTitle("继续处理")).toBeUndefined();
    expect(deriveAutomaticTitle("实现一下")).toBeUndefined();
    expect(deriveAutomaticTitle("请修复登录失败")).toBe("修复登录失败");
  });

  it("bounds display width without splitting Unicode characters", () => {
    const title = deriveAutomaticTitle(
      "请分析这个非常复杂而且包含许多不同模块的工程架构以及其中所有可能存在的并发恢复问题",
    );
    expect(title).toBeDefined();
    expect(title?.endsWith("…")).toBe(true);
    expect(Array.from(title ?? "")).not.toContain("\ud83d");
  });
});

describe("AutoTitleService", () => {
  it("names an unnamed thread only after its successful turn completes", async () => {
    const scope = new Scope("auto-title-test");
    scopes.push(scope);
    const service = new AutoTitleService({ scope });
    const lease = new FakeTitleLease();

    service.schedule(lease, "turn-1", "请修复登录握手失败，并补充测试");

    expect(lease.name).toBeUndefined();
    expect(lease.references.size).toBe(1);
    lease.complete("turn-1", "completed");

    await vi.waitFor(() => expect(lease.name).toBe("修复登录握手失败"));
    await vi.waitFor(() => expect(lease.references.size).toBe(0));
    expect(lease.methods).toEqual(["thread/read", "thread/name/set"]);
  });

  it("closes the response/subscription gap for an already completed turn", async () => {
    const scope = new Scope("early-completion-title-test");
    scopes.push(scope);
    const service = new AutoTitleService({ scope });
    const lease = new FakeTitleLease();

    lease.complete("turn-1", "completed");
    service.schedule(lease, "turn-1", "修复极短任务的自动命名竞态");

    await vi.waitFor(() =>
      expect(lease.name).toBe("修复极短任务的自动命名竞态"),
    );
    await vi.waitFor(() => expect(lease.references.size).toBe(0));
  });

  it("preserves an existing app-server name", async () => {
    const scope = new Scope("existing-title-test");
    scopes.push(scope);
    const service = new AutoTitleService({ scope });
    const lease = new FakeTitleLease("TUI 手动名称");

    service.schedule(lease, "turn-1", "分析项目架构并修复问题");
    lease.complete("turn-1", "completed");

    await vi.waitFor(() => expect(lease.references.size).toBe(0));
    expect(lease.name).toBe("TUI 手动名称");
    expect(lease.methods).toEqual(["thread/read"]);
  });

  it("does not name failed turns or generic prompts", async () => {
    const scope = new Scope("failed-title-test");
    scopes.push(scope);
    const service = new AutoTitleService({ scope });
    const failed = new FakeTitleLease();
    const generic = new FakeTitleLease();

    service.schedule(failed, "turn-1", "分析并修复网关恢复问题");
    service.schedule(generic, "turn-2", "继续处理");
    failed.complete("turn-1", "failed");

    await vi.waitFor(() => expect(failed.references.size).toBe(0));
    expect(failed.methods).toEqual([]);
    expect(generic.references.size).toBe(0);
  });

  it("lets a manual or external rename win over a pending automatic title", async () => {
    const scope = new Scope("manual-title-test");
    scopes.push(scope);
    const service = new AutoTitleService({ scope });
    const manual = new FakeTitleLease();
    const external = new FakeTitleLease();

    service.schedule(manual, "turn-1", "修复任务自动命名");
    await service.renameManually(manual, "自定义任务名称");
    manual.complete("turn-1", "completed");

    service.schedule(external, "turn-2", "检查任务标题同步");
    external.externalRename("来自 TUI 的名称");
    external.complete("turn-2", "completed");

    await vi.waitFor(() => expect(external.references.size).toBe(0));
    expect(manual.name).toBe("自定义任务名称");
    expect(manual.methods).toEqual(["thread/name/set"]);
    expect(external.name).toBe("来自 TUI 的名称");
    expect(external.methods).toEqual([]);
  });

  it("contains app-server naming failures and releases its lease reference", async () => {
    const scope = new Scope("title-failure-test");
    scopes.push(scope);
    const service = new AutoTitleService({ scope });
    const lease = new FakeTitleLease();
    lease.failRead = true;

    expect(() =>
      service.schedule(lease, "turn-1", "诊断自动命名失败恢复"),
    ).not.toThrow();
    lease.complete("turn-1", "completed");

    await vi.waitFor(() => expect(lease.references.size).toBe(0));
    expect(lease.name).toBeUndefined();
  });
});

class FakeTitleLease implements AutoTitleLeasePort {
  readonly threadId = "thread-1";
  readonly references = new Set<string>();
  readonly methods: string[] = [];
  readonly #listeners = new Set<(event: ThreadLeaseEvent) => void>();
  #lastTerminalTurn:
    { readonly id: string; readonly status: string } | undefined;
  name: string | undefined;
  failRead = false;

  constructor(name?: string) {
    this.name = name;
  }

  addReference(kind: "viewer" | "queue" | "effect", id: string): void {
    this.references.add(`${kind}:${id}`);
  }

  releaseReference(
    kind: "viewer" | "queue" | "effect",
    id: string,
  ): Promise<void> {
    this.references.delete(`${kind}:${id}`);
    return Promise.resolve();
  }

  terminalTurnStatus(turnId: string): string | undefined {
    return this.#lastTerminalTurn?.id === turnId
      ? this.#lastTerminalTurn.status
      : undefined;
  }

  request<Result = unknown>(method: string, params?: unknown): Promise<Result> {
    this.methods.push(method);
    if (method === "thread/read") {
      if (this.failRead) return Promise.reject(new Error("read failed"));
      return Promise.resolve({
        thread: { id: this.threadId, name: this.name ?? null },
      } as Result);
    }
    if (method === "thread/name/set") {
      this.name = (params as { name: string }).name;
      return Promise.resolve({} as Result);
    }
    return Promise.reject(new Error(`Unexpected request: ${method}`));
  }

  onEvent(listener: (event: ThreadLeaseEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  complete(turnId: string, status: string): void {
    this.#lastTerminalTurn = { id: turnId, status };
    this.emit({
      type: "codex/notification",
      method: "turn/completed",
      params: {
        threadId: this.threadId,
        turn: { id: turnId, status },
      },
    });
  }

  externalRename(name: string): void {
    this.name = name;
    this.emit({
      type: "codex/notification",
      method: "thread/name/updated",
      params: { threadId: this.threadId, threadName: name },
    });
  }

  private emit(event: ThreadLeaseEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}
