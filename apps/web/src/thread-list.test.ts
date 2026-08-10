import { describe, expect, it, vi } from "vitest";

import {
  FAST_THREAD_LIST_TIMEOUT_MS,
  LEGACY_THREAD_LIST_TIMEOUT_MS,
  mergeThreadPages,
  requestThreadList,
  threadListErrorMessage,
  type ThreadListRequester,
} from "./thread-list.js";

describe("requestThreadList", () => {
  it("uses the state database for normal history refreshes", async () => {
    const request = vi.fn().mockResolvedValue({ data: [{ id: "thread-1" }] });
    const client = { request } as ThreadListRequester;

    await expect(
      requestThreadList(client, {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    ).resolves.toEqual({ data: [{ id: "thread-1" }] });
    expect(request).toHaveBeenCalledWith(
      "thread/list",
      {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
      },
      { timeoutMs: FAST_THREAD_LIST_TIMEOUT_MS },
    );
  });

  it("repairs history when a new state database has no indexed threads", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [{ id: "legacy-thread" }] });
    const client = { request } as ThreadListRequester;

    await expect(requestThreadList(client, { limit: 100 })).resolves.toEqual({
      data: [{ id: "legacy-thread" }],
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      "thread/list",
      { limit: 100 },
      { timeoutMs: LEGACY_THREAD_LIST_TIMEOUT_MS },
    );
  });

  it("falls back once for an older app-server that rejects the field", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Invalid params: unknown field `useStateDbOnly`"),
      )
      .mockResolvedValue({ data: [] });
    const client = { request } as ThreadListRequester;
    const params = { limit: 100 };

    await requestThreadList(client, params);
    await requestThreadList(client, params);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(2, "thread/list", params, {
      timeoutMs: LEGACY_THREAD_LIST_TIMEOUT_MS,
    });
    expect(request).toHaveBeenNthCalledWith(3, "thread/list", params, {
      timeoutMs: LEGACY_THREAD_LIST_TIMEOUT_MS,
    });
  });

  it("does not retry a genuine host timeout and compound the queue", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("Host request timed out: thread/list"));
    const client = { request } as ThreadListRequester;

    await expect(requestThreadList(client, { limit: 100 })).rejects.toThrow(
      "timed out",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not restart a legacy scan after reaching an empty later page", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [],
      nextCursor: null,
    });
    const client = { request } as ThreadListRequester;

    await requestThreadList(client, { limit: 100, cursor: "page-2" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "thread/list",
      { limit: 100, cursor: "page-2", useStateDbOnly: true },
      { timeoutMs: FAST_THREAD_LIST_TIMEOUT_MS },
    );
  });
});

describe("mergeThreadPages", () => {
  it("preserves order while replacing duplicate thread summaries", () => {
    expect(
      mergeThreadPages(
        [
          { id: "one", preview: "old" },
          { id: "two", preview: "two" },
        ],
        [
          { id: "one", preview: "new" },
          { id: "three", preview: "three" },
        ],
      ),
    ).toEqual([
      { id: "one", preview: "new" },
      { id: "two", preview: "two" },
      { id: "three", preview: "three" },
    ]);
  });
});

describe("threadListErrorMessage", () => {
  it("turns transport and app-server timeouts into an actionable message", () => {
    for (const message of [
      "Host request timed out: thread/list",
      "Timed out waiting for Codex app-server response: thread/list",
    ]) {
      expect(threadListErrorMessage(new Error(message))).toContain(
        "已保留当前列表",
      );
    }
  });

  it("preserves unrelated errors", () => {
    expect(threadListErrorMessage(new Error("permission denied"))).toBe(
      "permission denied",
    );
  });

  it("explains rolling-version gaps for archive discovery", () => {
    expect(
      threadListErrorMessage(
        new Error("Invalid params: unknown field `archived`"),
      ),
    ).toContain("当前 Codex 版本不支持");
  });
});
