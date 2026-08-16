import type {
  GatewayEventEnvelopeV2,
  GatewayMethodName,
  InputOf,
  OutputOf,
  RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReconnectingGatewayPort, type GatewayPort } from "./gateway-port.js";

afterEach(() => vi.useRealTimers());

describe("ReconnectingGatewayPort", () => {
  it("keeps listeners stable while replacing a failed transport", async () => {
    vi.useFakeTimers();
    const first = new FakeGateway("first");
    const second = new FakeGateway("second");
    const reconnect = vi.fn(async () => second);
    const gateway = new ReconnectingGatewayPort({
      initial: first,
      reconnect,
      retryDelaysMs: [10],
    });
    const restored = vi.fn();
    gateway.onConnectionRestored(restored);

    first.lose();
    await vi.advanceTimersByTimeAsync(10);

    await expect(
      gateway.request("host/ping", { version: 1 }, {}),
    ).resolves.toMatchObject({ hostId: "second" });
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(first.closed).toBe(true);
    await gateway.close();
    expect(second.closed).toBe(true);
  });

  it("retries transient failures but stops on reauthentication", async () => {
    vi.useFakeTimers();
    const first = new FakeGateway("first");
    const terminal = Object.assign(new Error("reauth"), {
      name: "GatewayReauthenticationRequiredError",
    });
    const reconnect = vi
      .fn<() => Promise<GatewayPort>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(terminal);
    const gateway = new ReconnectingGatewayPort({
      initial: first,
      reconnect,
      retryDelaysMs: [10],
    });
    first.lose();

    await vi.advanceTimersByTimeAsync(20);

    await expect(gateway.request("host/ping", { version: 1 }, {})).rejects.toBe(
      terminal,
    );
    expect(reconnect).toHaveBeenCalledTimes(2);
    await gateway.close();
  });
});

class FakeGateway implements GatewayPort {
  readonly #lost = new Set<(error: Error) => void>();
  readonly #events = new Set<(event: GatewayEventEnvelopeV2) => void>();
  closed = false;

  constructor(readonly id: string) {}

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    _options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "host/ping") throw new Error("Unexpected fake request");
    return Promise.resolve({
      version: 1,
      hostId: this.id,
      serverTime: "2026-01-01T00:00:00.000Z",
      gatewayApiVersion: 2,
    }) as Promise<OutputOf<Method>>;
  }

  onEvent(listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    this.#lost.add(listener);
    return () => this.#lost.delete(listener);
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {
    this.closed = true;
  }

  lose(): void {
    for (const listener of [...this.#lost]) listener(new Error("lost"));
  }
}
