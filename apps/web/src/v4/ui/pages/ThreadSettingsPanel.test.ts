import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import { changedSettings } from "./ThreadSettingsPanel.js";

type ThreadSettings = OutputOf<"thread/open">["settings"];

const current: ThreadSettings = {
  version: 1,
  revision: 4,
  model: "gpt-5.6-sol",
  effort: "max",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
};

describe("ThreadSettingsPanel", () => {
  it("does not resend unchanged model and effort with a permission update", () => {
    expect(
      changedSettings(current, {
        model: "gpt-5.6-sol",
        effort: "max",
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      }),
    ).toEqual({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("returns an empty patch when the form has no changes", () => {
    expect(
      changedSettings(current, {
        model: " gpt-5.6-sol ",
        effort: "max",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      }),
    ).toEqual({});
  });
});
