import {
  type QueueConsumptionIdentity,
  type QueueConsumptionOperation,
  type QueueItem,
  QueueRegistry,
  queueConsumptionIdentity,
} from "../host/queue.js";

const DEFAULT_REPAIR_INITIAL_DELAY_MS = 250;
const DEFAULT_REPAIR_MAX_DELAY_MS = 30_000;

type PendingRepair = {
  identity: QueueConsumptionIdentity;
  crossedConsumptionBoundary: boolean;
  attempt: number;
  dueAt: number;
};

export class QueueConsumptionRepairer {
  readonly #queue: QueueRegistry;
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #pending = new Map<string, PendingRepair>();
  readonly #listeners = new Set<(identity: QueueConsumptionIdentity) => void>();
  readonly #pausedListeners = new Set<
    (identity: QueueConsumptionIdentity) => void
  >();
  readonly #foreground = new Set<Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  constructor(
    queue: QueueRegistry,
    options: { initialDelayMs?: number; maxDelayMs?: number } = {},
  ) {
    this.#queue = queue;
    this.#initialDelayMs =
      options.initialDelayMs ?? DEFAULT_REPAIR_INITIAL_DELAY_MS;
    this.#maxDelayMs = options.maxDelayMs ?? DEFAULT_REPAIR_MAX_DELAY_MS;
    if (!Number.isFinite(this.#initialDelayMs) || this.#initialDelayMs < 1) {
      throw new Error("Queue repair initial delay must be at least 1ms");
    }
    if (
      !Number.isFinite(this.#maxDelayMs) ||
      this.#maxDelayMs < this.#initialDelayMs
    ) {
      throw new Error(
        "Queue repair maximum delay must be at least the initial delay",
      );
    }
  }

  onIndeterminate(
    listener: (identity: QueueConsumptionIdentity) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onPaused(listener: (identity: QueueConsumptionIdentity) => void): () => void {
    this.#pausedListeners.add(listener);
    return () => this.#pausedListeners.delete(listener);
  }

  repairNow(
    identity: QueueConsumptionIdentity,
    crossedConsumptionBoundary: boolean,
  ): Promise<
    Awaited<ReturnType<QueueRegistry["repairConsumptionIndeterminate"]>>
  > {
    if (this.#closed) {
      return Promise.reject(new Error("Queue consumption repairer is closed"));
    }
    const repair = crossedConsumptionBoundary
      ? this.#queue.ensureConsumptionIndeterminate(identity)
      : this.#queue.repairConsumptionIndeterminate(identity);
    this.#foreground.add(repair);
    void repair
      .finally(() => this.#foreground.delete(repair))
      .catch(() => {
        // The returned promise preserves the original failure for the caller.
      });
    return repair;
  }

  schedule(
    identity: QueueConsumptionIdentity,
    crossedConsumptionBoundary: boolean,
  ): void {
    if (this.#closed) return;
    const existing = this.#pending.get(identity.queueItemId);
    if (existing) {
      // A proven crossed boundary always wins over an earlier ambiguous
      // pre-claim failure for the same durable queue item.
      existing.crossedConsumptionBoundary ||= crossedConsumptionBoundary;
      return;
    }
    this.#pending.set(identity.queueItemId, {
      identity,
      crossedConsumptionBoundary,
      attempt: 0,
      dueAt: Date.now() + this.#initialDelayMs,
    });
    this.#arm();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending.clear();
    // The state store must remain open until the already-started write has
    // settled. No new attempt can be armed after #closed becomes true.
    await Promise.allSettled([
      ...(this.#running ? [this.#running] : []),
      ...this.#foreground,
    ]);
    this.#listeners.clear();
    this.#pausedListeners.clear();
  }

  #arm(): void {
    if (this.#closed || this.#running || this.#timer || !this.#pending.size) {
      return;
    }
    let dueAt = Number.POSITIVE_INFINITY;
    for (const repair of this.#pending.values()) {
      dueAt = Math.min(dueAt, repair.dueAt);
    }
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#running = this.#runNext().finally(() => {
          this.#running = undefined;
          this.#arm();
        });
      },
      Math.max(0, dueAt - Date.now()),
    );
    this.#timer.unref?.();
  }

  async #runNext(): Promise<void> {
    if (this.#closed) return;
    let next: PendingRepair | undefined;
    for (const repair of this.#pending.values()) {
      if (!next || repair.dueAt < next.dueAt) next = repair;
    }
    if (!next) return;
    const waitMs = next.dueAt - Date.now();
    if (waitMs > 0) return;

    try {
      const result = next.crossedConsumptionBoundary
        ? await this.#queue.ensureConsumptionIndeterminate(next.identity)
        : await this.#queue.repairConsumptionIndeterminate(next.identity);
      if (result === "missing") {
        const recovery = await this.#queue.pauseMissingConsumptionReservation(
          next.identity,
        );
        if (recovery === "claimed") {
          next.crossedConsumptionBoundary = true;
          next.dueAt = Date.now() + this.#initialDelayMs;
          return;
        }
        this.#pending.delete(next.identity.queueItemId);
        if (recovery === "paused" && !this.#closed) {
          for (const listener of this.#pausedListeners) {
            try {
              listener(next.identity);
            } catch {
              // The reservation is already safely paused.
            }
          }
        }
        return;
      }
      this.#pending.delete(next.identity.queueItemId);
      if (result === "indeterminate" && !this.#closed) {
        for (const listener of this.#listeners) {
          try {
            listener(next.identity);
          } catch {
            // Queue state has already converged. Observer failures must not
            // restart or otherwise alter this durable repair.
          }
        }
      }
    } catch {
      if (this.#closed) return;
      next.attempt += 1;
      const delay = Math.min(
        this.#maxDelayMs,
        this.#initialDelayMs * 2 ** Math.min(next.attempt, 30),
      );
      next.dueAt = Date.now() + delay;
    }
  }
}

