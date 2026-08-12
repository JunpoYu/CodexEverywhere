import type {
  ThreadItem,
  ThreadReadResponse,
  Turn,
} from "@codex-everywhere/codex-app-server-schema/v2";
import { describe, expect, it } from "vitest";

import {
  completedStreamingCandidateId,
  boundedThreadSnapshot,
  describeThreadItem,
  FileChangeDisclosureState,
  fileChangeItemFromPatchUpdate,
  fileChangeKindLabel,
  isInternalTimelineEventType,
  isReasoningEventType,
  isVisibleThreadItem,
  localUserReconciledByTurns,
  looseItemReconciledByTurn,
  mcpServerStartupNotice,
  preferredMessageTimestamp,
  queuedMessageText,
  relativeMessageTime,
  shouldFollowTimeline,
  StreamingDeltaBuffer,
  streamingItemCandidateId,
  TRANSIENT_TIMELINE_SELECTOR,
  threadSnapshotRevision,
  threadSendMode,
} from "./thread-view.js";

describe("boundedThreadSnapshot", () => {
  it("prevents a repair snapshot from expanding beyond its turn window", () => {
    const turns = Array.from({ length: 25 }, (_, index) =>
      testTurn(`turn-${index + 1}`),
    );
    const response = {
      thread: { id: "thread-1", turns },
    } as ThreadReadResponse;

    const bounded = boundedThreadSnapshot(response, 20);

    expect(bounded.thread.turns).toHaveLength(20);
    expect(bounded.thread.turns.at(0)?.id).toBe("turn-6");
    expect(response.thread.turns).toHaveLength(25);
  });
});

