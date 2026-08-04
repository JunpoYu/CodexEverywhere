function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function tuiHandoffCommand(cwd: string, threadId: string): string {
  return `ce tui ${shellQuote(cwd)} --thread ${shellQuote(threadId)}`;
}

export function tuiPickerCommand(cwd: string): string {
  return `ce tui ${shellQuote(cwd)}`;
}