export class QueueConsumptionOutcomeIndeterminateError extends Error {
  readonly durableOutcome: "indeterminate" | "pending" | "settled";

  constructor(
    operation: QueueConsumptionOperation,
    cause?: unknown,
    durableOutcome: "indeterminate" | "pending" | "settled" = "indeterminate",
  ) {
    super(
      `The queued ${operation} outcome is indeterminate; automatic delivery is disabled`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "QueueConsumptionOutcomeIndeterminateError";
    this.durableOutcome = durableOutcome;
  }
}

/**
 * Crosses the one-way boundary from a removable Host Queue item to an
 * app-server mutation. New Queue rows already carry a physical `done`
 * downgrade barrier; beginConsumption publishes the content-free claim and
 * removes the additive logical state before execute() runs. Current Agents
 * synthesize `delivering` from the claim while old Agents simply hide the
 * item. A verified result is committed on the claim before success is
 * returned. No prompt or payload fingerprint enters the claim or repairer.
 */
export async function consumeQueueItemOnce(options: {
  queue: QueueRegistry;
  repairer: QueueConsumptionRepairer;
  item: QueueItem;
  operation: QueueConsumptionOperation;
  onClaimed?(): void;
  execute(clientUserMessageId: string): Promise<{ turnId: string }>;
}): Promise<{ turnId: string }> {
  const { queue, item, operation, repairer } = options;
  const identity = queueConsumptionIdentity(item, operation);
  let crossedConsumptionBoundary = false;
  try {
    const claim = await queue.beginConsumption(item, operation);
    if (!claim.claimed) {
      throw new Error("Queued message already has a durable consumption claim");
    }
    crossedConsumptionBoundary = true;
    options.onClaimed?.();
    const result = await options.execute(claim.identity.clientUserMessageId);
    if (typeof result.turnId !== "string" || result.turnId === "") {
      throw new Error("Queue consumption returned an unverifiable turn ID");
    }
    await queue.completeConsumption(claim.identity, result.turnId);
    return result;
  } catch (error) {
    let repairResult: Awaited<
      ReturnType<QueueRegistry["repairConsumptionIndeterminate"]>
    >;
    try {
      repairResult = await repairer.repairNow(
        identity,
        crossedConsumptionBoundary,
      );
    } catch {
      // beginConsumption may have published before a late durability error.
      // Retry only the durable outcome mark; execute() is never entered again.
      repairer.schedule(identity, crossedConsumptionBoundary);
      throw new QueueConsumptionOutcomeIndeterminateError(
        operation,
        error,
        "pending",
      );
    }
    if (!crossedConsumptionBoundary && repairResult === "missing") {
      // beginConsumption failed before publishing. Let the caller restore the
      // still-local reservation instead of falsely presenting it as an
      // accepted-but-unknown app-server mutation.
      throw error;
    }
    throw new QueueConsumptionOutcomeIndeterminateError(
      operation,
      error,
      repairResult === "indeterminate" ? "indeterminate" : "settled",
    );
  }
}
