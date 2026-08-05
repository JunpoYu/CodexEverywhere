import type { ThreadItem } from "@codex-everywhere/codex-app-server-schema/v2";
import { describe, expect, it } from "vitest";

import {
  describeThreadItem,
  fileChangeItemFromPatchUpdate,
  fileChangeKindLabel,
  isReasoningEventType,
  isVisibleThreadItem,
  mcpServerStartupNotice,
  queuedMessageText,
  TRANSIENT_TIMELINE_SELECTOR,
  threadSnapshotRevision,
  threadSendMode,
} from "./thread-view.js";

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

  it("preserves queued messages and approval cards during snapshot repair", () => {
    expect(TRANSIENT_TIMELINE_SELECTOR).toContain("[data-queue-id]");
    expect(TRANSIENT_TIMELINE_SELECTOR).toContain("[data-request-id]");
    expect(TRANSIENT_TIMELINE_SELECTOR).toContain(".timeline-entry.streaming");
  });
});
