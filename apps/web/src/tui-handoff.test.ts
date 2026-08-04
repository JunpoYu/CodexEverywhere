import { describe, expect, it } from "vitest";

import {
  dismissTuiHandoffHint,
  isTuiHandoffHintDismissed,
  setTuiHandoffVisibility,
  tuiHandoffCommand,
  tuiPickerCommand,
} from "./tui-handoff.js";

describe("TUI handoff command", () => {
  it("targets the exact Web thread and workspace", () => {
    expect(tuiHandoffCommand("/public/home/user/project", "thr_123")).toBe(
      "ce tui '/public/home/user/project' --thread 'thr_123'",
    );
  });

  it("quotes shell metacharacters in workspace paths", () => {
    expect(tuiHandoffCommand("/public/a user's project", "thr_123")).toBe(
      `ce tui '/public/a user'"'"'s project' --thread 'thr_123'`,
    );
  });

  it("provides a reusable command that opens the resume picker", () => {
    expect(tuiPickerCommand("/public/home/user/project")).toBe(
      "ce tui '/public/home/user/project'",
    );
    expect(tuiPickerCommand("/public/a user's project")).toBe(
      `ce tui '/public/a user'"'"'s project'`,
    );
  });

  it("toggles the supplied handoff entry points", () => {
    const headerButton = { hidden: true };
    const banner = { hidden: true };

    setTuiHandoffVisibility([headerButton, banner], true);
    expect(headerButton.hidden).toBe(false);
    expect(banner.hidden).toBe(false);

    setTuiHandoffVisibility([headerButton, banner], false);
    expect(headerButton.hidden).toBe(true);
    expect(banner.hidden).toBe(true);
  });

  it("remembers when the explanatory banner should no longer appear", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(isTuiHandoffHintDismissed(storage)).toBe(false);
    dismissTuiHandoffHint(storage);
    expect(isTuiHandoffHintDismissed(storage)).toBe(true);
  });

  it("keeps the hint usable when browser storage is unavailable", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(isTuiHandoffHintDismissed(storage)).toBe(false);
    expect(() => dismissTuiHandoffHint(storage)).not.toThrow();
  });
});
