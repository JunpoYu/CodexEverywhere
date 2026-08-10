import type {
  ThreadReadResponse,
  Turn,
  TurnsPage,
} from "@codex-everywhere/codex-app-server-schema/v2";

import { isTurnsPaginationUnsupported } from "./thread-history.js";

export type ComposerOperationKind = "turn" | "queue";

export type QueueSnapshotItem = {
  id: string;
  turnPayload: Record<string, unknown>;
};

export type ComposerOperationOutcome =
  | { kind: "turn"; turnId: string; turnStatus: Turn["status"] }
  | { kind: "queue"; queueId: string };

export const MAX_COMPOSER_AUTHORITATIVE_MISSES = 8;
export const MIN_COMPOSER_RECONCILIATION_MS = 60_000;
export const OUTCOME_RECONCILIATION_TURN_LIMIT = 20;
export const LEGACY_HISTORY_MAX_ATTEMPTS = 3;
export const LEGACY_HISTORY_MAX_RETRY_MS = 30_000;
export const LEGACY_HISTORY_RETRY_BASE_MS = 2_000;

export type ComposerSnapshotClient = {
  request(method: string, payload: unknown): Promise<unknown>;
};

type LegacySnapshotState = {
  threadId: string;
  attempts: number;
  firstAttemptAt: number;
  nextAttemptAt: number;
  manualReviewRequired: boolean;
  cachedTurns?: Turn[];
};

type ComposerTurnSnapshot = {
  turns: Turn[] | undefined;
  authoritative: boolean;
  negativeEvidenceAllowed: boolean;
  manualReviewRequired?: boolean;
};

/**
 * Reads only the newest turns while pagination is available. An older
 * app-server gets a bounded compatibility read with per-client/per-operation
 * state. A successful full snapshot remains in page memory until the
 * operation is forgotten, but cached turns are positive evidence only. A
 * Queue miss becomes authoritative only when its Queue snapshot and a fresh
 * full-history read both succeed in the same reconciliation pass. Failed
 * reads use bounded backoff and eventually require explicit review; they
 * never authorize an automatic mutation replay.
 */
export class ComposerTurnSnapshotReader {
  readonly #pagination = new WeakMap<
    ComposerSnapshotClient,
    "supported" | "legacy"
  >();
  readonly #legacyStates = new Map<
    string,
    WeakMap<ComposerSnapshotClient, LegacySnapshotState>
  >();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  async read(
    client: ComposerSnapshotClient,
    threadId: string,
    operationIds: string[],
    options: { legacyNegativeEvidenceAllowed: boolean },
  ): Promise<ComposerTurnSnapshot> {
    if (this.#pagination.get(client) !== "legacy") {
      try {
        const page = (await client.request("thread/turns/list", {
          threadId,
          limit: OUTCOME_RECONCILIATION_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
        })) as TurnsPage;
        this.#pagination.set(client, "supported");
        return {
          turns: page.data,
          authoritative: page.nextCursor == null,
          negativeEvidenceAllowed: true,
        };
      } catch (error) {
        if (!isTurnsPaginationUnsupported(error)) throw error;
        this.#pagination.set(client, "legacy");
      }
    }

    const states = operationIds.map((operationId) => ({
      operationId,
      state: this.#legacyStates.get(operationId)?.get(client),
    }));
    const cachedTurns = states.find(
      ({ state }) => state?.cachedTurns !== undefined,
    )?.state?.cachedTurns;
    if (
      states.some(
        ({ state }) => state !== undefined && state.threadId !== threadId,
      )
    ) {
      return {
        turns: cachedTurns,
        authoritative: false,
        negativeEvidenceAllowed: false,
        manualReviewRequired: true,
      };
    }
    if (states.some(({ state }) => state?.manualReviewRequired)) {
      return {
        turns: cachedTurns,
        authoritative: false,
        negativeEvidenceAllowed: false,
        manualReviewRequired: true,
      };
    }

    const now = this.#now();
    const expired = states.filter(
      ({ state }) =>
        state !== undefined &&
        now - state.firstAttemptAt >= LEGACY_HISTORY_MAX_RETRY_MS,
    );
    if (expired.length > 0) {
      for (const { operationId, state } of expired) {
        this.#setLegacyState(operationId, client, {
          ...state!,
          manualReviewRequired: true,
        });
      }
      return {
        turns: cachedTurns,
        authoritative: false,
        negativeEvidenceAllowed: false,
        manualReviewRequired: true,
      };
    }
    if (
      states.some(
        ({ state }) => state !== undefined && now < state.nextAttemptAt,
      )
    ) {
      return {
        turns: cachedTurns,
        authoritative: false,
        negativeEvidenceAllowed: false,
        manualReviewRequired: false,
      };
    }
    const exhausted = states.filter(
      ({ state }) =>
        state !== undefined && state.attempts >= LEGACY_HISTORY_MAX_ATTEMPTS,
    );
    if (exhausted.length > 0) {
      for (const { operationId, state } of exhausted) {
        this.#setLegacyState(operationId, client, {
          ...state!,
          manualReviewRequired: true,
        });
      }
      return {
        turns: cachedTurns,
        authoritative: false,
        negativeEvidenceAllowed: false,
        manualReviewRequired: true,
      };
    }

    const attempted = states.map(({ operationId, state }) => {
      const next: LegacySnapshotState = {
        threadId,
        attempts: (state?.attempts ?? 0) + 1,
        firstAttemptAt: state?.firstAttemptAt ?? now,
        nextAttemptAt: Number.POSITIVE_INFINITY,
        manualReviewRequired: false,
        ...(state?.cachedTurns !== undefined
          ? { cachedTurns: state.cachedTurns }
          : {}),
      };
      this.#setLegacyState(operationId, client, next);
      return { operationId, state: next };
    });

    try {
      const detail = (await client.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as ThreadReadResponse;
      const completedAt = this.#now();
      const authoritative = options.legacyNegativeEvidenceAllowed;
      let manualReviewRequired = false;
      for (const { operationId, state } of attempted) {
        const stateExhausted =
          !authoritative &&
          (state.attempts >= LEGACY_HISTORY_MAX_ATTEMPTS ||
            completedAt - state.firstAttemptAt >= LEGACY_HISTORY_MAX_RETRY_MS);
        manualReviewRequired ||= stateExhausted;
        this.#setLegacyState(operationId, client, {
          ...state,
          nextAttemptAt: completedAt,
          manualReviewRequired: stateExhausted,
          cachedTurns: detail.thread.turns,
        });
      }
      return {
        turns: detail.thread.turns,
        authoritative,
        negativeEvidenceAllowed: authoritative,
        ...(manualReviewRequired ? { manualReviewRequired: true } : {}),
      };
    } catch {
      const failedAt = this.#now();
      let manualReviewRequired = false;
      for (const { operationId, state } of attempted) {
        const stateExhausted =
          state.attempts >= LEGACY_HISTORY_MAX_ATTEMPTS ||
          failedAt - state.firstAttemptAt >= LEGACY_HISTORY_MAX_RETRY_MS;
        manualReviewRequired ||= stateExhausted;
        this.#setLegacyState(operationId, client, {
          ...state,
          manualReviewRequired: stateExhausted,
          nextAttemptAt:
            failedAt + LEGACY_HISTORY_RETRY_BASE_MS * 2 ** (state.attempts - 1),
        });
      }
      return {
        turns: cachedTurns,
        authoritative: false,
        negativeEvidenceAllowed: false,
        manualReviewRequired,
      };
    }
  }

  forget(operationId: string): void {
    this.#legacyStates.delete(operationId);
  }

  #setLegacyState(
    operationId: string,
    client: ComposerSnapshotClient,
    state: LegacySnapshotState,
  ): void {
    let clients = this.#legacyStates.get(operationId);
    if (!clients) {
      clients = new WeakMap();
      this.#legacyStates.set(operationId, clients);
    }
    clients.set(client, state);
  }
}

