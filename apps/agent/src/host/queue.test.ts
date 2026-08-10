import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueRegistry, queueConsumptionIdentity } from "./queue.js";
import { HostStateStore } from "./state-store.js";
import {
  consumeQueueItemOnce,
  QueueConsumptionRepairer,
} from "../runtime/queue-consumption.js";

describe("QueueRegistry", () => {
  let directory: string | undefined;
  let state: HostStateStore | undefined;
  let repairer: QueueConsumptionRepairer | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await repairer?.close();
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

  it("keeps new pending state additive and invisible to old Agents across restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-additive-state-"));
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    let queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-new",
      turnPayload: {
        clientUserMessageId: "operation-new",
        input: [{ type: "text", text: "PRIVATE NEW QUEUE CONTENT" }],
      },
    });

    await expect(
      state.read((database) => ({
        newState: database.exec(
          "SELECT queue_items.status, queue_item_states.status FROM queue_items JOIN queue_item_states ON queue_item_states.queue_item_id = queue_items.id WHERE queue_items.id = ?",
          [added.id],
        )[0]?.values[0],
        oldAgentVisible: database.exec(
          "SELECT id FROM queue_items WHERE status != 'done'",
        )[0]?.values,
      })),
    ).resolves.toEqual({
      newState: ["done", "pending"],
      oldAgentVisible: undefined,
    });
    await state.close();
    state = await HostStateStore.open(statePath);
    queue = new QueueRegistry(state);

    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(queue.claimNext("thread-new")).resolves.toMatchObject({
      id: added.id,
      status: "running",
    });
    const additiveState = await state.read(
      (database) =>
        database.exec(
          "SELECT queue_item_id, status FROM queue_item_states WHERE queue_item_id = ?",
          [added.id],
        )[0]?.values[0],
    );
    expect(additiveState).toEqual([added.id, "running"]);
    expect(JSON.stringify(additiveState)).not.toContain(
      "PRIVATE NEW QUEUE CONTENT",
    );
  });

  it("fails closed if a live old process corrupts the physical rollback barrier", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-raw-invariant-"));
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    let queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-corrupt",
      turnPayload: { input: [{ type: "text", text: "must not execute" }] },
    });
    await state.transaction((database) => {
      database.run("UPDATE queue_items SET status = 'pending' WHERE id = ?", [
        added.id,
      ]);
    });

    await expect(queue.list()).resolves.toEqual([]);
    await expect(queue.claimNext("thread-corrupt")).resolves.toBeUndefined();
    await expect(queue.claimForSteer(added.id)).resolves.toBeUndefined();
    await expect(queue.remove(added.id)).resolves.toBe(false);

    await state.close();
    state = await HostStateStore.open(statePath);
    queue = new QueueRegistry(state);
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
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

  it.each(["dispatch", "steer"] as const)(
    "repairs a published pre-claim %s reservation when persistence reports failure",
    async (mode) => {
      directory = await mkdtemp(join(tmpdir(), "ce-queue-reservation-repair-"));
      state = await HostStateStore.open(join(directory, "state.sqlite"));
      const queue = new QueueRegistry(state);
      const added = await queue.add({
        workspacePath: "/workspace",
        threadId: "thread-1",
        turnPayload: { input: [{ type: "text", text: "next" }] },
      });
      const transaction = state.transaction.bind(state);
      let injectPostPublishFailure = true;
      vi.spyOn(state, "transaction").mockImplementation(async (operation) => {
        const result = await transaction(operation);
        if (injectPostPublishFailure) {
          injectPostPublishFailure = false;
          throw new Error("injected post-publication durability failure");
        }
        return result;
      });

      await expect(
        mode === "dispatch"
          ? queue.claimNext("thread-1")
          : queue.claimForSteer(added.id),
      ).rejects.toThrow("post-publication durability failure");

      await expect(queue.get(added.id)).resolves.toMatchObject({
        status: "pending",
      });
      if (mode === "dispatch") {
        await expect(queue.claimNext("thread-1")).resolves.toMatchObject({
          id: added.id,
        });
      } else {
        await expect(queue.claimForSteer(added.id)).resolves.toMatchObject({
          item: { id: added.id },
          previousStatus: "pending",
        });
      }
    },
  );

  it("publishes a content-free physical downgrade barrier before delivery", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-consumption-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-private",
        input: [{ type: "text", text: "PRIVATE QUEUE CONTENT" }],
      },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");

    const claim = await queue.beginConsumption(item, "turn/start");
    expect(claim).toMatchObject({
      claimed: true,
      identity: {
        queueItemId: added.id,
        operation: "turn/start",
        threadId: "thread-1",
        clientUserMessageId: "operation-private",
      },
    });
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "delivering",
    });
    await expect(queue.remove(added.id)).resolves.toBe(false);
    await expect(queue.claimForSteer(added.id)).resolves.toBeUndefined();
    const persisted = await state.read(
      (database) =>
        database.exec(
          "SELECT queue_items.status, queue_consumption_claims.operation, queue_consumption_claims.thread_id, queue_consumption_claims.client_user_message_id, queue_consumption_claims.outcome FROM queue_items JOIN queue_consumption_claims ON queue_consumption_claims.queue_item_id = queue_items.id",
        )[0]?.values[0],
    );
    expect(persisted).toEqual([
      "done",
      "turn/start",
      "thread-1",
      "operation-private",
      null,
    ]);
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE QUEUE CONTENT");

    await queue.markConsumptionIndeterminate(item, "turn/start");
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(queue.remove(added.id)).resolves.toBe(false);
    await expect(
      queue.remove(added.id, { acknowledgeIndeterminate: true }),
    ).resolves.toBe(true);
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT outcome FROM queue_consumption_claims WHERE queue_item_id = ?",
            [added.id],
          )[0]?.values,
      ),
    ).resolves.toEqual([["abandoned"]]);
  });

  it("atomically hides a verified queue consumption from current and old Agents", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-completed-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-completed",
        input: [{ type: "text", text: "next" }],
      },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    const claim = await queue.beginConsumption(item, "turn/start");

    await queue.completeConsumption(claim.identity, "turn-1");

    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "done",
    });
    await expect(queue.list()).resolves.toEqual([]);
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT queue_items.status, queue_consumption_claims.outcome, queue_consumption_claims.turn_id FROM queue_items JOIN queue_consumption_claims ON queue_consumption_claims.queue_item_id = queue_items.id",
          )[0]?.values[0],
      ),
    ).resolves.toEqual(["done", "completed", "turn-1"]);
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    await queue.pause(added.id);
    await queue.restoreSteerClaim(added.id, "pending");
    await queue.markConsumptionIndeterminate(item, "turn/start");
    await expect(queue.remove(added.id)).resolves.toBe(false);
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "done",
    });
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT queue_items.status, queue_consumption_claims.outcome FROM queue_items JOIN queue_consumption_claims ON queue_consumption_claims.queue_item_id = queue_items.id WHERE queue_items.id = ?",
            [added.id],
          )[0]?.values[0],
      ),
    ).resolves.toEqual(["done", "completed"]);
  });

  it("treats unknown durable claim values as indeterminate and blocking", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-unknown-claim-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const first = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "first" }] },
    });
    const second = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "second" }] },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    await queue.beginConsumption(item, "turn/start");
    await state.transaction((database) => {
      database.run(
        "UPDATE queue_consumption_claims SET operation = '', outcome = 'future-unknown' WHERE queue_item_id = ?",
        [first.id],
      );
    });

    await expect(queue.get(first.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(queue.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "indeterminate" }),
        expect.objectContaining({ id: second.id, status: "pending" }),
      ]),
    );
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    await expect(queue.claimForSteer(second.id)).resolves.toBeUndefined();
    await expect(queue.remove(first.id)).resolves.toBe(false);
    await expect(
      queue.remove(first.id, { acknowledgeIndeterminate: true }),
    ).resolves.toBe(true);
    await expect(queue.claimNext("thread-1")).resolves.toMatchObject({
      id: second.id,
    });
  });

  it("blocks later same-thread work until an indeterminate head is explicitly abandoned", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-thread-barrier-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const first = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "first" }] },
    });
    const second = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "second" }] },
    });
    const claimed = await queue.claimNext("thread-1");
    if (!claimed) throw new Error("Expected the first queue claim");
    await queue.beginConsumption(claimed, "turn/start");
    await queue.markConsumptionIndeterminate(claimed, "turn/start");

    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    await expect(queue.claimForSteer(second.id)).resolves.toBeUndefined();
    await expect(queue.remove(first.id)).resolves.toBe(false);

    await expect(
      queue.remove(first.id, { acknowledgeIndeterminate: true }),
    ).resolves.toBe(true);
    await expect(queue.claimNext("thread-1")).resolves.toMatchObject({
      id: second.id,
      status: "running",
    });
  });

  it("does not skip a paused head to dispatch or Steer a later item", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-order-barrier-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const first = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "first" }] },
    });
    const second = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "second" }] },
    });
    await queue.claimNext("thread-1");
    await queue.pause(first.id);

    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    await expect(queue.claimForSteer(second.id)).resolves.toBeUndefined();

    await expect(queue.remove(first.id)).resolves.toBe(true);
    await expect(queue.claimNext("thread-1")).resolves.toMatchObject({
      id: second.id,
    });
  });

  it.each(["turn/start", "turn/steer"] as const)(
    "never invokes a claimed %s queue consumption twice after an unknown response",
    async (operation) => {
      directory = await mkdtemp(join(tmpdir(), "ce-queue-unknown-"));
      state = await HostStateStore.open(join(directory, "state.sqlite"));
      const queue = new QueueRegistry(state);
      const added = await queue.add({
        workspacePath: "/workspace",
        threadId: "thread-1",
        turnPayload: {
          clientUserMessageId: `operation-${operation}`,
          input: [{ type: "text", text: "PRIVATE UNKNOWN CONTENT" }],
        },
      });
      const item =
        operation === "turn/start"
          ? await queue.claimNext("thread-1")
          : (await queue.claimForSteer(added.id))?.item;
      if (!item) throw new Error("Expected a queue claim");
      const execute = vi.fn(async () => {
        throw new Error(`disconnect after accepting ${operation}`);
      });
      repairer = new QueueConsumptionRepairer(queue);

      await expect(
        consumeQueueItemOnce({ queue, repairer, item, operation, execute }),
      ).rejects.toThrow("outcome is indeterminate");
      await expect(
        consumeQueueItemOnce({ queue, repairer, item, operation, execute }),
      ).rejects.toThrow("outcome is indeterminate");
      expect(execute).toHaveBeenCalledOnce();
      await expect(queue.get(added.id)).resolves.toMatchObject({
        status: "indeterminate",
      });
      await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
      await expect(queue.claimForSteer(added.id)).resolves.toBeUndefined();
    },
  );

  it("keeps a verified turn indeterminate when completing its durable claim fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-finish-failure-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-finish-failure",
        input: [{ type: "text", text: "next" }],
      },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    vi.spyOn(queue, "completeConsumption").mockRejectedValueOnce(
      new Error("injected completion persistence failure"),
    );
    const execute = vi.fn(async () => ({ turnId: "turn-1" }));
    repairer = new QueueConsumptionRepairer(queue);

    await expect(
      consumeQueueItemOnce({
        queue,
        repairer,
        item,
        operation: "turn/start",
        execute,
      }),
    ).rejects.toThrow("outcome is indeterminate");
    expect(execute).toHaveBeenCalledOnce();
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
  });

  it("repairs a transient indeterminate-mark failure without executing the mutation twice", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-repair-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const first = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-repair",
        input: [{ type: "text", text: "PRIVATE REPAIR CONTENT" }],
      },
    });
    const second = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "safe next" }] },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    const repair = queue.ensureConsumptionIndeterminate.bind(queue);
    const repairSpy = vi
      .spyOn(queue, "ensureConsumptionIndeterminate")
      .mockRejectedValueOnce(new Error("injected immediate mark failure"))
      .mockRejectedValueOnce(new Error("injected background mark failure"))
      .mockImplementation(repair);
    repairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 8,
    });
    const repaired = vi.fn();
    repairer.onIndeterminate(repaired);
    const execute = vi.fn(async () => {
      throw new Error("disconnect after accepted turn/start");
    });

    await expect(
      consumeQueueItemOnce({
        queue,
        repairer,
        item,
        operation: "turn/start",
        execute,
      }),
    ).rejects.toThrow("outcome is indeterminate");
    expect(execute).toHaveBeenCalledOnce();
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();

    await vi.waitFor(async () => {
      expect(await queue.get(first.id)).toMatchObject({
        status: "indeterminate",
      });
    });
    expect(repairSpy).toHaveBeenCalledTimes(3);
    expect(repaired).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      queue.remove(first.id, { acknowledgeIndeterminate: true }),
    ).resolves.toBe(true);
    await expect(queue.claimNext("thread-1")).resolves.toMatchObject({
      id: second.id,
    });
  });

  it("cancels a deduplicated repair backoff on close and leaves restart repair intact", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-repair-close-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "next" }] },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    const claim = await queue.beginConsumption(item, "turn/start");
    const repairSpy = vi
      .spyOn(queue, "ensureConsumptionIndeterminate")
      .mockRejectedValue(new Error("storage remains unavailable"));
    repairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 16,
    });
    repairer.schedule(claim.identity, true);
    repairer.schedule(claim.identity, true);
    await vi.waitFor(() => expect(repairSpy).toHaveBeenCalled());

    await repairer.close();
    repairer = undefined;
    const attemptsAtClose = repairSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(repairSpy).toHaveBeenCalledTimes(attemptsAtClose);
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "delivering",
    });

    vi.restoreAllMocks();
    await queue.pauseInterruptedClaims();
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
  });

  it("does not downgrade a completion that published before reporting a durability error", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-complete-published-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "next" }] },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    const complete = queue.completeConsumption.bind(queue);
    vi.spyOn(queue, "completeConsumption").mockImplementationOnce(
      async (identity, turnId) => {
        await complete(identity, turnId);
        throw new Error("injected post-publication completion error");
      },
    );
    const repairSpy = vi.spyOn(queue, "ensureConsumptionIndeterminate");
    repairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 8,
    });
    const execute = vi.fn(async () => ({ turnId: "turn-completed" }));

    await expect(
      consumeQueueItemOnce({
        queue,
        repairer,
        item,
        operation: "turn/start",
        execute,
      }),
    ).rejects.toThrow("outcome is indeterminate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execute).toHaveBeenCalledOnce();
    expect(repairSpy).toHaveBeenCalledOnce();
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "done",
    });
    await expect(queue.list()).resolves.toEqual([]);
  });

  it("leaves a definite pre-claim failure retryable without manufacturing a tombstone", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-preclaim-failure-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "not submitted" }] },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    vi.spyOn(queue, "beginConsumption").mockRejectedValueOnce(
      new Error("injected pre-publication reservation failure"),
    );
    repairer = new QueueConsumptionRepairer(queue);
    const execute = vi.fn(async () => ({ turnId: "must-not-run" }));

    await expect(
      consumeQueueItemOnce({
        queue,
        repairer,
        item,
        operation: "turn/start",
        execute,
      }),
    ).rejects.toThrow("pre-publication reservation failure");
    expect(execute).not.toHaveBeenCalled();
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT queue_item_id FROM queue_consumption_claims WHERE queue_item_id = ?",
            [added.id],
          )[0]?.values,
      ),
    ).resolves.toBeUndefined();
    await queue.pause(added.id);
    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "paused",
    });
  });

  it("background-pauses a reservation when both the pre-claim check and immediate repair fail", async () => {
    directory = await mkdtemp(
      join(tmpdir(), "ce-queue-preclaim-double-failure-"),
    );
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: { input: [{ type: "text", text: "not submitted" }] },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    vi.spyOn(queue, "beginConsumption").mockRejectedValueOnce(
      new Error("injected pre-publication claim failure"),
    );
    const repair = queue.repairConsumptionIndeterminate.bind(queue);
    vi.spyOn(queue, "repairConsumptionIndeterminate")
      .mockRejectedValueOnce(new Error("injected repair read failure"))
      .mockImplementation(repair);
    repairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 8,
    });
    const paused = vi.fn();
    repairer.onPaused(paused);
    const execute = vi.fn(async () => ({ turnId: "must-not-run" }));

    await expect(
      consumeQueueItemOnce({
        queue,
        repairer,
        item,
        operation: "turn/start",
        execute,
      }),
    ).rejects.toThrow("outcome is indeterminate");
    expect(execute).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect(await queue.get(added.id)).toMatchObject({ status: "paused" });
    });
    expect(paused).toHaveBeenCalledOnce();
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT queue_item_id FROM queue_consumption_claims WHERE queue_item_id = ?",
            [added.id],
          )[0]?.values,
      ),
    ).resolves.toBeUndefined();
  });

  it("creates a minimal fail-closed tombstone if a proven crossed claim is missing", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-crossed-missing-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-crossed-missing",
        input: [{ type: "text", text: "PRIVATE CROSSED CONTENT" }],
      },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    repairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 8,
    });

    const identity = queueConsumptionIdentity(item, "turn/start");
    repairer.schedule(identity, false);
    repairer.schedule(identity, true);

    await vi.waitFor(async () => {
      expect(await queue.get(added.id)).toMatchObject({
        status: "indeterminate",
      });
    });
    const persisted = await state.read(
      (database) =>
        database.exec(
          "SELECT operation, thread_id, client_user_message_id, outcome FROM queue_consumption_claims WHERE queue_item_id = ?",
          [added.id],
        )[0]?.values[0],
    );
    expect(persisted).toEqual([
      "turn/start",
      "thread-1",
      "operation-crossed-missing",
      "indeterminate",
    ]);
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE CROSSED CONTENT");
  });

  it("recreates a crossed tombstone in the background after its immediate repair fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-crossed-repair-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-crossed-repair",
        input: [{ type: "text", text: "PRIVATE ACCEPTED CONTENT" }],
      },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    const ensure = queue.ensureConsumptionIndeterminate.bind(queue);
    vi.spyOn(queue, "ensureConsumptionIndeterminate")
      .mockImplementationOnce(async (identity) => {
        await state!.transaction((database) => {
          database.run(
            "DELETE FROM queue_consumption_claims WHERE queue_item_id = ?",
            [identity.queueItemId],
          );
        });
        throw new Error("injected immediate tombstone repair failure");
      })
      .mockImplementation(ensure);
    repairer = new QueueConsumptionRepairer(queue, {
      initialDelayMs: 2,
      maxDelayMs: 8,
    });
    const execute = vi.fn(async () => {
      throw new Error("accepted response was lost");
    });

    await expect(
      consumeQueueItemOnce({
        queue,
        repairer,
        item,
        operation: "turn/start",
        execute,
      }),
    ).rejects.toThrow("outcome is indeterminate");
    await vi.waitFor(async () => {
      expect(await queue.get(added.id)).toMatchObject({
        status: "indeterminate",
      });
    });
    expect(execute).toHaveBeenCalledOnce();
    const persisted = await state.read(
      (database) =>
        database.exec(
          "SELECT operation, client_user_message_id, outcome FROM queue_consumption_claims WHERE queue_item_id = ?",
          [added.id],
        )[0]?.values[0],
    );
    expect(persisted).toEqual([
      "turn/start",
      "operation-crossed-repair",
      "indeterminate",
    ]);
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE ACCEPTED CONTENT");
  });

  it("turns a crash-surviving delivery into manual review without replay", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-queue-restart-"));
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    let queue = new QueueRegistry(state);
    const added = await queue.add({
      workspacePath: "/workspace",
      threadId: "thread-1",
      turnPayload: {
        clientUserMessageId: "operation-restart",
        input: [{ type: "text", text: "next" }],
      },
    });
    const item = await queue.claimNext("thread-1");
    if (!item) throw new Error("Expected a queue claim");
    await queue.beginConsumption(item, "turn/start");
    await state.close();
    state = await HostStateStore.open(statePath);
    queue = new QueueRegistry(state);

    await queue.pauseInterruptedClaims();

    await expect(queue.get(added.id)).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(queue.claimNext("thread-1")).resolves.toBeUndefined();
    await expect(queue.claimForSteer(added.id)).resolves.toBeUndefined();
  });
});
