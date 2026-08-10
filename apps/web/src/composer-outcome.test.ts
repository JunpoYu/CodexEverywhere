import type { Turn } from "@codex-everywhere/codex-app-server-schema/v2";
import { describe, expect, it } from "vitest";

import {
  MAX_COMPOSER_AUTHORITATIVE_MISSES,
  MIN_COMPOSER_RECONCILIATION_MS,
  composerOperationOutcome,
  composerReconciliationAction,
} from "./composer-outcome.js";

function turn(id: string, clientId: string | null): Turn {
  return {
    id,
    items: [
      {
        type: "userMessage",
        id: `message-${id}`,
        clientId,
        content: [{ type: "text", text: "private text", text_elements: [] }],
      },
    ],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

describe("composer mutation reconciliation", () => {
  it("confirms an ambiguous turn by clientUserMessageId without comparing prompt text", () => {
    expect(
      composerOperationOutcome(
        "turn",
        "operation-1",
        [turn("turn-1", "operation-1")],
        [],
      ),
    ).toEqual({
      kind: "turn",
      turnId: "turn-1",
      turnStatus: "inProgress",
    });
  });

  it("confirms an ambiguous queued message from the Host queue snapshot", () => {
    expect(
      composerOperationOutcome(
        "queue",
        "operation-2",
        [],
        [
          {
            id: "queue-1",
            turnPayload: { clientUserMessageId: "operation-2" },
          },
        ],
      ),
    ).toEqual({ kind: "queue", queueId: "queue-1" });
  });

  it("recognizes a queue item that was already dispatched into a Codex turn", () => {
    expect(
      composerOperationOutcome(
        "queue",
        "operation-3",
        [turn("turn-3", "operation-3")],
        [],
      ),
    ).toEqual({
      kind: "turn",
      turnId: "turn-3",
      turnStatus: "inProgress",
    });
  });

  it("leaves an absent operation unresolved instead of declaring failure", () => {
    expect(
      composerOperationOutcome("turn", "operation-4", [], []),
    ).toBeUndefined();
  });

  it("retries safely after a transient queue snapshot failure is followed by a complete snapshot", () => {
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: true,
        queueAvailable: false,
        authoritativeMisses: 0,
        reconciliationAgeMs: 0,
      }),
    ).toBe("wait");
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: true,
        queueAvailable: true,
        authoritativeMisses: 1,
        reconciliationAgeMs: 1_500,
      }),
    ).toBe("retry");
  });

  it("bounds snapshot-only reconciliation after device scope changes", () => {
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: false,
        turnsAvailable: true,
        queueAvailable: true,
        authoritativeMisses: MAX_COMPOSER_AUTHORITATIVE_MISSES - 1,
        reconciliationAgeMs: MIN_COMPOSER_RECONCILIATION_MS,
      }),
    ).toBe("wait");
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: false,
        turnsAvailable: true,
        queueAvailable: true,
        authoritativeMisses: MAX_COMPOSER_AUTHORITATIVE_MISSES,
        reconciliationAgeMs: MIN_COMPOSER_RECONCILIATION_MS - 1,
      }),
    ).toBe("wait");
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: false,
        turnsAvailable: true,
        queueAvailable: true,
        authoritativeMisses: MAX_COMPOSER_AUTHORITATIVE_MISSES,
        reconciliationAgeMs: MIN_COMPOSER_RECONCILIATION_MS,
      }),
    ).toBe("fail");
  });
});
