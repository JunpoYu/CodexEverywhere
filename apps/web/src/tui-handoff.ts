function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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