export type ComposerReconciliationAction = "retry" | "wait" | "fail";

/**
 * A complete history can prove an operation is absent. A bounded newest-turn
 * page can make the same proof only when it reaches the newest turn observed
 * immediately before the mutation was sent. That boundary demonstrates that
 * the page covers the whole interval in which the operation could have been
 * accepted, without relying on clocks or inspecting private prompt text.
 */
export function composerTurnSnapshotCoversOperation(options: {
  turns: Turn[] | undefined;
  complete: boolean;
  boundaryTurnId: string | undefined;
  negativeEvidenceAllowed: boolean;
}): boolean {
  if (!options.negativeEvidenceAllowed) return false;
  if (options.turns === undefined) return false;
  if (options.complete) return true;
  return (
    options.boundaryTurnId !== undefined &&
    options.turns.some((turn) => turn.id === options.boundaryTurnId)
  );
}

/**
 * Retry in the original Host idempotency scope only after an authoritative
 * snapshot misses the operation. A transient read failure schedules another
 * snapshot instead of either duplicating the mutation or locking
 * reconciliation to the first attempt. After reauthentication changes the
 * scope, snapshots are the only safe signal and polling stops after a bounded
 * number of misses.
 */
export function composerReconciliationAction(options: {
  operationKind: ComposerOperationKind;
  sameDevice: boolean;
  turnsAvailable: boolean;
  queueAvailable: boolean;
  authoritativeMisses: number;
  reconciliationAgeMs: number;
}): ComposerReconciliationAction {
  const authoritative =
    options.turnsAvailable &&
    (options.operationKind === "turn" || options.queueAvailable);
  if (!authoritative) return "wait";
  if (options.sameDevice) return "retry";
  return options.authoritativeMisses >= MAX_COMPOSER_AUTHORITATIVE_MISSES &&
    options.reconciliationAgeMs >= MIN_COMPOSER_RECONCILIATION_MS
    ? "fail"
    : "wait";
}

/**
 * Reconciles an ambiguous composer mutation against authoritative Host/Codex
 * snapshots. The same operation id is sent as clientUserMessageId for both
 * direct turns and queued turns, so a lost transport response never requires
 * matching private prompt text.
 */
export function composerOperationOutcome(
  operationKind: ComposerOperationKind,
  operationId: string,
  turns: Turn[],
  queueItems: QueueSnapshotItem[],
): ComposerOperationOutcome | undefined {
  for (const turn of turns) {
    if (
      turn.items.some(
        (item: Turn["items"][number]) =>
          item.type === "userMessage" && item.clientId === operationId,
      )
    ) {
      return { kind: "turn", turnId: turn.id, turnStatus: turn.status };
    }
  }
  if (operationKind === "queue") {
    const queued = queueItems.find(
      (item) => item.turnPayload.clientUserMessageId === operationId,
    );
    if (queued) return { kind: "queue", queueId: queued.id };
  }
  return undefined;
}
