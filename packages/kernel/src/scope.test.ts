import { describe, expect, it, vi } from "vitest";
import { Scope, ScopeClosedError } from "./scope.js";

describe("Scope", () => {
  it("aborts first and releases resources in reverse order", async () => {
    const scope = new Scope("root");
    const events: string[] = [];
    scope.signal.addEventListener("abort", () => events.push("abort"));
    scope.defer(() => {
      events.push("first");
    });
    scope.defer(async () => {
      await Promise.resolve();
      events.push("second");
    });

    await scope.close("finished");

    expect(events).toEqual(["abort", "second", "first"]);
    expect(scope.signal.reason).toBe("finished");
    expect(scope.closed).toBe(true);
  });

  it("closes child scopes and owned resources", async () => {
    const parent = new Scope("parent");
    const child = parent.fork("child");
    const dispose = vi.fn();
    child.own({ dispose });

    await parent.close();

    expect(dispose).toHaveBeenCalledOnce();
    expect(child.closed).toBe(true);
  });

  it("is idempotent while asynchronous disposal is running", async () => {
    const scope = new Scope("root");
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    scope.defer(() => barrier);

    const first = scope.close();
    const second = scope.close();
    expect(first).toBe(second);
    release?.();
    await Promise.all([first, second]);
  });

  it("runs every disposer and aggregates failures", async () => {
    const scope = new Scope("root");
    const last = vi.fn();
    scope.defer(last);
    scope.defer(() => {
      throw new Error("second failed");
    });
    scope.defer(() => {
      throw new Error("third failed");
    });

    const error = await scope.close().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(last).toHaveBeenCalledOnce();
  });

  it("owns event listeners and timers", async () => {
    vi.useFakeTimers();
    try {
      const scope = new Scope("root");
      const target = new EventTarget();
      const listener = vi.fn();
      const timeout = vi.fn();
      const interval = vi.fn();
      scope.listen(target, "change", listener);
      scope.setTimeout(timeout, 10);
      scope.setInterval(interval, 5);

      target.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(5);
      expect(listener).toHaveBeenCalledOnce();
      expect(interval).toHaveBeenCalledOnce();

      await scope.close();
      target.dispatchEvent(new Event("change"));
      await vi.advanceTimersByTimeAsync(20);
      expect(listener).toHaveBeenCalledOnce();
      expect(timeout).not.toHaveBeenCalled();
      expect(interval).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects resources registered after shutdown begins", async () => {
    const scope = new Scope("root");
    const closing = scope.close();
    expect(() => scope.defer(() => undefined)).toThrow(ScopeClosedError);
    await closing;
  });
});
