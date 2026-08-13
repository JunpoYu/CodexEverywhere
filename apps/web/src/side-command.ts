export type WebComposerCommand =
  | { kind: "message" }
  | { kind: "side"; prompt: string }
  | { kind: "invalid-side" }
  | { kind: "unsupported" };

export function parseWebComposerCommand(input: string): WebComposerCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "message" };
  const match = /^\/side(?:\s+([\s\S]*))?$/iu.exec(trimmed);
  if (!match) return { kind: "unsupported" };
  const prompt = match[1]?.trim() ?? "";
  return prompt ? { kind: "side", prompt } : { kind: "invalid-side" };
}

export function sideVisibleTurns<T extends { id: string }>(
  turns: readonly T[],
  inheritedTurnIds: ReadonlySet<string>,
): T[] {
  return turns.filter((turn) => !inheritedTurnIds.has(turn.id));
}
