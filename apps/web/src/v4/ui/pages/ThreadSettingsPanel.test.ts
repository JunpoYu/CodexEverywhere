import type { OutputOf } from "@codex-everywhere/protocol/v2";
import { GatewayRemoteError } from "@codex-everywhere/protocol/v2";
import { describe, expect, it } from "vitest";

import {
  changedThreadSettings,
  resolveThreadSettingsConflict,
  settingsFailureRecovery,
  threadSettingsDraft,
} from "./thread-settings-model.js";

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
      changedThreadSettings(current, {
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
      changedThreadSettings(current, {
        model: " gpt-5.6-sol ",
        effort: "max",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      }),
    ).toEqual({});
  });

  it("rebases the submitted patch onto a newer authoritative revision", () => {
    const latest: ThreadSettings = {
      ...current,
      revision: 5,
      model: "gpt-5.6-terra",
      sandbox: "read-only",
      approvalPolicy: "never",
    };
    const draft = threadSettingsDraft(latest, {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });

    expect(draft.model).toBe("gpt-5.6-terra");
    expect(changedThreadSettings(latest, draft)).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("keeps the conflict patch across consecutive authoritative refreshes", () => {
    const submitted = {
      sandbox: "danger-full-access" as const,
      approvalPolicy: "never" as const,
    };
    const first = resolveThreadSettingsConflict(
      { ...current, revision: 5, model: "gpt-5.6-terra" },
      submitted,
    );
    const second = resolveThreadSettingsConflict(
      { ...current, revision: 6, effort: "ultra" },
      first.remainingPatch,
    );

    expect(first.remainingPatch).toEqual(submitted);
    expect(second.draft).toMatchObject(submitted);
    expect(second.remainingPatch).toEqual(submitted);
  });

  it("clears a conflict patch once the authoritative settings contain it", () => {
    const resolution = resolveThreadSettingsConflict(
      {
        ...current,
        revision: 5,
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      },
      { sandbox: "danger-full-access", approvalPolicy: "never" },
    );

    expect(resolution.remainingPatch).toBeUndefined();
  });

  it("requires an authoritative rebase after a revision conflict", () => {
    expect(
      settingsFailureRecovery(
        new GatewayRemoteError({
          code: "REVISION_CONFLICT",
          message: "Settings changed",
        }),
      ),
    ).toBe("rebase");
  });
});
