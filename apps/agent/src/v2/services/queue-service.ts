import { randomUUID } from "node:crypto";

import { Scope, TypedEventBus } from "@codex-everywhere/kernel";
import { GatewayV2Error } from "@codex-everywhere/protocol/v2";

import type {
  QueueDeliveryIdentity,
  QueueRecord,
  QueueRepository,
} from "../repositories/queue-repository.js";
import { QueueStateConflictError } from "../repositories/queue-repository.js";
import type { AutoTitleServicePort } from "./auto-title-service.js";
import { hasExplicitThreadName } from "./auto-title.js";
import type {
  ThreadLease,
  ThreadLeaseManager,
} from "./thread-lease-manager.js";

export interface QueueServiceEvents {
  readonly changed: QueueRecord;
  readonly removed: { readonly itemId: string };
  readonly delivery: {
    readonly itemId: string;
    readonly threadId: string;
    readonly state: "delivering" | "completed" | "indeterminate" | "paused";
  };
}

export interface QueueServiceOptions {
  readonly scope: Scope;
  readonly repository: QueueRepository;
  readonly leases: ThreadLeaseManager;
  readonly titles: AutoTitleServicePort;
  /** Resolves and authorizes a real workspace path without returning content. */
  readonly authorizeWorkspace: (path: string) => Promise<string>;
  readonly dispatchIntervalMs?: number;
}

/** At-most-once Queue dispatcher. It never crosses app-server before a claim. */
export class QueueService {
  readonly events = new TypedEventBus<QueueServiceEvents>();
  readonly #scope: Scope;
  readonly #repository: QueueRepository;
  readonly #leases: ThreadLeaseManager;
  readonly #titles: AutoTitleServicePort;
  readonly #authorizeWorkspace: (path: string) => Promise<string>;
  readonly #dispatchIntervalMs: number;
  #started = false;
  #draining: Promise<boolean> | undefined;

