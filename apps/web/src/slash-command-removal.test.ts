import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const styleSource = readFileSync(
  new URL("./style.css", import.meta.url),
  "utf8",
);

describe("minimal Web command surface", () => {
  it("does not restore the former command registry or autocomplete menu", () => {
    expect(existsSync(new URL("./slash-commands.ts", import.meta.url))).toBe(
      false,
    );
    expect(mainSource).not.toContain("slash-command-menu");
    expect(mainSource).not.toContain("./slash-commands.js");
    expect(mainSource).toContain("/side 开启临时支线");
    expect(styleSource).not.toContain(".slash-command-item");
  });

  it("implements /side as an ephemeral fork with explicit Side chrome", () => {
    const side = mainSource.slice(
      mainSource.indexOf("async function startSideConversation"),
      mainSource.indexOf("async function sendTurn"),
    );
    expect(side).toContain('"thread/fork"');
    expect(side).toContain(
      "targetClient.supportsCapability(GATEWAY_CAPABILITIES.sideForkV1)",
    );
    expect(side).toContain("ephemeral: true");
    expect(side).toContain("requestRecoverableGatewayMutation");
    expect(side).toContain("operation.idempotencyKey");
    expect(side).toContain("lastTurnId: operation.inheritedThroughTurnId");
    expect(side).not.toContain("fork.thread.turns.map");
    expect(mainSource).toContain('id="side-session-banner"');
    expect(mainSource).toContain('id="return-from-side"');
    expect(mainSource).toContain('id="side-fork-outcome-review"');
    expect(mainSource).toContain(
      "!operation.outcomeUnknown || sideForkReconciliation",
    );
    expect(mainSource).toContain(
      "activeSideSession.firstSideTurnId = outcome.turnId",
    );
    expect(mainSource).toContain(
      "activeSideSession.firstSideTurnId = response.turn.id",
    );
    expect(mainSource).toContain("const sideToRestore = reauthenticatedClient");
    expect(mainSource).toContain(
      "const restored = await openThread(sideToRestore.thread",
    );
    expect(mainSource).toContain("fallbackFromUnavailableSide");
    expect(mainSource).toContain("activeSideSession = undefined");
    expect(mainSource).toContain("临时支线不支持持久 Queue");
  });

  it("still fails unsupported slash text closed", () => {
    const submission = mainSource.slice(
      mainSource.indexOf("async function submitComposerMessage"),
      mainSource.indexOf("async function startSideConversation"),
    );
    expect(submission).toContain('command.kind === "unsupported"');
    expect(submission).toContain("Web 目前只支持 /side");
  });
});
