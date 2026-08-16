export type Disposer = () => void | Promise<void>;

export interface DisposableLike {
  dispose(): void | Promise<void>;
}

export interface CloseableLike {
  close(): void | Promise<void>;
}

export class ScopeClosedError extends Error {
  constructor(readonly scopeName: string) {
    super(`Scope is closed: ${scopeName}`);
    this.name = "ScopeClosedError";
  }
}

/** Owns the finite lifetime of listeners, timers, clients, and child scopes. */
export class Scope {
  readonly #controller = new AbortController();
  readonly #disposers: Disposer[] = [];
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
    this.#disposers.push(disposer);
    return disposer;
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
    this.defer(() => child.close());
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
    this.defer(remove);
    return remove;
  }

  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> {
    this.throwIfClosed();
    const handle = setTimeout(() => {
      if (!this.signal.aborted) callback();
    }, delayMs);
    this.defer(() => clearTimeout(handle));
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
    for (let index = this.#disposers.length - 1; index >= 0; index -= 1) {
      try {
        await this.#disposers[index]?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#disposers.length = 0;
    this.#closed = true;

    if (errors.length > 0) {
      throw new AggregateError(errors, `Failed to close scope: ${this.name}`);
    }
  }
}
