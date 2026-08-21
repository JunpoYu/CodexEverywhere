import type { OutputOf } from "@codex-everywhere/protocol/v2";

export type Preferences = OutputOf<"preferences/read">;
export type PreferenceDraft = Pick<
  Preferences,
  "theme" | "sandbox" | "approvalPolicy"
>;
export type PreferencePatch = Partial<PreferenceDraft>;
export type PreferenceSaveState =
  "idle" | "saving" | "reconciling" | "refresh-failed";
export type PreferenceFeedback = {
  readonly tone: "success" | "error" | "warning";
  readonly message: string;
};

export function preferenceDraftFrom(preferences: Preferences): PreferenceDraft {
  return {
    theme: preferences.theme,
    sandbox: preferences.sandbox,
    approvalPolicy: preferences.approvalPolicy,
  };
}

export function changedPreferences(
  current: Preferences,
  draft: PreferenceDraft,
): PreferencePatch {
  return {
    ...(draft.theme === current.theme ? {} : { theme: draft.theme }),
    ...(draft.sandbox === current.sandbox ? {} : { sandbox: draft.sandbox }),
    ...(draft.approvalPolicy === current.approvalPolicy
      ? {}
      : { approvalPolicy: draft.approvalPolicy }),
  };
}

export function rebasePreferenceDraft(
  latest: Preferences,
  patch: PreferencePatch,
): PreferenceDraft {
  return { ...preferenceDraftFrom(latest), ...patch };
}

export function resolvePreferenceConflict(
  latest: Preferences,
  submittedPatch: PreferencePatch,
): {
  readonly draft: PreferenceDraft;
  readonly remainingPatch: PreferencePatch;
} {
  const draft = rebasePreferenceDraft(latest, submittedPatch);
  return { draft, remainingPatch: changedPreferences(latest, draft) };
}

export function hasPreferenceChanges(patch: PreferencePatch): boolean {
  return Object.keys(patch).length > 0;
}

export function isPreferenceSaveInFlight(state: PreferenceSaveState): boolean {
  return state === "saving" || state === "reconciling";
}
