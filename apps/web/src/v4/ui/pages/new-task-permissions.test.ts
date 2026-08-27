import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import {
  defaultPermissionDraft,
  inheritedPermissionsChanged,
  overrideApprovalPolicy,
  overrideSandbox,
  permissionOverrideCount,
  rebaseInheritedPermissions,
  threadStartPermissionOverrides,
  threadStartSettings,
} from "./new-task-permissions.js";

type Preferences = OutputOf<"preferences/read">;

const current: Preferences = {
  version: 1,
  revision: 4,
  theme: "system",
  locale: "zh-CN",
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
};

describe("new task permission provenance", () => {
  it("submits only fields intentionally overridden for this task", () => {
    const draft = overrideSandbox(
      defaultPermissionDraft(current),
      "danger-full-access",
    );

    expect(permissionOverrideCount(draft)).toBe(1);
    expect(threadStartPermissionOverrides(draft)).toEqual({
      sandbox: "danger-full-access",
    });
  });

  it("adds optional model and effort overrides to the same start settings", () => {
    const draft = defaultPermissionDraft(current);

    expect(
      threadStartSettings(draft, {
        model: " gpt-example ",
        effort: "high",
      }),
    ).toEqual({ model: "gpt-example", effort: "high" });
    expect(threadStartSettings(draft, { model: "", effort: "" })).toEqual({});
  });

  it("rebases an untouched field without replacing the explicit override", () => {
    const draft = overrideSandbox(
      defaultPermissionDraft(current),
      "danger-full-access",
    );
    const latest: Preferences = {
      ...current,
      revision: 5,
      approvalPolicy: "never",
    };

    expect(inheritedPermissionsChanged(current, latest, draft)).toBe(true);
    expect(rebaseInheritedPermissions(draft, latest)).toEqual({
      sandbox: { value: "danger-full-access", source: "override" },
      approvalPolicy: { value: "never", source: "default" },
    });
  });

  it("ignores newer defaults for fields explicitly overridden", () => {
    const draft = overrideApprovalPolicy(
      overrideSandbox(defaultPermissionDraft(current), "read-only"),
      "never",
    );
    const latest: Preferences = {
      ...current,
      revision: 5,
      sandbox: "danger-full-access",
      approvalPolicy: "untrusted",
    };

    expect(inheritedPermissionsChanged(current, latest, draft)).toBe(false);
    expect(threadStartPermissionOverrides(draft)).toEqual({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  });
});
