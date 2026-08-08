import { describe, expect, it } from "vitest";

import {
  shouldDismissDialogFromBackdrop,
  shouldPreventDialogCancel,
} from "./dialog-behavior.js";

describe("dialog dismissal", () => {
  it("keeps credential dialogs open when the backdrop receives a click", () => {
    expect(shouldDismissDialogFromBackdrop("password-dialog")).toBe(false);
    expect(shouldDismissDialogFromBackdrop("recovery-dialog")).toBe(false);
    expect(shouldDismissDialogFromBackdrop("network-settings-dialog")).toBe(
      false,
    );
    expect(shouldPreventDialogCancel("network-settings-dialog")).toBe(true);
    expect(shouldDismissDialogFromBackdrop("settings-dialog")).toBe(false);
    expect(shouldPreventDialogCancel("settings-dialog")).toBe(true);
  });

  it("keeps backdrop dismissal for ordinary dialogs", () => {
    expect(shouldDismissDialogFromBackdrop("new-session-dialog")).toBe(true);
    expect(shouldPreventDialogCancel("new-session-dialog")).toBe(false);
  });
});
