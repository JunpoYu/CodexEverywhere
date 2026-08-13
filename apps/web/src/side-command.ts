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
  inheritedThroughTurnId: string,
  firstSideTurnId?: string,
): T[] {
  if (firstSideTurnId) {
    const firstSideIndex = turns.findIndex(
      (turn) => turn.id === firstSideTurnId,
    );
    // A newest-page snapshot that no longer contains the first Side turn is
    // entirely newer than it. Full legacy snapshots still contain the id.
    return firstSideIndex >= 0 ? turns.slice(firstSideIndex) : [...turns];
  }
  const boundaryIndex = turns.findIndex(
    (turn) => turn.id === inheritedThroughTurnId,
  );
  // Before the first Side turn, fail closed if a server omits the requested
  // boundary instead of leaking inherited parent history into the Side UI.
  return boundaryIndex >= 0 ? turns.slice(boundaryIndex + 1) : [];
}
