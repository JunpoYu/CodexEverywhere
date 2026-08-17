import { useSyncExternalStore } from "react";

import type { Actor } from "@codex-everywhere/kernel";

export function useActorState<State, Event, Effect>(
  actor: Actor<State, Event, Effect>,
): State {
  return useSyncExternalStore(
    actor.subscribe,
    actor.getSnapshot,
    actor.getSnapshot,
  );
}
