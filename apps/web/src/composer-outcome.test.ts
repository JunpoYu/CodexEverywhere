import type { Turn } from "@codex-everywhere/codex-app-server-schema/v2";
import { describe, expect, it, vi } from "vitest";

import {
  ComposerTurnSnapshotReader,
  LEGACY_HISTORY_MAX_ATTEMPTS,
  LEGACY_HISTORY_MAX_RETRY_MS,
  LEGACY_HISTORY_RETRY_BASE_MS,
  MAX_COMPOSER_AUTHORITATIVE_MISSES,
  MIN_COMPOSER_RECONCILIATION_MS,
  OUTCOME_RECONCILIATION_TURN_LIMIT,
  composerOperationOutcome,
  composerReconciliationAction,
  composerTurnSnapshotCoversOperation,
} from "./composer-outcome.js";

function turn(
  id: string,
  clientId: string | null,
  status: Turn["status"] = "inProgress",
): Turn {
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
    status,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1,
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

  it("reads only a bounded descending recent-turn page for reconciliation", async () => {
    const request = vi.fn(async () => ({
      data: [turn("newest", "operation-5")],
      nextCursor: "older",
      backwardsCursor: null,
    }));
    const reader = new ComposerTurnSnapshotReader();

    await expect(
      reader.read({ request }, "thread-1", ["operation-5"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toMatchObject({
      turns: [{ id: "newest" }],
      authoritative: false,
      negativeEvidenceAllowed: true,
    });
    expect(request).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "thread-1",
      limit: OUTCOME_RECONCILIATION_TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "full",
    });
    expect(request).not.toHaveBeenCalledWith("thread/read", expect.anything());
  });

  it("treats a bounded page as authoritative for an operation when it reaches the pre-send boundary", () => {
    const turns = [turn("newer", null), turn("boundary", null)];

    expect(
      composerTurnSnapshotCoversOperation({
        turns,
        complete: false,
        boundaryTurnId: "boundary",
        negativeEvidenceAllowed: true,
      }),
    ).toBe(true);
    expect(
      composerReconciliationAction({
        operationKind: "turn",
        sameDevice: true,
        turnsAvailable: true,
        queueAvailable: false,
        authoritativeMisses: 1,
        reconciliationAgeMs: 1_500,
      }),
    ).toBe("retry");
  });

  it("waits when newer turns pushed the pre-send boundary outside the bounded page", () => {
    expect(
      composerTurnSnapshotCoversOperation({
        turns: [turn("newest", null), turn("still-newer", null)],
        complete: false,
        boundaryTurnId: "boundary",
        negativeEvidenceAllowed: true,
      }),
    ).toBe(false);
    expect(
      composerReconciliationAction({
        operationKind: "turn",
        sameDevice: true,
        turnsAvailable: false,
        queueAvailable: false,
        authoritativeMisses: 0,
        reconciliationAgeMs: 1_500,
      }),
    ).toBe("wait");
  });

  it("confirms an operation from a bounded page even when the pre-send boundary is absent", () => {
    expect(
      composerOperationOutcome(
        "turn",
        "operation-bounded",
        [turn("newest", "operation-bounded")],
        [],
      ),
    ).toEqual({
      kind: "turn",
      turnId: "newest",
      turnStatus: "inProgress",
    });
  });

  it("does not infer a negative result for a new empty thread from a partial page", () => {
    expect(
      composerTurnSnapshotCoversOperation({
        turns: [],
        complete: false,
        boundaryTurnId: undefined,
        negativeEvidenceAllowed: true,
      }),
    ).toBe(false);
  });

  it("requires a fresh legacy read before combining a later Queue snapshot with turn evidence", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({
        thread: { turns: [turn("before-dispatch", null)] },
      })
      .mockResolvedValueOnce({
        thread: {
          turns: [turn("dispatched", "queued-operation", "completed")],
        },
      });
    const reader = new ComposerTurnSnapshotReader();
    const client = { request };

    const first = await reader.read(client, "thread-1", ["queued-operation"], {
      legacyNegativeEvidenceAllowed: false,
    });
    expect(first).toMatchObject({
      turns: [{ id: "before-dispatch" }],
      authoritative: false,
      negativeEvidenceAllowed: false,
    });
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: first.authoritative,
        queueAvailable: false,
        authoritativeMisses: 0,
        reconciliationAgeMs: 1_500,
      }),
    ).toBe("wait");

    const fresh = await reader.read(client, "thread-1", ["queued-operation"], {
      legacyNegativeEvidenceAllowed: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(fresh.authoritative).toBe(true);
    expect(fresh.negativeEvidenceAllowed).toBe(true);
    expect(
      composerOperationOutcome(
        "queue",
        "queued-operation",
        fresh.turns ?? [],
        [],
      ),
    ).toEqual({
      kind: "turn",
      turnId: "dispatched",
      turnStatus: "completed",
    });
  });

  it("allows same-key Queue retry only after a same-round fresh legacy miss", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({ thread: { turns: [turn("old", null)] } })
      .mockResolvedValueOnce({ thread: { turns: [turn("still-old", null)] } });
    const reader = new ComposerTurnSnapshotReader();
    const client = { request };

    const first = await reader.read(client, "thread-1", ["queue-miss"], {
      legacyNegativeEvidenceAllowed: false,
    });
    expect(first.authoritative).toBe(false);
    expect(first.negativeEvidenceAllowed).toBe(false);
    const fresh = await reader.read(client, "thread-1", ["queue-miss"], {
      legacyNegativeEvidenceAllowed: true,
    });
    expect(fresh.authoritative).toBe(true);
    expect(fresh.negativeEvidenceAllowed).toBe(true);
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: fresh.authoritative,
        queueAvailable: true,
        authoritativeMisses: 1,
        reconciliationAgeMs: 3_000,
      }),
    ).toBe("retry");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry from an open-thread history miss that predates the Queue snapshot", () => {
    const staleOpenThreadPass = composerReconciliationAction({
      operationKind: "queue",
      sameDevice: true,
      turnsAvailable: false,
      queueAvailable: true,
      authoritativeMisses: 0,
      reconciliationAgeMs: 3_000,
    });
    const freshQueueFirstPass = composerReconciliationAction({
      operationKind: "queue",
      sameDevice: true,
      turnsAvailable: true,
      queueAvailable: true,
      authoritativeMisses: 1,
      reconciliationAgeMs: 4_000,
    });

    expect(staleOpenThreadPass).toBe("wait");
    expect(freshQueueFirstPass).toBe("retry");
  });

  it("keeps a cached legacy boundary positive-only until a fresh Queue-first read succeeds", async () => {
    let now = 1_000;
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({
        thread: { turns: [turn("cached-boundary", null)] },
      })
      .mockRejectedValueOnce(new Error("thread/read deadline exceeded"))
      .mockResolvedValueOnce({
        thread: { turns: [turn("fresh-unrelated", null)] },
      });
    const reader = new ComposerTurnSnapshotReader({ now: () => now });
    const client = { request };

    await reader.read(client, "thread-1", ["queue-stale-boundary"], {
      legacyNegativeEvidenceAllowed: false,
    });
    const failedFresh = await reader.read(
      client,
      "thread-1",
      ["queue-stale-boundary"],
      { legacyNegativeEvidenceAllowed: true },
    );
    const cachedTurnsCoverOperation = composerTurnSnapshotCoversOperation({
      turns: failedFresh.turns,
      complete: failedFresh.authoritative,
      boundaryTurnId: "cached-boundary",
      negativeEvidenceAllowed: failedFresh.negativeEvidenceAllowed,
    });
    expect(failedFresh).toMatchObject({
      turns: [{ id: "cached-boundary" }],
      authoritative: false,
      negativeEvidenceAllowed: false,
    });
    expect(cachedTurnsCoverOperation).toBe(false);
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: cachedTurnsCoverOperation,
        queueAvailable: true,
        authoritativeMisses: 0,
        reconciliationAgeMs: 3_000,
      }),
    ).toBe("wait");

    const backoff = await reader.read(
      client,
      "thread-1",
      ["queue-stale-boundary"],
      { legacyNegativeEvidenceAllowed: true },
    );
    expect(backoff.negativeEvidenceAllowed).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);

    now += LEGACY_HISTORY_RETRY_BASE_MS * 2;
    const fresh = await reader.read(
      client,
      "thread-1",
      ["queue-stale-boundary"],
      { legacyNegativeEvidenceAllowed: true },
    );
    const freshTurnsCoverOperation = composerTurnSnapshotCoversOperation({
      turns: fresh.turns,
      complete: fresh.authoritative,
      boundaryTurnId: "cached-boundary",
      negativeEvidenceAllowed: fresh.negativeEvidenceAllowed,
    });
    expect(fresh).toMatchObject({
      turns: [{ id: "fresh-unrelated" }],
      authoritative: true,
      negativeEvidenceAllowed: true,
    });
    expect(freshTurnsCoverOperation).toBe(true);
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: freshTurnsCoverOperation,
        queueAvailable: true,
        authoritativeMisses: 1,
        reconciliationAgeMs: 7_000,
      }),
    ).toBe("retry");
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("keeps cached legacy turns positive-only after fresh failures and becomes manual at the limit", async () => {
    let now = 1_000;
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({ thread: { turns: [turn("cached-old", null)] } })
      .mockRejectedValue(new Error("thread/read deadline exceeded"));
    const reader = new ComposerTurnSnapshotReader({ now: () => now });
    const client = { request };

    await reader.read(client, "thread-1", ["queue-timeout"], {
      legacyNegativeEvidenceAllowed: false,
    });
    const failedFresh = await reader.read(
      client,
      "thread-1",
      ["queue-timeout"],
      { legacyNegativeEvidenceAllowed: true },
    );
    expect(failedFresh).toMatchObject({
      turns: [{ id: "cached-old" }],
      authoritative: false,
      negativeEvidenceAllowed: false,
      manualReviewRequired: false,
    });
    expect(
      composerReconciliationAction({
        operationKind: "queue",
        sameDevice: true,
        turnsAvailable: failedFresh.authoritative,
        queueAvailable: true,
        authoritativeMisses: 0,
        reconciliationAgeMs: 3_000,
      }),
    ).toBe("wait");

    await reader.read(client, "thread-1", ["queue-timeout"], {
      legacyNegativeEvidenceAllowed: true,
    });
    expect(request).toHaveBeenCalledTimes(3);
    now += LEGACY_HISTORY_RETRY_BASE_MS * 2;
    await expect(
      reader.read(client, "thread-1", ["queue-timeout"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toMatchObject({
      turns: [{ id: "cached-old" }],
      authoritative: false,
      negativeEvidenceAllowed: false,
      manualReviewRequired: true,
    });
    expect(request).toHaveBeenCalledTimes(1 + LEGACY_HISTORY_MAX_ATTEMPTS);
  });

  it("retries a failed legacy read with bounded backoff before requiring manual review", async () => {
    let now = 1_000;
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockRejectedValue(new Error("thread/read deadline exceeded"));
    const reader = new ComposerTurnSnapshotReader({ now: () => now });
    const client = { request };

    await expect(
      reader.read(client, "thread-1", ["operation-timeout"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toMatchObject({ manualReviewRequired: false });
    await reader.read(client, "thread-1", ["operation-timeout"], {
      legacyNegativeEvidenceAllowed: true,
    });
    expect(request).toHaveBeenCalledTimes(2);

    for (let attempt = 1; attempt < LEGACY_HISTORY_MAX_ATTEMPTS; attempt += 1) {
      now += LEGACY_HISTORY_RETRY_BASE_MS * 2 ** (attempt - 1);
      const snapshot = await reader.read(
        client,
        "thread-1",
        ["operation-timeout"],
        { legacyNegativeEvidenceAllowed: true },
      );
      expect(snapshot.manualReviewRequired).toBe(
        attempt === LEGACY_HISTORY_MAX_ATTEMPTS - 1,
      );
    }
    expect(request).toHaveBeenCalledTimes(1 + LEGACY_HISTORY_MAX_ATTEMPTS);
    await reader.read(client, "thread-1", ["operation-timeout"], {
      legacyNegativeEvidenceAllowed: true,
    });
    expect(request).toHaveBeenCalledTimes(1 + LEGACY_HISTORY_MAX_ATTEMPTS);
  });

  it("bounds legacy fallback by elapsed time even before attempts are exhausted", async () => {
    let now = 1_000;
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockRejectedValue(new Error("thread/read deadline exceeded"));
    const reader = new ComposerTurnSnapshotReader({ now: () => now });
    const client = { request };

    await reader.read(client, "thread-1", ["operation-time-budget"], {
      legacyNegativeEvidenceAllowed: true,
    });
    now += LEGACY_HISTORY_MAX_RETRY_MS;
    await expect(
      reader.read(client, "thread-1", ["operation-time-budget"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toMatchObject({ manualReviewRequired: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not carry a legacy pagination decision to another Host client", async () => {
    const legacyRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({ thread: { turns: [] } });
    const pagedRequest = vi.fn(async () => ({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    }));
    const reader = new ComposerTurnSnapshotReader();

    await reader.read(
      { request: legacyRequest },
      "thread-1",
      ["legacy-operation"],
      { legacyNegativeEvidenceAllowed: true },
    );
    await expect(
      reader.read({ request: pagedRequest }, "thread-2", ["paged-operation"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toEqual({
      turns: [],
      authoritative: true,
      negativeEvidenceAllowed: true,
    });
    expect(pagedRequest).toHaveBeenCalledWith("thread/turns/list", {
      threadId: "thread-2",
      limit: OUTCOME_RECONCILIATION_TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "full",
    });
  });

  it("isolates a cached legacy operation snapshot between Host clients", async () => {
    const firstRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({ thread: { turns: [turn("first-host", null)] } });
    const secondRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Unsupported gateway method: thread/turns/list"),
      )
      .mockResolvedValueOnce({
        thread: { turns: [turn("second-host", null)] },
      });
    const reader = new ComposerTurnSnapshotReader();

    await expect(
      reader.read({ request: firstRequest }, "thread-1", ["same-operation"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toMatchObject({ turns: [{ id: "first-host" }] });
    await expect(
      reader.read({ request: secondRequest }, "thread-1", ["same-operation"], {
        legacyNegativeEvidenceAllowed: true,
      }),
    ).resolves.toMatchObject({ turns: [{ id: "second-host" }] });
    expect(firstRequest).toHaveBeenCalledTimes(2);
    expect(secondRequest).toHaveBeenCalledTimes(2);
  });
});
