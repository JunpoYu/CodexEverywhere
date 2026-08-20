import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import {
  changedPreferences,
  preferenceDraftFrom,
  rebasePreferenceDraft,
} from "./SettingsPage.js";

type Preferences = OutputOf<"preferences/read">;

const current: Preferences = {
  version: 1,
  revision: 3,
  theme: "system",
  locale: "zh-CN",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
};

describe("SettingsPage preferences", () => {
  it("builds a patch only after the user explicitly changes a field", () => {
    expect(changedPreferences(current, preferenceDraftFrom(current))).toEqual(
      {},
    );
    expect(
      changedPreferences(current, {
        ...preferenceDraftFrom(current),
        sandbox: "read-only",
      }),
    ).toEqual({ sandbox: "read-only" });
  });

  it("rebases unsaved choices onto the latest authoritative preferences", () => {
    const latest: Preferences = {
      ...current,
      revision: 4,
      theme: "dark",
      approvalPolicy: "never",
    };

    expect(
      rebasePreferenceDraft(latest, {
        sandbox: "read-only",
      }),
    ).toEqual({
      theme: "dark",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  });
});
