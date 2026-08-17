type EventListener<Payload> = (payload: Payload) => void;

/** Synchronous, ordered events for transient CE control-plane coordination. */
export class TypedEventBus<EventMap extends object> {
  readonly #listeners = new Map<keyof EventMap, Set<EventListener<never>>>();

  on<EventName extends keyof EventMap>(
    eventName: EventName,
    listener: EventListener<EventMap[EventName]>,
  ): () => void {
    let listeners = this.#listeners.get(eventName);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(eventName, listeners);
    }
    listeners.add(listener as EventListener<never>);
    return () => {
      listeners?.delete(listener as EventListener<never>);
      if (listeners?.size === 0) this.#listeners.delete(eventName);
    };
  }

  once<EventName extends keyof EventMap>(
    eventName: EventName,
    listener: EventListener<EventMap[EventName]>,
  ): () => void {
    let unsubscribe = (): void => undefined;
    unsubscribe = this.on(eventName, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  emit<EventName extends keyof EventMap>(
    eventName: EventName,
    payload: EventMap[EventName],
  ): void {
    const listeners = [...(this.#listeners.get(eventName) ?? [])];
    const errors: unknown[] = [];
    for (const listener of listeners) {
      try {
        (listener as EventListener<EventMap[EventName]>)(payload);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Event listener failed: ${String(eventName)}`,
      );
    }
  }

  clear(): void {
    this.#listeners.clear();
  }

  listenerCount<EventName extends keyof EventMap>(
    eventName: EventName,
  ): number {
    return this.#listeners.get(eventName)?.size ?? 0;
  }
}