  constructor(options: QueueServiceOptions) {
    this.#scope = options.scope.fork("queue");
    this.#repository = options.repository;
    this.#leases = options.leases;
    this.#titles = options.titles;
    this.#authorizeWorkspace = options.authorizeWorkspace;
    this.#dispatchIntervalMs = options.dispatchIntervalMs ?? 1_000;
    if (
      !Number.isSafeInteger(this.#dispatchIntervalMs) ||
      this.#dispatchIntervalMs < 50
    ) {
      throw new Error("Queue dispatch interval is too small");
    }
  }

  async start(): Promise<number> {
    if (this.#started) return 0;
    this.#scope.throwIfClosed();
    const recovered = await this.#repository.recoverDelivering();
    this.#started = true;
    this.#scope.setInterval(
      () => void this.dispatchOnce().catch(() => undefined),
      this.#dispatchIntervalMs,
    );
    void this.dispatchOnce().catch(() => undefined);
    return recovered;
  }

  list(threadId?: string): Promise<QueueRecord[]> {
    return this.#repository.list(threadId === undefined ? {} : { threadId });
  }

  async add(input: {
    readonly threadId: string;
    readonly text: string;
  }): Promise<QueueRecord> {
    const referenceId = `queue-add:${randomUUID()}`;
    const handle = await this.#leases.acquire(input.threadId, {
      kind: "queue",
      id: referenceId,
    });
    try {
      const snapshot = await handle.lease.synchronize(false);
      const workspacePath = await this.#authorizeWorkspace(
        snapshot.workspacePath,
      );
      const item = await this.#repository.add({
        workspacePath,
        threadId: input.threadId,
        text: input.text,
      });
      this.events.emit("changed", item);
      void this.dispatchOnce().catch(() => undefined);
      return item;
    } finally {
      await handle.release();
    }
  }

  async remove(itemId: string): Promise<boolean> {
    const removed = await this.#repository.remove(itemId);
    if (removed) this.events.emit("removed", { itemId });
    return removed;
  }

  async steer(itemId: string, replacementText: string): Promise<QueueRecord> {
    const current = await this.#repository.get(itemId);
    if (current === undefined) throw queueUnavailable(itemId);
    const handle = await this.#leases.acquire(current.threadId, {
      kind: "queue",
      id: `queue-steer:${itemId}`,
    });
    try {
      const snapshot = await handle.lease.synchronize(true);
      if (
        snapshot.state !== "running" ||
        snapshot.currentTurnId === undefined
      ) {
        throw new GatewayV2Error(
          "QUEUE_STEER_UNAVAILABLE",
          "The task has no active turn that can be steered",
        );
      }
      await this.#assertWorkspaceUnchanged(current, snapshot.workspacePath);
      const claimed = await this.#repository.claim({
        itemId,
        expectedRevision: current.revision,
        operation: "turn/steer",
        replacementText,
      });
      this.#deliveryEvent(claimed.item, "delivering");
      return await this.#deliver(
        handle.lease,
        claimed.item,
        claimed.identity,
        snapshot.currentTurnId,
        !hasExplicitThreadName(snapshot.thread),
      );
    } catch (error) {
      if (error instanceof QueueStateConflictError)
        throw queueUnavailable(itemId);
      throw error;
    } finally {
      await handle.release();
    }
  }

  async acknowledgeIndeterminate(
    itemId: string,
    disposition: "retry" | "dismiss",
  ): Promise<QueueRecord> {
    try {
      const item = await this.#repository.acknowledgeIndeterminate(
        itemId,
        disposition,
      );
      this.events.emit("changed", item);
      if (disposition === "retry") {
        void this.dispatchOnce().catch(() => undefined);
      }
      return item;
    } catch (error) {
      if (error instanceof QueueStateConflictError)
        throw queueUnavailable(itemId);
      throw error;
    }
  }

  dispatchOnce(): Promise<boolean> {
    if (!this.#started || this.#scope.closed) return Promise.resolve(false);
    if (this.#draining !== undefined) return this.#draining;
    const draining = this.#dispatchNext().finally(() => {
      if (this.#draining === draining) this.#draining = undefined;
    });
    this.#draining = draining;
    return draining;
  }

  async #dispatchNext(): Promise<boolean> {
    const current = await this.#repository.nextPending();
    if (current === undefined) return false;
    const handle = await this.#leases.acquire(current.threadId, {
      kind: "queue",
      id: `queue-dispatch:${current.id}`,
    });
    try {
      let snapshot;
      try {
        snapshot = await handle.lease.synchronize(true);
      } catch {
        // Codex may be unavailable during setup or app-server recovery. Leave
        // the item pending so the next dispatcher tick can retry safely before
        // any durable delivery claim exists.
        return false;
      }
      try {
        await this.#assertWorkspaceUnchanged(current, snapshot.workspacePath);
      } catch {
        const paused = await this.#repository.pause(current.id);
        this.events.emit("changed", paused);
        this.#deliveryEvent(paused, "paused");
        return false;
      }
      if (snapshot.state === "running" || snapshot.state === "waiting-input") {
        return false;
      }
      if (snapshot.state !== "idle") {
        const paused = await this.#repository.pause(current.id);
        this.events.emit("changed", paused);
        this.#deliveryEvent(paused, "paused");
        return false;
      }

      let claimed;
      try {
        claimed = await this.#repository.claim({
          itemId: current.id,
          expectedRevision: current.revision,
          operation: "turn/start",
        });
      } catch (error) {
        if (error instanceof QueueStateConflictError) return false;
        throw error;
      }
      this.#deliveryEvent(claimed.item, "delivering");
      await this.#deliver(
        handle.lease,
        claimed.item,
        claimed.identity,
        undefined,
        !hasExplicitThreadName(snapshot.thread),
      );
      return true;
    } finally {
      await handle.release();
    }
  }

  async #deliver(
    lease: ThreadLease,
    item: QueueRecord,
    identity: QueueDeliveryIdentity,
    expectedTurnId?: string,
    autoTitleEligible = false,
  ): Promise<QueueRecord> {
    let turnId: string;
    const releaseTerminalObservation =
      identity.operation === "turn/steer" &&
      autoTitleEligible &&
      expectedTurnId !== undefined
        ? lease.observeTerminalTurn(expectedTurnId)
        : undefined;
    const releaseStartObservation =
      identity.operation === "turn/start"
        ? lease.observeTurnStartResponse()
        : undefined;
    try {
      try {
        if (identity.operation === "turn/steer") {
          if (expectedTurnId === undefined) {
            throw new Error("Steer delivery has no active turn precondition");
          }
          const response = await lease.request<unknown>("turn/steer", {
            threadId: identity.threadId,
            expectedTurnId,
            input: textInput(item.text),
            clientUserMessageId: identity.clientUserMessageId,
          });
          turnId = responseTurnId(response, false);
        } else {
          const response = await lease.request<unknown>("turn/start", {
            threadId: identity.threadId,
            cwd: item.workspacePath,
            input: textInput(item.text),
            clientUserMessageId: identity.clientUserMessageId,
          });
          turnId = responseTurnId(response, true);
          lease.noteTurnStarted(turnId);
        }
      } catch {
        const repaired = await this.#markIndeterminate(identity);
        this.events.emit("changed", repaired);
        if (repaired.status === "completed") {
          this.#deliveryEvent(repaired, "completed");
          return repaired;
        }
        this.#deliveryEvent(repaired, "indeterminate");
        throw new GatewayV2Error(
          "QUEUE_OUTCOME_UNKNOWN",
          "Queue delivery may have reached Codex; automatic replay is disabled",
        );
      }

      if (autoTitleEligible) {
        try {
          this.#titles.schedule(lease, turnId, item.text);
        } catch {
          // Optional presentation work cannot alter Queue delivery semantics.
        }
      }
    } finally {
      releaseTerminalObservation?.();
      releaseStartObservation?.();
    }

    try {
      const completed = await this.#repository.complete(identity, turnId);
      this.events.emit("changed", completed);
      this.#deliveryEvent(completed, "completed");
      return completed;
    } catch {
      const repaired = await this.#markIndeterminate(identity);
      this.events.emit("changed", repaired);
      if (repaired.status === "completed") {
        this.#deliveryEvent(repaired, "completed");
        return repaired;
      }
      this.#deliveryEvent(repaired, "indeterminate");
      throw new GatewayV2Error(
        "QUEUE_OUTCOME_UNKNOWN",
        "Codex accepted the Queue item but its result was not committed",
      );
    }
  }

  async #markIndeterminate(
    identity: QueueDeliveryIdentity,
  ): Promise<QueueRecord> {
    try {
      return await this.#repository.markIndeterminate(identity);
    } catch {
      const current = await this.#repository.get(identity.queueItemId);
      if (current !== undefined) return current;
      throw new Error("Queue item disappeared after external delivery");
    }
  }

  async #assertWorkspaceUnchanged(
    item: QueueRecord,
    currentPath: string,
  ): Promise<void> {
    const [queued, current] = await Promise.all([
      this.#authorizeWorkspace(item.workspacePath),
      this.#authorizeWorkspace(currentPath),
    ]);
    if (queued !== current) {
      throw new GatewayV2Error(
        "WORKSPACE_CHANGED",
        "The task workspace changed after this Queue item was created",
      );
    }
  }

  #deliveryEvent(
    item: QueueRecord,
    state: QueueServiceEvents["delivery"]["state"],
  ): void {
    this.events.emit("delivery", {
      itemId: item.id,
      threadId: item.threadId,
      state,
    });
  }
}

function textInput(
  text: string,
): readonly [
  { readonly type: "text"; readonly text: string; readonly text_elements: [] },
] {
  return [{ type: "text", text, text_elements: [] }];
}

function responseTurnId(value: unknown, nested: boolean): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex returned an invalid turn response");
  }
  const record = value as Record<string, unknown>;
  if (
    !nested &&
    typeof record.turnId === "string" &&
    record.turnId.length > 0
  ) {
    return record.turnId;
  }
  if (
    nested &&
    typeof record.turn === "object" &&
    record.turn !== null &&
    !Array.isArray(record.turn) &&
    typeof (record.turn as Record<string, unknown>).id === "string"
  ) {
    return (record.turn as { id: string }).id;
  }
  throw new Error("Codex returned no turn ID");
}

function queueUnavailable(itemId: string): GatewayV2Error {
  return new GatewayV2Error(
    "QUEUE_STATE_CONFLICT",
    "Queue item is missing or no longer eligible",
    {
      details: {
        issues: [
          { path: ["itemId"], code: itemId.length > 0 ? "stale" : "invalid" },
        ],
      },
    },
  );
}
