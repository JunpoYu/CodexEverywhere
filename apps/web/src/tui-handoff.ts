function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export const TUI_HANDOFF_HINT_DISMISSED_KEY =
  "ce:tui-handoff-hint-dismissed:v1";

export type TuiHandoffPreferenceStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function tuiHandoffCommand(cwd: string, threadId: string): string {
  return `ce tui ${shellQuote(cwd)} --thread ${shellQuote(threadId)}`;
}

export function tuiPickerCommand(cwd: string): string {
  return `ce tui ${shellQuote(cwd)}`;
}

export function setTuiHandoffVisibility(
  targets: ReadonlyArray<{ hidden: boolean }>,
  visible: boolean,
): void {
  for (const target of targets) target.hidden = !visible;
}

export function isTuiHandoffHintDismissed(
  storage: TuiHandoffPreferenceStore,
): boolean {
  try {
    return storage.getItem(TUI_HANDOFF_HINT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissTuiHandoffHint(
  storage: TuiHandoffPreferenceStore,
): void {
  try {
    storage.setItem(TUI_HANDOFF_HINT_DISMISSED_KEY, "1");
  } catch {
    // The banner still closes for this page when browser storage is unavailable.
  }
}
