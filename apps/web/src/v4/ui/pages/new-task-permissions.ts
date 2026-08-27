import type { InputOf, OutputOf } from "@codex-everywhere/protocol/v2";

type Preferences = OutputOf<"preferences/read">;
type Source = "default" | "override";

export interface NewTaskPermissionDraft {
  readonly sandbox: {
    readonly value: Preferences["sandbox"];
    readonly source: Source;
  };
  readonly approvalPolicy: {
    readonly value: Preferences["approvalPolicy"];
    readonly source: Source;
  };
}

export function defaultPermissionDraft(
  preferences: Preferences,
): NewTaskPermissionDraft {
  return {
    sandbox: { value: preferences.sandbox, source: "default" },
    approvalPolicy: {
      value: preferences.approvalPolicy,
      source: "default",
    },
  };
}

export function overrideSandbox(
  draft: NewTaskPermissionDraft,
  value: Preferences["sandbox"],
): NewTaskPermissionDraft {
  return { ...draft, sandbox: { value, source: "override" } };
}

export function overrideApprovalPolicy(
  draft: NewTaskPermissionDraft,
  value: Preferences["approvalPolicy"],
): NewTaskPermissionDraft {
  return { ...draft, approvalPolicy: { value, source: "override" } };
}

export function rebaseInheritedPermissions(
  draft: NewTaskPermissionDraft,
  latest: Preferences,
): NewTaskPermissionDraft {
  return {
    sandbox:
      draft.sandbox.source === "default"
        ? { value: latest.sandbox, source: "default" }
        : draft.sandbox,
    approvalPolicy:
      draft.approvalPolicy.source === "default"
        ? { value: latest.approvalPolicy, source: "default" }
        : draft.approvalPolicy,
  };
}

export function inheritedPermissionsChanged(
  displayed: Preferences,
  latest: Preferences,
  draft: NewTaskPermissionDraft,
): boolean {
  return (
    (draft.sandbox.source === "default" &&
      displayed.sandbox !== latest.sandbox) ||
    (draft.approvalPolicy.source === "default" &&
      displayed.approvalPolicy !== latest.approvalPolicy)
  );
}

export function threadStartPermissionOverrides(
  draft: NewTaskPermissionDraft,
): NonNullable<InputOf<"thread/start">["settings"]> {
  return {
    ...(draft.sandbox.source === "override"
      ? { sandbox: draft.sandbox.value }
      : {}),
    ...(draft.approvalPolicy.source === "override"
      ? { approvalPolicy: draft.approvalPolicy.value }
      : {}),
  };
}

export function threadStartSettings(
  draft: NewTaskPermissionDraft,
  runtime: { readonly model: string; readonly effort: string },
): NonNullable<InputOf<"thread/start">["settings"]> {
  const model = runtime.model.trim();
  return {
    ...threadStartPermissionOverrides(draft),
    ...(model.length === 0 ? {} : { model }),
    ...(runtime.effort.length === 0 ? {} : { effort: runtime.effort }),
  };
}

export function permissionOverrideCount(draft: NewTaskPermissionDraft): number {
  return (
    Number(draft.sandbox.source === "override") +
    Number(draft.approvalPolicy.source === "override")
  );
}

export function inheritsAnyPermission(draft: NewTaskPermissionDraft): boolean {
  return permissionOverrideCount(draft) < 2;
}
