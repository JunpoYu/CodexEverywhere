import { describe, expect, it } from "vitest";

import { parseWebComposerCommand, sideVisibleTurns } from "./side-command.js";

describe("Web /side command", () => {
  it("recognizes only /side with a non-empty question", () => {
    expect(parseWebComposerCommand("normal message")).toEqual({
      kind: "message",
    });
    expect(parseWebComposerCommand(" /side compare both approaches ")).toEqual({
      kind: "side",
      prompt: "compare both approaches",
    });
    expect(parseWebComposerCommand("/side")).toEqual({
      kind: "invalid-side",
    });
    expect(parseWebComposerCommand("/status")).toEqual({
      kind: "unsupported",
    });
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
});
