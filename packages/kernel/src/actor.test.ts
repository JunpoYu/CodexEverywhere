import { describe, expect, it, vi } from "vitest";
import { Actor, type ActorTransition } from "./actor.js";

interface State {
  readonly value: string;
  readonly loading: boolean;
}

type Event =
  | { readonly type: "load"; readonly value: string }
  | { readonly type: "loaded"; readonly value: string }
  | { readonly type: "replace"; readonly value: string };

interface Effect {
  readonly value: string;
  readonly barrier: Promise<void>;
}

function reduce(state: State, event: Event): ActorTransition<State, Effect> {
  switch (event.type) {
    case "load":
      return {
        state: { ...state, loading: true },
        effects: [{ value: event.value, barrier: barriers.get(event.value)! }],
      };
    case "loaded":
      return { state: { value: event.value, loading: false } };
    case "replace":
      return { state: { value: event.value, loading: false } };
  }
}

const barriers = new Map<string, Promise<void>>();

describe("Actor", () => {
  it("publishes reducer state as an external store", async () => {
    barriers.set("remote", Promise.resolve());
    const listener = vi.fn();
    const actor = createActor();
    const unsubscribe = actor.subscribe(listener);

    actor.dispatch({ type: "replace", value: "local" });

    expect(actor.getSnapshot()).toEqual({ value: "local", loading: false });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await actor.close();
  });

  it("prevents an old asynchronous result from replacing newer state", async () => {
    let release: (() => void) | undefined;
    barriers.set(
      "old",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const actor = createActor();

    actor.dispatch({ type: "load", value: "old" });
    actor.dispatch({ type: "replace", value: "new" });
    release?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(actor.getSnapshot()).toEqual({ value: "new", loading: false });
    await actor.close();
  });

  it("aborts superseded effects before reducing the next event", async () => {
    let release: (() => void) | undefined;
    barriers.set(
      "old",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let effectSignal: AbortSignal | undefined;
    const actor = createActor((signal) => {
      effectSignal = signal;
    });

    actor.dispatch({ type: "load", value: "old" });
    actor.dispatch({ type: "replace", value: "new" });

    expect(effectSignal?.aborted).toBe(true);
    release?.();
    await actor.close();
  });

  it("reports a current effect failure but ignores a stale failure", async () => {
    barriers.set("current", Promise.reject(new Error("current failure")));
    let rejectOld: ((error: unknown) => void) | undefined;
    barriers.set(
      "old",
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      }),
    );
    const errors: unknown[] = [];
    const actor = createActor(undefined, (error) => errors.push(error));

    actor.dispatch({ type: "load", value: "current" });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);

    actor.dispatch({ type: "load", value: "old" });
    actor.dispatch({ type: "replace", value: "new" });
    rejectOld?.(new Error("stale failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    await actor.close();
  });
});

function createActor(
  inspectSignal?: (signal: AbortSignal) => void,
  onEffectError: (error: unknown) => void = () => undefined,
): Actor<State, Event, Effect> {
  return new Actor({
    name: "test",
    initialState: { value: "initial", loading: false },
    reducer: reduce,
    runEffect: async (effect, context) => {
      inspectSignal?.(context.signal);
      await effect.barrier;
      context.dispatch({ type: "loaded", value: effect.value });
    },
    onEffectError,
  });
}
