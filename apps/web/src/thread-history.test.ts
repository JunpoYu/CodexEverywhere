import type {
  ThreadResumeResponse,
  Turn,
  TurnsPage,
} from "@codex-everywhere/codex-app-server-schema/v2";
import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_PAGE_SIZE,
  newestPageInReadingOrder,
  resumeThreadHistory,
} from "./thread-history.js";

describe("thread history pagination", () => {
  it("opens only the newest page and restores reading order", async () => {
    const page = turnsPage([turn("new"), turn("old")], "older");
    const request = vi.fn(async () => ({
      ...resumeResponse([]),
      initialTurnsPage: page,
    }));

    const history = await resumeThreadHistory({ request }, "thread-1");

    expect(history.detail.thread.turns.map((value: Turn) => value.id)).toEqual([
      "old",
      "new",
    ]);
    expect(history.nextCursor).toBe("older");
    expect(history.paged).toBe(true);
    expect(request).toHaveBeenCalledWith("thread/resume", {
      threadId: "thread-1",
      excludeTurns: true,
      initialTurnsPage: {
        limit: HISTORY_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "full",
      },
    });
  });

  it("requests a page separately when resume omits the optional page", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(resumeResponse([]))
      .mockResolvedValueOnce(turnsPage([turn("latest")], null));

    await expect(
      resumeThreadHistory({ request }, "thread-1"),
    ).resolves.toMatchObject({
      paged: true,
      nextCursor: undefined,
    });
    expect(request).toHaveBeenLastCalledWith("thread/turns/list", {
      threadId: "thread-1",
      limit: HISTORY_PAGE_SIZE,
      sortDirection: "desc",
      itemsView: "full",
    });
  });

  it("falls back to full history only for an older unsupported server", async () => {
    const legacy = resumeResponse([turn("legacy")]);
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Invalid params: unknown field `initialTurnsPage`"),
      )
      .mockResolvedValueOnce(legacy);

    await expect(resumeThreadHistory({ request }, "thread-1")).resolves.toEqual(
      {
        detail: legacy,
        nextCursor: undefined,
        paged: false,
      },
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reuses full turns when an older server ignores resume pagination", async () => {
    const legacy = resumeResponse([turn("legacy")]);
    const request = vi
      .fn()
      .mockResolvedValueOnce(legacy)
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      );

    await expect(resumeThreadHistory({ request }, "thread-1")).resolves.toEqual(
      {
        detail: legacy,
        nextCursor: undefined,
        paged: false,
      },
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not hide a real resume failure behind an expensive fallback", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("Host connection closed"));
    await expect(resumeThreadHistory({ request }, "thread-1")).rejects.toThrow(
      "Host connection closed",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not mutate a descending server page while reversing it", () => {
    const page = turnsPage([turn("new"), turn("old")], null);
    expect(
      newestPageInReadingOrder(page).map((value: Turn) => value.id),
    ).toEqual(["old", "new"]);
    expect(page.data.map((value: Turn) => value.id)).toEqual(["new", "old"]);
  });
});

function turn(id: string): Turn {
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

function turnsPage(data: Turn[], nextCursor: string | null): TurnsPage {
  return { data, nextCursor, backwardsCursor: null };
}

function resumeResponse(turns: Turn[]): ThreadResumeResponse {
  return {
    thread: {
      id: "thread-1",
      sessionId: "session-1",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      recencyAt: null,
      status: { type: "idle" },
      path: null,
      cwd: "/work",
      cliVersion: "0.144.1",
      source: "cli",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns,
    },
    model: "gpt-5",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/work",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    reasoningEffort: null,
  };
}
