import { Scope, ScopeClosedError } from "./scope.js";

export interface ActorTransition<State, Effect> {
  readonly state: State;
  readonly effects?: readonly Effect[];
}

export type ActorReducer<State, Event, Effect> = (
  state: State,
  event: Event,
) => ActorTransition<State, Effect>;

export interface ActorEffectContext<Event> {
  readonly generation: number;
  readonly signal: AbortSignal;
  dispatch(event: Event): boolean;
  isCurrent(): boolean;
}

export type ActorEffectRunner<Event, Effect> = (
  effect: Effect,
  context: ActorEffectContext<Event>,
) => void | Promise<void>;

export interface ActorOptions<State, Event, Effect> {
  readonly name: string;
  readonly initialState: State;
  readonly reducer: ActorReducer<State, Event, Effect>;
  readonly runEffect: ActorEffectRunner<Event, Effect>;
  readonly scope?: Scope;
  readonly onEffectError: (error: unknown, effect: Effect) => void;
}

/**
 * A small external store with generation-bound asynchronous effects.
 * Any new event invalidates prior effects before the reducer runs.
 */
export class Actor<State, Event, Effect> {
  readonly #scope: Scope;
  readonly #reducer: ActorReducer<State, Event, Effect>;
  readonly #runEffect: ActorEffectRunner<Event, Effect>;
  readonly #onEffectError: (error: unknown, effect: Effect) => void;
  readonly #listeners = new Set<() => void>();
  #state: State;
  #generation = 0;
  #effectScope: Scope | undefined;
  #closed = false;

  constructor(options: ActorOptions<State, Event, Effect>) {
    this.#scope = (options.scope ?? new Scope("actors")).fork(options.name);
    this.#state = options.initialState;
    this.#reducer = options.reducer;
    this.#runEffect = options.runEffect;
    this.#onEffectError = options.onEffectError;
  }

  getSnapshot = (): State => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  dispatch(event: Event): void {
    this.#assertOpen();
    this.#generation += 1;
    const generation = this.#generation;
    void this.#effectScope?.close("Superseded by a newer actor event");
    this.#effectScope = undefined;

    const transition = this.#reducer(this.#state, event);
    if (!Object.is(transition.state, this.#state)) {
      this.#state = transition.state;
      for (const listener of [...this.#listeners]) listener();
    }

    if (transition.effects === undefined || transition.effects.length === 0) {
      return;
    }

    const effectScope = this.#scope.fork(`generation-${generation}`);
    this.#effectScope = effectScope;
    const context: ActorEffectContext<Event> = {
      generation,
      signal: effectScope.signal,
      dispatch: (nextEvent) => {
        if (!this.#isGenerationCurrent(generation, effectScope)) return false;
        this.dispatch(nextEvent);
        return true;
      },
      isCurrent: () => this.#isGenerationCurrent(generation, effectScope),
    };

    for (const effect of transition.effects) {
      Promise.resolve(this.#runEffect(effect, context)).catch(
        (error: unknown) => {
          if (this.#isGenerationCurrent(generation, effectScope)) {
            this.#onEffectError(error, effect);
          }
        },
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#generation += 1;
    this.#listeners.clear();
    await this.#scope.close("Actor closed");
  }

  #isGenerationCurrent(generation: number, effectScope: Scope): boolean {
    return (
      !this.#closed &&
      !effectScope.signal.aborted &&
      generation === this.#generation &&
      effectScope === this.#effectScope
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new ScopeClosedError(this.#scope.name);
  }
}
