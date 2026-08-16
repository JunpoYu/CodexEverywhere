import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "./typed-event-bus.js";

interface Events {
  ready: { id: string };
  stopped: undefined;
}

describe("TypedEventBus", () => {
  it("delivers events synchronously in subscription order", () => {
    const bus = new TypedEventBus<Events>();
    const seen: string[] = [];
    bus.on("ready", ({ id }) => seen.push(`first:${id}`));
    bus.on("ready", ({ id }) => seen.push(`second:${id}`));

    bus.emit("ready", { id: "task-1" });

    expect(seen).toEqual(["first:task-1", "second:task-1"]);
  });

  it("uses a listener snapshot when subscriptions change during emit", () => {
    const bus = new TypedEventBus<Events>();
    const second = vi.fn();
    let removeSecond = (): void => undefined;
    bus.on("ready", () => removeSecond());
    removeSecond = bus.on("ready", second);

    bus.emit("ready", { id: "first" });
    bus.emit("ready", { id: "second" });

    expect(second).toHaveBeenCalledOnce();
  });

  it("supports once and explicit unsubscription", () => {
    const bus = new TypedEventBus<Events>();
    const once = vi.fn();
    const persistent = vi.fn();
    bus.once("stopped", once);
    const unsubscribe = bus.on("stopped", persistent);

    bus.emit("stopped", undefined);
    unsubscribe();
    bus.emit("stopped", undefined);

    expect(once).toHaveBeenCalledOnce();
    expect(persistent).toHaveBeenCalledOnce();
    expect(bus.listenerCount("stopped")).toBe(0);
  });

  it("finishes delivery before aggregating listener errors", () => {
    const bus = new TypedEventBus<Events>();
    const finalListener = vi.fn();
    bus.on("stopped", () => {
      throw new Error("failed");
    });
    bus.on("stopped", finalListener);

    expect(() => bus.emit("stopped", undefined)).toThrow(AggregateError);
    expect(finalListener).toHaveBeenCalledOnce();
  });
});
