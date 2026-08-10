import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const adminSource = readFileSync(
  new URL("./admin-main.ts", import.meta.url),
  "utf8",
);

describe("frontend reliability contracts", () => {
  it("does not open the mobile keyboard merely because history was opened", () => {
    const openThread = mainSource.slice(
      mainSource.indexOf("async function openThread"),
      mainSource.indexOf("async function openNewSession"),
    );
    expect(openThread).not.toContain("messageInput.focus");
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
