import { describe, expect, it } from "vitest";
import {
  DuplicateServiceError,
  MissingServiceError,
  ServiceRegistry,
  createServiceToken,
} from "./service-registry.js";

describe("ServiceRegistry", () => {
  it("resolves a service through its typed token", () => {
    const clock = createServiceToken<{ now(): number }>("clock");
    const service = { now: () => 42 };
    const registry = new ServiceRegistry().register(clock, service).seal();

    expect(registry.get(clock)).toBe(service);
    expect(registry.get(clock).now()).toBe(42);
    expect(registry.sealed).toBe(true);
  });

  it("fails immediately for duplicate and missing registrations", () => {
    const clock = createServiceToken<number>("clock");
    const registry = new ServiceRegistry().register(clock, 1);

    expect(() => registry.register(clock, 2)).toThrow(DuplicateServiceError);
    expect(() => registry.get(createServiceToken<string>("missing"))).toThrow(
      MissingServiceError,
    );
  });

  it("does not accept registrations after composition is sealed", () => {
    const registry = new ServiceRegistry().seal();
    expect(() =>
      registry.register(createServiceToken("late"), new Object()),
    ).toThrow("Service registry is sealed");
  });

  it("rejects an empty token description", () => {
    expect(() => createServiceToken("  ")).toThrow(TypeError);
  });
});
