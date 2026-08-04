import { describe, expect, it } from "vitest";

import { shouldDismissDialogFromBackdrop } from "./dialog-behavior.js";

describe("dialog dismissal", () => {
  it("keeps credential dialogs open when the backdrop receives a click", () => {
    expect(shouldDismissDialogFromBackdrop("password-dialog")).toBe(false);
    expect(shouldDismissDialogFromBackdrop("recovery-dialog")).toBe(false);
  });

  it("keeps backdrop dismissal for ordinary dialogs", () => {
    expect(shouldDismissDialogFromBackdrop("new-session-dialog")).toBe(true);
  });
});
