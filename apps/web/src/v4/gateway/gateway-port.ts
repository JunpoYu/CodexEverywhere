import {
  GatewayV2Client,
  type GatewayEventEnvelopeV2,
  type GatewayMethodName,
  type GatewayV2Transport,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { Scope } from "@codex-everywhere/kernel";

export interface GatewayPort {
  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>>;
  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void;
  onConnectionLost(listener: (error: Error) => void): () => void;
  onConnectionRestored(listener: () => void): () => void;
  close(): void | Promise<void>;
}

export interface EventfulGatewayV2Transport extends GatewayV2Transport {
  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void;
  onConnectionLost(listener: (error: Error) => void): () => void;
  close(): void | Promise<void>;
}

/** One typed client boundary shared by Direct, Relay, Scenario and Admin. */
export class TypedGatewayPort implements GatewayPort {
  readonly #client: GatewayV2Client;
  readonly #transport: EventfulGatewayV2Transport;

  constructor(transport: EventfulGatewayV2Transport) {
    this.#transport = transport;
    this.#client = new GatewayV2Client(transport);
  }

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    return this.#client.request(method, input, options);
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return this.#transport.onEvent(listener);
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    return this.#transport.onConnectionLost(listener);
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void | Promise<void> {
    return this.#transport.close();
  }
}

export interface ReconnectingGatewayPortOptions {
  readonly initial: GatewayPort;
  readonly reconnect: (signal: AbortSignal) => Promise<GatewayPort>;
  readonly retryDelaysMs?: readonly number[];
}

/**
 * Keeps actors attached to one stable typed port while replacing failed
 * Direct/Relay transports underneath it. Session credentials remain owned by
 * the reconnect closure and are never persisted by this class.
 */
export class ReconnectingGatewayPort implements GatewayPort {
  readonly #scope = new Scope("reconnecting-gateway-port");
  readonly #reconnect: (signal: AbortSignal) => Promise<GatewayPort>;
  readonly #retryDelaysMs: readonly number[];
  readonly #events = new Set<(event: GatewayEventEnvelopeV2) => void>();
  readonly #lostListeners = new Set<(error: Error) => void>();
  readonly #restoredListeners = new Set<() => void>();
  #bindingScope: Scope | undefined;
  #current: GatewayPort | undefined;
  #terminalError: Error | undefined;
  #reconnectAttempt = 0;
  #reconnectScheduled = false;

  constructor(options: ReconnectingGatewayPortOptions) {
    if (options.retryDelaysMs?.length === 0) {
      throw new Error("Reconnect retry delays cannot be empty");
    }
    this.#reconnect = options.reconnect;
    this.#retryDelaysMs = options.retryDelaysMs ?? [
      250, 500, 1_000, 2_000, 5_000,
    ];
    if (
      this.#retryDelaysMs.some(
        (delay) => !Number.isSafeInteger(delay) || delay < 0,
      )
    ) {
      throw new Error("Reconnect retry delays must be non-negative integers");
    }
    this.#attach(options.initial);
  }

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (this.#terminalError !== undefined) {
      return Promise.reject(this.#terminalError);
    }
    const current = this.#current;
    if (current === undefined) {
      return Promise.reject(new Error("宿主机正在重连"));
    }
    return current.request(method, input, options);
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    this.#lostListeners.add(listener);
    return () => this.#lostListeners.delete(listener);
  }

  onConnectionRestored(listener: () => void): () => void {
    this.#restoredListeners.add(listener);
    return () => this.#restoredListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.#scope.close("gateway-port-closed");
    this.#events.clear();
    this.#lostListeners.clear();
    this.#restoredListeners.clear();
  }

  #attach(port: GatewayPort): void {
    this.#scope.throwIfClosed();
    const binding = this.#scope.fork("transport-binding");
    this.#bindingScope = binding;
    this.#current = port;
    binding.defer(
      port.onEvent((event) => {
        if (this.#current !== port) return;
        for (const listener of [...this.#events]) listener(event);
      }),
    );
    binding.defer(
      port.onConnectionLost((error) => this.#transportLost(port, error)),
    );
    binding.defer(() => port.close());
  }

  #transportLost(port: GatewayPort, error: Error): void {
    if (this.#scope.closed || this.#current !== port) return;
    this.#current = undefined;
    const binding = this.#bindingScope;
    this.#bindingScope = undefined;
    void binding?.close("transport-lost").catch(() => undefined);
    for (const listener of [...this.#lostListeners]) listener(error);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (
      this.#scope.closed ||
      this.#reconnectScheduled ||
      this.#terminalError !== undefined
    ) {
      return;
    }
    this.#reconnectScheduled = true;
    const delay =
      this.#retryDelaysMs[
        Math.min(this.#reconnectAttempt, this.#retryDelaysMs.length - 1)
      ]!;
    this.#scope.setTimeout(() => {
      this.#reconnectScheduled = false;
      void this.#attemptReconnect();
    }, delay);
  }

  async #attemptReconnect(): Promise<void> {
    if (this.#scope.closed || this.#current !== undefined) return;
    try {
      const port = await this.#reconnect(this.#scope.signal);
      if (this.#scope.closed) {
        await port.close();
        return;
      }
      this.#reconnectAttempt = 0;
      this.#attach(port);
      for (const listener of [...this.#restoredListeners]) listener();
    } catch (error) {
      if (this.#scope.closed) return;
      const failure =
        error instanceof Error ? error : new Error("宿主机重连失败");
      if (isTerminalReconnectError(failure)) {
        this.#terminalError = failure;
        for (const listener of [...this.#lostListeners]) listener(failure);
        return;
      }
      this.#reconnectAttempt += 1;
      this.#scheduleReconnect();
    }
  }
}

function isTerminalReconnectError(error: Error): boolean {
  return (
    error.name === "GatewayUpgradeRequiredError" ||
    error.name === "GatewayReauthenticationRequiredError"
  );
}

export function mutationOptions(
  operationKey: string = crypto.randomUUID(),
  signal?: AbortSignal,
): { readonly operationKey: string; readonly signal?: AbortSignal } {
  return {
    operationKey,
    ...(signal === undefined ? {} : { signal }),
  };
}

export function queryOptions(signal?: AbortSignal): {
  readonly signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}