function testTurn(id: string): Turn {
  return {
    id,
    items: [],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

describe("relativeMessageTime", () => {
  const now = Date.UTC(2026, 7, 9, 10, 0, 0);

  it("uses compact Chinese labels for recent messages", () => {
    expect(relativeMessageTime(now - 30_000, now)).toBe("刚刚");
    expect(relativeMessageTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(relativeMessageTime(now - 2 * 60 * 60_000, now)).toBe("2 小时前");
  });

  it("keeps older messages readable without exact dates in every card", () => {
    expect(relativeMessageTime(now - 3 * 24 * 60 * 60_000, now)).toBe("3 天前");
    expect(relativeMessageTime(now - 65 * 24 * 60 * 60_000, now)).toBe(
      "2 个月前",
    );
    expect(relativeMessageTime(now - 360 * 24 * 60 * 60_000, now)).toBe(
      "12 个月前",
    );
  });
});

describe("preferredMessageTimestamp", () => {
  it("keeps an item lifecycle timestamp during turn reconciliation", () => {
    expect(preferredMessageTimestamp(20_000, 12_000, true, 30_000)).toBe(
      12_000,
    );
  });

  it("allows a lifecycle completion event to replace its started time", () => {
    expect(preferredMessageTimestamp(20_000, 12_000, false, 30_000)).toBe(
      20_000,
    );
  });

  it("uses the snapshot timestamp when no rendered item exists", () => {
    expect(preferredMessageTimestamp(20_000, undefined, true, 30_000)).toBe(
      20_000,
    );
  });
});

describe("mcpServerStartupNotice", () => {
  it("turns a codex_apps transport failure into a safe, readable warning", () => {
    const notice = mcpServerStartupNotice({
      threadId: "thread-1",
      name: "codex_apps",
      status: "failed",
      error:
        "MCP startup failed: HTTP request failed: https://chatgpt.com/backend-api/ps/mcp",
      failureReason: null,
    });

    expect(notice).toEqual({
      kind: "warning",
      title: "ChatGPT Apps 未连接",
      summary:
        "会话记录已恢复，但宿主机暂时无法连接 ChatGPT Apps。连接器工具当前不可用；如果发送普通消息也失败，请在“设置 → Codex 网络”检查代理，然后重新打开会话。",
    });
    expect(JSON.stringify(notice)).not.toContain("backend-api");
    expect(JSON.stringify(notice)).not.toContain("Transport");
  });

  it("explains when an MCP service needs authorization", () => {
    expect(
      mcpServerStartupNotice({
        name: "research",
        status: "failed",
        error: null,
        failureReason: "reauthenticationRequired",
      }),
    ).toMatchObject({
      title: "MCP 服务未连接：research",
      summary: expect.stringContaining("需要重新授权"),
    });
  });

  it("does not add routine startup state changes to the timeline", () => {
    for (const status of ["starting", "ready", "cancelled"])
      expect(
        mcpServerStartupNotice({ name: "codex_apps", status }),
      ).toBeUndefined();
  });
});

describe("timeline auto-follow", () => {
  it("continues following when the reader is already near the latest message", () => {
    expect(
      shouldFollowTimeline({
        scrollTop: 936,
        scrollHeight: 1_500,
        clientHeight: 500,
      }),
    ).toBe(true);
  });

  it("stops following once the reader scrolls into message history", () => {
    expect(
      shouldFollowTimeline({
        scrollTop: 800,
        scrollHeight: 1_500,
        clientHeight: 500,
      }),
    ).toBe(false);
  });

  it("follows content that does not fill the timeline viewport", () => {
    expect(
      shouldFollowTimeline({
        scrollTop: 0,
        scrollHeight: 420,
        clientHeight: 500,
      }),
    ).toBe(true);
  });
});

describe("streaming delta batching", () => {
  it("coalesces adjacent deltas for one item while preserving stream order", () => {
    const buffer = new StreamingDeltaBuffer();
    buffer.append({
      itemId: "agent-1",
      delta: "hel",
      kind: "agent",
      turnId: "turn-1",
    });
    buffer.append({
      itemId: "agent-1",
      delta: "lo",
      kind: "agent",
      turnId: "turn-1",
    });
    buffer.append({
      itemId: "tool-1",
      delta: "ok",
      kind: "tool",
      turnId: "turn-1",
    });

    expect(buffer.drain()).toEqual([
      {
        itemId: "agent-1",
        delta: "hello",
        kind: "agent",
        turnId: "turn-1",
      },
      {
        itemId: "tool-1",
        delta: "ok",
        kind: "tool",
        turnId: "turn-1",
      },
    ]);
    expect(buffer.drain()).toEqual([]);
  });
});

describe("describeThreadItem", () => {
  it("presents command execution without dumping the whole payload", () => {
    const item: ThreadItem = {
      type: "commandExecution",
      id: "item-1",
      command: "pnpm test",
      cwd: "/work",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 1200,
    };
    expect(describeThreadItem(item)).toMatchObject({
      kind: "tool",
      title: "命令",
      status: "completed",
      summary: "pnpm test",
    });
  });

  it("joins user text and skill mentions into one readable message", () => {
    const item: ThreadItem = {
      type: "userMessage",
      id: "item-2",
      clientId: null,
      content: [
        { type: "text", text: "检查项目", text_elements: [] },
        { type: "skill", name: "review", path: "/skills/review" },
      ],
    };
    expect(describeThreadItem(item).summary).toBe("检查项目\n$review");
  });

  it("excludes reasoning items from the visible timeline", () => {
    const item: Extract<ThreadItem, { type: "reasoning" }> = {
      type: "reasoning",
      id: "reasoning-1",
      summary: ["先检查事件流", "再核对快照"],
      content: ["补充推理内容"],
    };
    expect(isVisibleThreadItem(item)).toBe(false);
  });

  it("recognizes realtime reasoning events that the timeline ignores", () => {
    expect(isReasoningEventType("codex/item/reasoning/summaryTextDelta")).toBe(
      true,
    );
    expect(isReasoningEventType("codex/item/reasoning/textDelta")).toBe(true);
    expect(isReasoningEventType("codex/item/agentMessage/delta")).toBe(false);
  });

  it("keeps known lifecycle metadata out of the message timeline", () => {
    for (const type of [
      "codex/item/commandExecution/terminalInteraction",
      "codex/rawResponseItem/completed",
      "codex/item/autoApprovalReview/started",
      "codex/thread/closed",
      "codex/turn/moderationMetadata",
      "codex/thread/realtime/outputAudio/delta",
    ]) {
      expect(isInternalTimelineEventType(type)).toBe(true);
    }
    expect(
      isInternalTimelineEventType("codex/item/commandExecution/outputDelta"),
    ).toBe(false);
  });

  it("renders structured file change kinds instead of object coercion", () => {
    expect(
      fileChangeKindLabel({
        path: "src/new.ts",
        kind: { type: "add" },
        diff: "",
      }),
    ).toBe("新增");
    expect(
      fileChangeKindLabel({
        path: "src/old.ts",
        kind: { type: "update", move_path: "src/new.ts" },
        diff: "",
      }),
    ).toBe("移动并修改");
  });

  it("turns patchUpdated payloads into live file-change items", () => {
    expect(
      fileChangeItemFromPatchUpdate({
        itemId: "file-1",
        changes: [
          {
            path: "src/app.ts",
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
      }),
    ).toEqual({
      type: "fileChange",
      id: "file-1",
      changes: [
        {
          path: "src/app.ts",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
      status: "inProgress",
    });
    expect(
      fileChangeItemFromPatchUpdate({ itemId: "file-1", changes: [{}] }),
    ).toBeUndefined();
  });
});

describe("file-change disclosure state", () => {
  it("keeps file diffs collapsed until the user expands them", () => {
    const state = new FileChangeDisclosureState();

    expect(state.isOpen("file-1", "src/app.ts")).toBe(false);
    state.setOpen("file-1", "src/app.ts", true);
    expect(state.isOpen("file-1", "src/app.ts")).toBe(true);
    expect(state.isOpen("file-1", "src/other.ts")).toBe(false);

    state.setOpen("file-1", "src/app.ts", false);
    expect(state.isOpen("file-1", "src/app.ts")).toBe(false);
  });

  it("clears expanded files when leaving the conversation", () => {
    const state = new FileChangeDisclosureState();
    state.setOpen("file-1", "src/app.ts", true);

    state.clear();

    expect(state.isOpen("file-1", "src/app.ts")).toBe(false);
  });
});

describe("composer delivery", () => {
  it("starts idle threads and persists messages for active threads", () => {
    expect(threadSendMode({ type: "idle" })).toBe("start");
    expect(
      threadSendMode({ type: "active", activeFlags: ["waitingOnApproval"] }),
    ).toBe("queue");
  });

  it("restores queued text from the persisted turn payload", () => {
    expect(
      queuedMessageText({
        input: [
          { type: "text", text: "第一段" },
          { type: "localImage", path: "/tmp/image.png" },
          { type: "text", text: "第二段" },
        ],
      }),
    ).toBe("第一段\n📎 image.png\n第二段");
  });

  it("changes the snapshot revision when streamed content changes", () => {
    const response = {
      thread: { turns: [{ id: "turn-1", items: [{ text: "a" }] }] },
    };
    const before = threadSnapshotRevision(response as never);
    response.thread.turns[0]!.items[0]!.text = "ab";
    expect(threadSnapshotRevision(response as never)).not.toBe(before);
  });

  it("preserves optimistic cards during snapshot repair", () => {
    expect(TRANSIENT_TIMELINE_SELECTOR).not.toContain("[data-queue-id]");
    expect(TRANSIENT_TIMELINE_SELECTOR).not.toContain("[data-request-id]");
    expect(TRANSIENT_TIMELINE_SELECTOR).toContain(".timeline-entry.streaming");
    expect(TRANSIENT_TIMELINE_SELECTOR).toContain("[data-local-user]");
  });

  it("drops the optimistic user card only after its authoritative turn arrives", () => {
    const turns = [{ id: "turn-old" }, { id: "turn-new" }];
    expect(localUserReconciledByTurns(undefined, turns)).toBe(false);
    expect(localUserReconciledByTurns("turn-pending", turns)).toBe(false);
    expect(localUserReconciledByTurns("turn-new", turns)).toBe(true);
  });

  it("reconciles an optimistic user card by its stable client message id", () => {
    const turns = [
      {
        id: "turn-new",
        items: [{ type: "userMessage", clientId: "composer-operation-1" }],
      },
    ];
    expect(
      localUserReconciledByTurns(undefined, turns, "composer-operation-1"),
    ).toBe(true);
    expect(
      localUserReconciledByTurns(undefined, turns, "another-operation"),
    ).toBe(false);
  });

  it("reconciles streaming cards only after the authoritative item id appears", () => {
    const turns = [
      {
        id: "turn-new",
        status: "inProgress",
        error: null,
        items: [
          {
            type: "userMessage",
            id: "user-authoritative",
            clientId: null,
            content: [{ type: "text", text: "你好", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "agent-earlier",
            text: "较早回复",
            phase: null,
          },
          {
            type: "agentMessage",
            id: "agent-authoritative",
            text: "首次回复",
            phase: null,
          },
        ],
      },
    ] as never;

    expect(
      streamingItemCandidateId(
        "turn-new",
        "agent-streaming",
        "agent",
        "未匹配",
        turns,
      ),
    ).toBeUndefined();
    expect(
      streamingItemCandidateId(
        "turn-new",
        "agent-authoritative",
        "agent",
        "首次回复",
        turns,
      ),
    ).toBe("agent-authoritative");
    expect(
      streamingItemCandidateId(
        "turn-other",
        "agent-streaming",
        "agent",
        "首次回复",
        turns,
      ),
    ).toBeUndefined();
    expect(
      streamingItemCandidateId(
        "turn-new",
        "unknown-tool-stream",
        "tool",
        "首次回复",
        turns,
      ),
    ).toBeUndefined();
    expect(
      streamingItemCandidateId(
        "turn-new",
        "agent-streaming",
        "agent",
        "首次回复",
        turns,
      ),
    ).toBe("agent-authoritative");
  });

  it("does not guess between authoritative items with identical content", () => {
    const turns = [
      {
        id: "turn-new",
        status: "completed",
        error: null,
        items: [
          { type: "agentMessage", id: "agent-1", text: "same", phase: null },
          { type: "agentMessage", id: "agent-2", text: "same", phase: null },
        ],
      },
    ] as never;

    expect(
      streamingItemCandidateId(
        "turn-new",
        "agent-streaming",
        "agent",
        "same",
        turns,
      ),
    ).toBeUndefined();
  });

  it("reconciles a changed completed id only to one unambiguous active stream", () => {
    const candidates = [
      { turnId: "turn-old", itemId: "old-stream", kind: "agent" as const },
      { turnId: "turn-new", itemId: "active-stream", kind: "agent" as const },
    ];

    expect(completedStreamingCandidateId("turn-new", "agent", candidates)).toBe(
      "active-stream",
    );
    expect(
      completedStreamingCandidateId("turn-new", "plan", candidates),
    ).toBeUndefined();
    expect(
      completedStreamingCandidateId("turn-other", "agent", candidates),
    ).toBeUndefined();
  });

  it("does not guess between multiple active streams of the same turn and kind", () => {
    expect(
      completedStreamingCandidateId("turn-new", "agent", [
        { turnId: "turn-new", itemId: "stream-1", kind: "agent" },
        { turnId: "turn-new", itemId: "stream-2", kind: "agent" },
      ]),
    ).toBeUndefined();
  });

  it("does not alias an exact completed item to a sibling stream", () => {
    expect(
      completedStreamingCandidateId(
        "turn-new",
        "tool",
        [
          {
            turnId: "turn-new",
            itemId: "still-streaming",
            kind: "tool",
            rawText: "still running",
          },
        ],
        true,
        "done",
      ),
    ).toBeUndefined();
  });

  it("removes one matching stale stream beside an exact completed item", () => {
    expect(
      completedStreamingCandidateId(
        "turn-new",
        "agent",
        [
          {
            turnId: "turn-new",
            itemId: "stale-stream",
            kind: "agent",
            rawText: "首次回复",
          },
        ],
        true,
        "首次回复",
      ),
    ).toBe("stale-stream");
  });

  it("reconciles loose user cards by stable client or lifecycle identity", () => {
    const turn = {
      id: "turn-new",
      items: [
        {
          type: "userMessage",
          id: "user-authoritative",
          clientId: "operation-1",
          content: [{ type: "text", text: "你好", text_elements: [] }],
        },
      ],
    } as never;

    expect(
      looseItemReconciledByTurn(
        {
          itemId: "user-started-id",
          clientUserMessageId: "operation-1",
        },
        turn,
      ),
    ).toBe(true);
    expect(
      looseItemReconciledByTurn(
        {
          itemId: "user-started-id",
          lifecycleTurnId: "turn-new",
          kind: "user",
        },
        turn,
      ),
    ).toBe(true);
    expect(
      looseItemReconciledByTurn(
        {
          itemId: "user-started-id",
          lifecycleTurnId: "turn-other",
          kind: "user",
        },
        turn,
      ),
    ).toBe(false);
  });
});
