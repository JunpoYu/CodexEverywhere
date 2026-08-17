export type Disposer = () => void | Promise<void>;

export interface DisposableLike {
  dispose(): void | Promise<void>;
}

export interface CloseableLike {
  close(): void | Promise<void>;
}

type DisposerEntry = {
  readonly disposer: Disposer;
  active: boolean;
  running?: Promise<void>;
};

export class ScopeClosedError extends Error {
  constructor(readonly scopeName: string) {
    super(`Scope is closed: ${scopeName}`);
    this.name = "ScopeClosedError";
  }
}

/** Owns the finite lifetime of listeners, timers, clients, and child scopes. */
export class Scope {
  readonly #controller = new AbortController();
  readonly #disposers: DisposerEntry[] = [];
  readonly #closedListeners: Array<() => void> = [];
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(readonly name = "scope") {}

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#closed;
  }

  throwIfClosed(): void {
    if (this.#closed || this.#closing !== undefined) {
      throw new ScopeClosedError(this.name);
    }
  }

  defer(disposer: Disposer): Disposer {
    this.throwIfClosed();
    const entry: DisposerEntry = { disposer, active: true };
    this.#disposers.push(entry);
    return () => this.#disposeEntry(entry);
  }

  own<Resource extends DisposableLike | CloseableLike>(
    resource: Resource,
  ): Resource {
    if ("dispose" in resource) {
      this.defer(() => resource.dispose());
    } else {
      this.defer(() => resource.close());
    }
    return resource;
  }

  fork(name: string): Scope {
    this.throwIfClosed();
    const child = new Scope(`${this.name}/${name}`);
    const entry: DisposerEntry = {
      disposer: () => child.close(),
      active: true,
    };
    this.#disposers.push(entry);
    child.#closedListeners.push(() => this.#forget(entry));
    return child;
  }

  listen<EventName extends string>(
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    type: EventName,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): Disposer {
    this.throwIfClosed();
    target.addEventListener(type, listener, options);
    const remove = () => target.removeEventListener(type, listener, options);
    return this.defer(remove);
  }

  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    this.throwIfClosed();
    let unregister: Disposer = () => undefined;
    const handle = setTimeout(() => {
      void unregister();
      if (!this.signal.aborted) callback();
    }, delayMs);
    unregister = this.defer(() => clearTimeout(handle));
    return handle;
  }

  setInterval(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setInterval> {
    this.throwIfClosed();
    const handle = setInterval(() => {
      if (!this.signal.aborted) callback();
    }, delayMs);
    this.defer(() => clearInterval(handle));
    return handle;
  }

  close(reason?: unknown): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    if (this.#closed) return Promise.resolve();

    this.#controller.abort(reason);
    this.#closing = this.#disposeAll();
    return this.#closing;
  }

  async #disposeAll(): Promise<void> {
    const errors: unknown[] = [];
    const entries = [...this.#disposers].reverse();
    for (const entry of entries) {
      try {
        await this.#disposeEntry(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#disposers.length = 0;
    this.#closed = true;
    for (const listener of this.#closedListeners.splice(0)) listener();

    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to close scope: ${this.name}`);
    }
  }

  #disposeEntry(entry: DisposerEntry): Promise<void> {
    if (entry.running !== undefined) return entry.running;
    if (!entry.active) return Promise.resolve();
    entry.active = false;
    this.#forget(entry);
    try {
      entry.running = Promise.resolve(entry.disposer());
    } catch (error) {
      entry.running = Promise.reject(error);
    }
    return entry.running;
  }

  #forget(entry: DisposerEntry): void {
    const index = this.#disposers.indexOf(entry);
    if (index >= 0) this.#disposers.splice(index, 1);
  }
}
