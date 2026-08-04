import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { QueueRegistry } from "./queue.js";
import { HostStateStore } from "./state-store.js";

describe("QueueRegistry", () => {
  let directory: string | undefined;
  let state: HostStateStore | undefined;
  afterEach(async () => {
    await state?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("persists and atomically claims one item", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "next" }] },
    });
    const [first, second] = await Promise.all([
      queue.claimNext("thread-1"),
      queue.claimNext("thread-1"),
    ]);
    expect([first?.id, second?.id].filter(Boolean)).toEqual([added.id]);
    await queue.pause(added.id);
    expect((await queue.list())[0]?.status).toBe("paused");
    expect(await queue.remove(added.id)).toBe(true);
    expect(await queue.list()).toEqual([]);
  });

  it("reserves a queued item while it is converted to Steer", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-steer-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "urgent context" }] },
    });
    const claim = await queue.claimForSteer(added.id);
    expect(claim).toMatchObject({
      item: { id: added.id, status: "running" },
      previousStatus: "pending",
    });
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    await queue.restoreSteerClaim(added.id, "pending");
    await expect(queue.claimNext("thread-1")).resolves.toMatchObject({
      id: added.id,
    });
  });
});
