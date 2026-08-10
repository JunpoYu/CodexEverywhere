import type { Turn } from "@codex-everywhere/codex-app-server-schema/v2";

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

export type ComposerReconciliationAction = "retry" | "wait" | "fail";

/**
 * Retry in the original Host idempotency scope only after a complete snapshot
 * misses the operation. A transient read failure schedules another snapshot
 * instead of either duplicating the mutation or locking reconciliation to the
 * first attempt. After reauthentication changes the scope, snapshots are the
 * only safe signal and polling stops after a bounded number of misses.
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
