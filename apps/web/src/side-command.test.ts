import { describe, expect, it } from "vitest";

import {
  canAbandonSideOutcome,
  offersSideCommandCompletion,
  parseWebComposerCommand,
  sideMayStillBeRunning,
  sideRecoveryDisposition,
  sideSnapshotUpdateMode,
  sideVisibleTurns,
  supportsSafeSide,
} from "./side-command.js";

describe("Web /side command", () => {
  it("recognizes /side only at the absolute start with a non-empty question", () => {
    expect(parseWebComposerCommand("normal message")).toEqual({
      kind: "message",
    });
    expect(parseWebComposerCommand("/side compare both approaches ")).toEqual({
      kind: "side",
      prompt: "compare both approaches",
    });
    expect(parseWebComposerCommand(" /side compare both approaches")).toEqual({
      kind: "message",
    });
    expect(parseWebComposerCommand("compare /side approaches")).toEqual({
      kind: "message",
    });
    expect(parseWebComposerCommand("side compare both approaches")).toEqual({
      kind: "message",
    });
    expect(parseWebComposerCommand("/side")).toEqual({
      kind: "invalid-side",
    });
    expect(parseWebComposerCommand("/status")).toEqual({
      kind: "unsupported",
    });
  });

  it("offers completion only for a leading slash-command prefix", () => {
    expect(offersSideCommandCompletion("/")).toBe(true);
    expect(offersSideCommandCompletion("/s")).toBe(true);
    expect(offersSideCommandCompletion("/side")).toBe(true);
    expect(offersSideCommandCompletion("/side ")).toBe(false);
    expect(offersSideCommandCompletion("side")).toBe(false);
    expect(offersSideCommandCompletion(" /side")).toBe(false);
    expect(offersSideCommandCompletion("ask /side")).toBe(false);
    expect(offersSideCommandCompletion("/status")).toBe(false);
  });

  it("hides inherited parent turns from the Side timeline", () => {
    expect(
      sideVisibleTurns(
        [{ id: "parent-1" }, { id: "parent-2" }, { id: "side-1" }],
        "parent-2",
        "side-1",
      ),
    ).toEqual([{ id: "side-1" }]);
    expect(
      sideVisibleTurns([{ id: "parent-1" }, { id: "parent-2" }], "parent-2"),
    ).toEqual([]);
    expect(
      sideVisibleTurns(
        [{ id: "side-21" }, { id: "side-22" }],
        "parent-2",
        "side-1",
      ),
    ).toEqual([{ id: "side-21" }, { id: "side-22" }]);
  });

  it("drops Side only after the app-server generation definitively changes", () => {
    expect(sideRecoveryDisposition("generation-1", "generation-1")).toBe(
      "retain",
    );
    expect(sideRecoveryDisposition("generation-1", undefined)).toBe("retain");
    expect(sideRecoveryDisposition("generation-1", "generation-2")).toBe(
      "vanished",
    );
  });

  it("treats an indeterminate Side mutation as possibly still running", () => {
    expect(
      sideMayStillBeRunning({
        statusActive: false,
        pendingMutation: true,
      }),
    ).toBe(true);
    expect(
      sideMayStillBeRunning({
        statusActive: false,
        pendingMutation: false,
      }),
    ).toBe(false);
  });

  it("merges a reconnect snapshot without replacing the live Side timeline", () => {
    expect(
      sideSnapshotUpdateMode({ preserveTimeline: true, openingSide: true }),
    ).toBe("merge");
    expect(
      sideSnapshotUpdateMode({ preserveTimeline: false, openingSide: true }),
    ).toBe("replace");
    expect(
      sideSnapshotUpdateMode({ preserveTimeline: true, openingSide: false }),
    ).toBe("replace");
  });

  it("requires both bounded fork and explicit Side control support", () => {
    expect(supportsSafeSide({ fork: true, sessionControl: true })).toBe(true);
    expect(supportsSafeSide({ fork: true, sessionControl: false })).toBe(false);
    expect(supportsSafeSide({ fork: false, sessionControl: true })).toBe(false);
  });

  it("does not abandon an indeterminate outcome while its Side is retained", () => {
    expect(
      canAbandonSideOutcome({
        continuityOverflow: true,
        sideStillRetained: true,
      }),
    ).toBe(false);
    expect(
      canAbandonSideOutcome({
        continuityOverflow: true,
        sideStillRetained: false,
      }),
    ).toBe(true);
  });
});
