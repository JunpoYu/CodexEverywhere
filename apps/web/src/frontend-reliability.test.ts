import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const adminSource = readFileSync(
  new URL("./admin-main.ts", import.meta.url),
  "utf8",
);
const styleSource = readFileSync(
  new URL("./style.css", import.meta.url),
  "utf8",
);

describe("frontend reliability contracts", () => {
  it("allows the complete stop-and-cold-start window for app-server restarts", () => {
    expect(mainSource).toContain(
      "const APP_SERVER_RESTART_REQUEST_TIMEOUT_MS = 90_000;",
    );
    expect(
      mainSource.match(/APP_SERVER_RESTART_REQUEST_TIMEOUT_MS/gu),
    ).toHaveLength(5);
    const restartRequests = mainSource.match(
      /"setup\/app-server\/restart"[\s\S]{0,160}?timeoutMs:\s*APP_SERVER_RESTART_REQUEST_TIMEOUT_MS/gu,
    );
    expect(restartRequests).toHaveLength(4);
  });

  it("does not open the mobile keyboard merely because history was opened", () => {
    const openThread = mainSource.slice(
      mainSource.indexOf("async function openThread"),
      mainSource.indexOf("async function openNewSession"),
    );
    expect(openThread).not.toContain("messageInput.focus");
  });

  it("does not allow background repair to outrun history pagination", () => {
    const openThread = mainSource.slice(
      mainSource.indexOf("async function openThread"),
      mainSource.indexOf("async function openNewSession"),
    );
    const newThread = mainSource.slice(
      mainSource.indexOf("async function completeStartedTask"),
      mainSource.indexOf("function sessionStartPayload"),
    );
    const threadSync = mainSource.slice(
      mainSource.indexOf("async function syncActiveThread"),
      mainSource.indexOf("async function renderQueuedMessages"),
    );

    expect(
      openThread.indexOf('activeHistoryMode = "initializing"'),
    ).toBeLessThan(openThread.indexOf("setThreadStatus(thread.status)"));
    expect(newThread).toContain('activeHistoryMode = "paged"');
    expect(threadSync).toContain('if (syncStrategy === "skip") return;');
    expect(threadSync).toContain('if (syncStrategy === "initialize")');
    expect(threadSync).toContain(
      "resumeThreadHistory(currentClient, threadId)",
    );
    expect(threadSync).toContain("readThreadRepairSnapshot");
    expect(threadSync).toContain("retainRepairHistoryCursor");
    expect(threadSync).toContain(
      "reconciliationTurns,\n      repair.turnsAuthoritative",
    );
    expect(threadSync).toContain("activeHistoryMode = repair.mode");
  });

  it("finalizes stale streaming cards from completed turns", () => {
    const mainUsesMerge = mainSource.includes("timelineView.mergeRecentTurns");
    const threadViewSource = readFileSync(
      new URL("./thread-view.ts", import.meta.url),
      "utf8",
    );
    const completion = threadViewSource.slice(
      threadViewSource.indexOf('event.type === "codex/turn/completed"'),
      threadViewSource.indexOf("const deltaKinds"),
    );

    expect(mainUsesMerge).toBe(true);
    expect(threadViewSource).toContain("streamingCardReconciliation");
    expect(threadViewSource).toContain(
      'authoritativeTurn.status === "inProgress"',
    );
    expect(completion).toContain("#removeStreamingTurnCards(payload.turn.id)");
    const lifecycle = threadViewSource.slice(
      threadViewSource.indexOf('event.type === "codex/item/started"'),
      threadViewSource.indexOf("const patchUpdate"),
    );
    expect(lifecycle).toContain('event.type === "codex/item/completed"');
    const merge = threadViewSource.slice(
      threadViewSource.indexOf("mergeRecentTurns(turns"),
      threadViewSource.indexOf("reconcileSnapshot("),
    );
    expect(merge.indexOf("#finalizeStreamingCard(card)")).toBeLessThan(
      merge.indexOf("card.remove()"),
    );
    expect(merge).toContain("detachedTransientCards.push(card)");
    expect(threadViewSource).toContain(
      '.timeline-entry.streaming, .timeline-entry[data-finalized-stream="true"]',
    );
  });

  it("does not race the initial resume with its retry timer", () => {
    const openThread = mainSource.slice(
      mainSource.indexOf("async function openThread"),
      mainSource.indexOf("async function openNewSession"),
    );
    const sync = mainSource.slice(
      mainSource.indexOf("async function syncActiveThread"),
      mainSource.indexOf("async function renderQueuedMessages"),
    );

    expect(
      openThread.indexOf("threadHistoryInitializationSequence = sequence"),
    ).toBeLessThan(openThread.indexOf("setThreadStatus(thread.status)"));
    expect(openThread).toContain(
      "if (threadHistoryInitializationSequence === sequence)",
    );
    expect(sync).toContain(
      "threadHistoryInitializationSequence === openThreadSequence",
    );
  });

  it("does not revive an exhausted history cursor and retries failed initialization", () => {
    const openThread = mainSource.slice(
      mainSource.indexOf("async function openThread"),
      mainSource.indexOf("async function openNewSession"),
    );
    const loadOlder = mainSource.slice(
      mainSource.indexOf("async function loadOlderHistory"),
      mainSource.indexOf("async function syncActiveThread"),
    );
    const sync = mainSource.slice(
      mainSource.indexOf("async function syncActiveThread"),
      mainSource.indexOf("async function renderQueuedMessages"),
    );

    expect(openThread).toContain("startThreadSync()");
    expect(loadOlder).toContain(
      "activeHistoryPaginationExhausted = nextCursor === undefined",
    );
    expect(loadOlder.indexOf("timelineView.prependTurns(")).toBeLessThan(
      loadOlder.indexOf("activeHistoryNextCursor = nextCursor"),
    );
    expect(sync).toContain("activeHistoryPaginationExhausted");
    expect(sync).toContain("activeHistoryExhaustedNewestTurnId");
    expect(sync).toContain("repair.displayTurns.some");
    expect(sync).toContain('syncStrategy === "initialize"');
    expect(sync).toContain("resumeThreadHistory(currentClient, threadId)");
    expect(sync).toContain(
      'activeHistoryMode !== "initializing" &&\n      (activeThreadStatus?.type !== "active" ||',
    );
    const status = mainSource.slice(
      mainSource.indexOf("function setThreadStatus"),
      mainSource.indexOf("function updatePendingApprovalState"),
    );
    expect(status).toContain(
      'if (activeHistoryMode === "initializing") startThreadSync()',
    );
    const activity = mainSource.slice(
      mainSource.indexOf("function updateThreadActivity"),
      mainSource.indexOf("function updateTokenUsage"),
    );
    expect(activity).toContain(
      'if (activeHistoryMode === "initializing") startThreadSync()',
    );
  });

  it("keeps finalized stream identity until its authoritative page arrives", () => {
    const threadViewSource = readFileSync(
      new URL("./thread-view.ts", import.meta.url),
      "utf8",
    );
    const prepend = threadViewSource.slice(
      threadViewSource.indexOf("prependTurns(turns"),
      threadViewSource.indexOf("mergeRecentTurns(turns"),
    );
    expect(threadViewSource).toContain('card.dataset.finalizedStream = "true"');
    expect(threadViewSource).not.toContain("delete card.dataset.streamTurnId");
    expect(threadViewSource).toContain("#removeFinalizedStreamAliases");
    expect(prepend).toContain("#removeFinalizedStreamAliases(turn)");
    expect(prepend.indexOf("#removeFinalizedStreamAliases(turn)")).toBeLessThan(
      prepend.indexOf("const anchor = this.#container.querySelector"),
    );
    expect(prepend).toContain(
      "// Alias reconciliation can remove the first content node.",
    );
  });

  it("exposes connection changes to assistive technology and keeps a non-color mobile symbol", () => {
    expect(mainSource).toContain(
      'id="connection-status" class="connection-badge" role="status" aria-live="polite"',
    );
    expect(mainSource).toContain('id="status-symbol"');
    expect(adminSource).toContain(
      'id="admin-connection" class="admin-connection" role="status" aria-live="polite"',
    );
  });

  it("locks login actions synchronously while Passkey verification is pending", () => {
    const action = mainSource.slice(
      mainSource.indexOf("async function runLoginButtonAction"),
      mainSource.indexOf("async function activate"),
    );
    const savedHosts = mainSource.slice(
      mainSource.indexOf("async function renderSavedHosts"),
      mainSource.indexOf("function savedHostDocument"),
    );
    const adminAction = adminSource.slice(
      adminSource.indexOf("async function runButtonAction"),
      adminSource.indexOf("function showSecret"),
    );

    for (const source of [action, adminAction]) {
      expect(source).toContain("if (button.disabled) return");
      expect(source).toContain("button.disabled = true");
      expect(source).toContain('button.setAttribute("aria-busy", "true")');
      expect(source).toContain('button.classList.add("button-pending")');
      expect(source).toContain("finally");
      expect(source).toContain("button.disabled = false");
    }
    expect(savedHosts).toContain('runLoginButtonAction(connect, "正在验证…"');
    expect(styleSource).toContain(".button-pending::before");
    expect(styleSource).toContain("cursor: progress");
  });

  it("marks the administrator channel stale immediately and participates in shared recovery policy", () => {
    expect(adminSource).toContain("next.onConnectionLost");
    expect(adminSource).toContain('window.addEventListener("online"');
    expect(adminSource).toContain(
      'document.addEventListener("visibilitychange"',
    );
    expect(adminSource).toContain("reconnectWithUnlimitedAttempts");
    expect(adminSource).toContain("scheduleAdminConnectionKeepalive");
    expect(adminSource).toContain(
      'setAdminConnectionState("connecting", "正在恢复管理通道…")',
    );
  });

  it("keeps user and administrator clients after a health-check-only deadline", () => {
    const userVerification = mainSource.slice(
      mainSource.indexOf("async function verifyActiveConnection"),
      mainSource.indexOf("async function recoverConnection"),
    );
    const adminVerification = adminSource.slice(
      adminSource.indexOf("async function verifyAdminConnection"),
      adminSource.indexOf("async function recoverAdminConnection"),
    );
    for (const verification of [userVerification, adminVerification]) {
      expect(verification).toContain(
        "shouldRecoverAfterHealthCheckFailure(error)",
      );
      expect(verification).not.toContain("catch {");
    }
  });

  it("requires explicit acknowledgement before abandoning an indeterminate thread creation", () => {
    expect(mainSource).toContain('id="inspect-thread-start-outcome"');
    expect(mainSource).toContain('id="abandon-thread-start-outcome"');
    const abandon = mainSource.slice(
      mainSource.indexOf("function abandonIndeterminateThreadStart"),
      mainSource.indexOf("async function startTask"),
    );
    expect(abandon).toContain("window.confirm");
    expect(abandon).toContain("pendingThreadStartOperation = undefined");
    expect(abandon.indexOf("window.confirm")).toBeLessThan(
      abandon.indexOf("pendingThreadStartOperation = undefined"),
    );
    const recovery = mainSource.slice(
      mainSource.indexOf("async function resumePendingThreadStartOperation"),
      mainSource.indexOf("async function completeStartedTask"),
    );
    expect(recovery).toContain("IDEMPOTENCY_OUTCOME_INDETERMINATE");
    expect(recovery).toContain("operation.manualReviewRequired = true");
    expect(recovery).toContain("renderIndeterminateThreadStart()");
  });

  it("keeps an opaque unresolved thread creation marker across same-tab reloads", () => {
    const openNewSession = mainSource.slice(
      mainSource.indexOf("async function openNewSession"),
      mainSource.indexOf("function renderReasoningEfforts"),
    );
    const startTask = mainSource.slice(
      mainSource.indexOf("async function startTask"),
      mainSource.indexOf("async function resumePendingThreadStartOperation"),
    );
    const recovery = mainSource.slice(
      mainSource.indexOf("async function resumePendingThreadStartOperation"),
      mainSource.indexOf("async function completeStartedTask"),
    );
    const abandon = mainSource.slice(
      mainSource.indexOf("function abandonIndeterminateThreadStart"),
      mainSource.indexOf("async function startTask"),
    );

    expect(mainSource).toContain("hasUnresolvedThreadStartMarker");
    expect(openNewSession).toContain("threadStartManualReviewRequired()");
    expect(startTask).toContain("armUnresolvedThreadStartMarker()");
    expect(recovery).toContain("clearThreadStartSafetyMarker()");
    expect(abandon).toContain("clearThreadStartSafetyMarker()");
    expect(mainSource).toContain('"beforeunload"');
    expect(mainSource).toContain("warnBeforeUnresolvedMutationUnload");
    const beforeUnload = mainSource.slice(
      mainSource.indexOf("function warnBeforeUnresolvedMutationUnload"),
      mainSource.indexOf("function renderIndeterminateThreadStart"),
    );
    expect(beforeUnload).toContain("pendingComposerOperations.size > 0");
    expect(beforeUnload).toContain("inFlightComposerOperations.size > 0");
  });

  it("uses each pending send's pre-send turn boundary for bounded negative reconciliation", () => {
    const createOperation = mainSource.slice(
      mainSource.indexOf("function createPendingComposerOperation"),
      mainSource.indexOf("function pendingQueueItem"),
    );
    const reconcileOperations = mainSource.slice(
      mainSource.indexOf("function reconcilePendingComposerOperations"),
      mainSource.indexOf("async function retryPendingComposerOperation"),
    );
    expect(createOperation).toContain("activeNewestTurnId");
    expect(createOperation).toContain("reconciliationBoundaryTurnId");
    expect(reconcileOperations).toContain(
      "composerTurnSnapshotCoversOperation",
    );
    expect(reconcileOperations).toContain(
      "boundaryTurnId: operation.reconciliationBoundaryTurnId",
    );
    expect(reconcileOperations).toContain(
      "turnsAvailable: turnsCoverOperation",
    );
  });

  it("fails closed into explicit composer review when legacy history cannot be read", () => {
    expect(mainSource).toContain('id="composer-outcome-review"');
    expect(mainSource).toContain('id="inspect-composer-outcome"');
    expect(mainSource).toContain('id="abandon-composer-outcome"');
    const reconciliation = mainSource.slice(
      mainSource.indexOf(
        "async function reconcileAllPendingComposerOperations",
      ),
      mainSource.indexOf("function startThreadSync"),
    );
    const abandon = mainSource.slice(
      mainSource.indexOf("function abandonManualComposerOutcome"),
      mainSource.indexOf("async function retryPendingComposerOperation"),
    );
    expect(reconciliation).toContain("snapshot.manualReviewRequired");
    expect(reconciliation).toContain("markComposerOperationManualReview");
    expect(abandon).toContain("window.confirm");
    expect(abandon).toContain("pendingComposerOperations.delete");
    expect(abandon).not.toContain("messageInput.value = operation.text");
  });

  it("keeps durable turn and Queue outcomes in manual review instead of restoring or deleting", () => {
    const firstTurn = mainSource.slice(
      mainSource.indexOf("async function completeStartedTask"),
      mainSource.indexOf("function setComposerSubmitting"),
    );
    const submission = mainSource.slice(
      mainSource.indexOf("async function submitComposerMessage"),
      mainSource.indexOf("async function sendTurn"),
    );
    const retry = mainSource.slice(
      mainSource.indexOf("async function retryPendingComposerOperation"),
      mainSource.indexOf("function hasAutomaticComposerReconciliation"),
    );
    const indeterminate = mainSource.slice(
      mainSource.indexOf("function markComposerOperationIndeterminate"),
      mainSource.indexOf("function renderPendingComposerOperation"),
    );

    expect(firstTurn).toContain("isGatewayMutationOutcomeIndeterminate");
    expect(firstTurn).toContain("markComposerOperationIndeterminate");
    expect(
      firstTurn.indexOf("markComposerOperationIndeterminate"),
    ).toBeLessThan(
      firstTurn.indexOf('await taskClient.request("thread/delete"'),
    );
    expect(submission).toContain("isGatewayMutationOutcomeIndeterminate");
    expect(submission).toContain("markComposerOperationIndeterminate");
    expect(retry).toContain("isGatewayMutationOutcomeIndeterminate");
    expect(retry).toContain("markComposerOperationIndeterminate");
    expect(indeterminate).toContain("pendingComposerOperations.set");
    expect(indeterminate).toContain("operation.manualReviewRequired = true");
    expect(indeterminate).not.toContain("messageInput.value = operation.text");
    expect(indeterminate).not.toContain("thread/delete");
  });

  it("registers every composer mutation before the request can cross a reload boundary", () => {
    const firstTurn = mainSource.slice(
      mainSource.indexOf("async function completeStartedTask"),
      mainSource.indexOf("function setComposerSubmitting"),
    );
    const submission = mainSource.slice(
      mainSource.indexOf("async function submitComposerMessage"),
      mainSource.indexOf("async function sendTurn"),
    );
    expect(firstTurn.indexOf("beginComposerOperationRequest")).toBeLessThan(
      firstTurn.indexOf('"turn/start"'),
    );
    expect(submission.indexOf("beginComposerOperationRequest")).toBeLessThan(
      submission.indexOf('"queue/add"'),
    );
    expect(submission.indexOf("beginComposerOperationRequest")).toBeLessThan(
      submission.indexOf("await sendTurn"),
    );
    expect(mainSource).toContain(
      "inFlightComposerOperations.add(operation.operationId)",
    );
    expect(mainSource).toContain(
      "inFlightComposerOperations.delete(operation.operationId)",
    );
    for (const caller of [firstTurn, submission]) {
      expect(caller).toContain("finally");
      expect(caller).toContain("completeComposerOperationRequest");
      expect(caller.indexOf("markComposerOperationIndeterminate")).toBeLessThan(
        caller.lastIndexOf("finally"),
      );
      expect(caller.indexOf("markComposerOperationUnknown")).toBeLessThan(
        caller.lastIndexOf("finally"),
      );
      expect(caller.lastIndexOf("finally")).toBeLessThan(
        caller.lastIndexOf("completeComposerOperationRequest"),
      );
    }
  });

  it("uses only a same-pass fresh legacy read as Queue negative evidence", () => {
    const openThread = mainSource.slice(
      mainSource.indexOf("async function openThread"),
      mainSource.indexOf("async function openNewSession"),
    );
    const manualInspection = mainSource.slice(
      mainSource.indexOf("async function inspectManualComposerOutcome"),
      mainSource.indexOf("function abandonManualComposerOutcome"),
    );
    const reconciliation = mainSource.slice(
      mainSource.indexOf(
        "async function reconcileAllPendingComposerOperations",
      ),
      mainSource.indexOf("function startThreadSync"),
    );
    const threadSync = mainSource.slice(
      mainSource.indexOf("async function syncActiveThread"),
      mainSource.indexOf("async function renderQueuedMessages"),
    );
    const reconcileOperation = mainSource.slice(
      mainSource.indexOf("function reconcilePendingComposerOperations"),
      mainSource.indexOf("function manualComposerOperationForActiveThread"),
    );

    expect(openThread.indexOf("resumeThreadHistory")).toBeLessThan(
      openThread.indexOf("renderQueuedMessages"),
    );
    expect(openThread).toContain("negativeEvidenceAllowed: false");
    expect(manualInspection.indexOf('"thread/read"')).toBeLessThan(
      manualInspection.indexOf('"queue/list"'),
    );
    expect(manualInspection).toContain("negativeEvidenceAllowed: false");
    expect(reconciliation).toContain("legacyNegativeEvidenceAllowed");
    expect(reconciliation.indexOf('"queue/list"')).toBeLessThan(
      reconciliation.indexOf("composerTurnSnapshotReader.read"),
    );
    expect(reconciliation).toContain(
      'operation.kind === "turn" || queueSnapshot !== undefined',
    );
    expect(reconciliation).toContain(
      "turnsNegativeEvidenceAllowed = snapshot.negativeEvidenceAllowed",
    );
    expect(reconciliation).toContain(
      "negativeEvidenceAllowed: turnsNegativeEvidenceAllowed",
    );
    expect(threadSync).toContain("negativeEvidenceAllowed: true");
    expect(reconcileOperation).toContain(
      "if (!negativeEvidenceAllowed) continue;",
    );
  });

  it("treats browser network state as a hint and keeps reconnecting without a retry ceiling", () => {
    const userOffline = mainSource.slice(
      mainSource.indexOf('window.addEventListener("offline"'),
      mainSource.indexOf('window.addEventListener("online"'),
    );
    const adminOffline = adminSource.slice(
      adminSource.indexOf('window.addEventListener("offline"'),
      adminSource.indexOf('window.addEventListener("online"'),
    );
    expect(userOffline).not.toContain("client?.close");
    expect(adminOffline).not.toContain("client?.close");
    expect(mainSource).not.toContain("!navigator.onLine");
    expect(adminSource).not.toContain("!navigator.onLine");
    expect(mainSource).toContain("reconnectWithUnlimitedAttempts");
    expect(mainSource).toContain("scheduleConnectionKeepalive");
  });

  it("does not reload the page after an app-server restart", () => {
    const restartRecovery = mainSource.slice(
      mainSource.indexOf("async function reconnectAfterCodexRestart"),
      mainSource.indexOf("function settingsInputValue"),
    );
    expect(restartRecovery).toContain("recoverConnection(previous)");
    expect(restartRecovery).not.toContain("location.reload");
    expect(restartRecovery).not.toContain("GatewayClient.connect");
  });

  it("swaps a recovered transport without running the destructive initial activation path", () => {
    const recovery = mainSource.slice(
      mainSource.indexOf("async function recoverConnection"),
      mainSource.indexOf("function activeThreadSnapshot"),
    );
    expect(recovery).toContain("bindActiveClient(nextClient)");
    expect(recovery).toContain("const thread = activeThreadSnapshot()");
    expect(recovery).not.toContain("await activate(nextClient)");
  });

  it("waits while hidden but leaves the retry loop for visible reauthentication", () => {
    const userRecovery = mainSource.slice(
      mainSource.indexOf("async function recoverConnection"),
      mainSource.indexOf("function activeThreadSnapshot"),
    );
    const adminRecovery = adminSource.slice(
      adminSource.indexOf("async function recoverAdminConnection"),
      adminSource.indexOf("function wakeAdminConnectionRecovery"),
    );
    for (const recovery of [userRecovery, adminRecovery]) {
      expect(recovery).toContain(
        "previous.reconnect({ canInteract: () => !document.hidden })",
      );
      expect(recovery).toContain(
        "document.hidden &&\n            error instanceof GatewayReauthenticationRequired",
      );
      expect(recovery).not.toContain(
        "error instanceof GatewayReauthenticationRequired ||",
      );
    }
    expect(userRecovery).toContain("showHostReauthentication(previous, false)");
    expect(adminRecovery).toContain(
      "showAdminReauthentication(previous, false)",
    );
  });

  it("turns a cancelled automatic Passkey check into an explicit login state", () => {
    const userFallback = mainSource.slice(
      mainSource.indexOf("function showHostReauthentication"),
      mainSource.indexOf("async function continueAfterHostAuthentication"),
    );
    const adminFallback = adminSource.slice(
      adminSource.indexOf("function showAdminReauthentication"),
      adminSource.indexOf("async function refreshDashboard"),
    );
    expect(userFallback).toContain("clearConnectionKeepalive()");
    expect(userFallback).toContain("unsubscribeClientConnection?.()");
    expect(userFallback).toContain(
      "temporaryReauthenticationClient = previous",
    );
    expect(userFallback).toContain("client = undefined");
    expect(userFallback).toContain(
      "rememberDevice.checked = !temporaryPassword",
    );
    expect(adminFallback).toContain("clearAdminConnectionKeepalive()");
    expect(adminFallback).toContain("unsubscribeClientConnection?.()");
    expect(adminFallback).toContain("reauthenticationClient = previous");
    expect(adminFallback).toContain("client = undefined");
    expect(adminFallback).toContain(
      "rememberInput.checked = !temporaryPassword",
    );
  });
});
