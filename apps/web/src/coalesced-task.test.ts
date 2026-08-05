import { describe, expect, it, vi } from "vitest";

import { createCoalescedTask } from "./coalesced-task.js";

describe("createCoalescedTask", () => {
  it("collapses overlapping calls into one follow-up execution", async () => {
    const releases: Array<() => void> = [];
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const run = createCoalescedTask(task);

    const first = run();
    const second = run();
    const third = run();
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(task).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await first;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("allows a later call after a failed execution", async () => {
    const task = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce();
    const run = createCoalescedTask(task);

    await expect(run()).rejects.toThrow("failed");
    await expect(run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
