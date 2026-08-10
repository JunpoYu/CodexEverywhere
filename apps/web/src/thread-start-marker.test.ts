import { describe, expect, it } from "vitest";

import {
  clearUnresolvedThreadStartMarker,
  hasUnresolvedThreadStartMarker,
  markThreadStartUnresolved,
} from "./thread-start-marker.js";

type MarkerStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function memoryStorage(): MarkerStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("thread/start reload safety marker", () => {
  it("stores only a fixed versioned unresolved marker and clears it explicitly", () => {
    const storage = memoryStorage();

    markThreadStartUnresolved(storage);

    expect(hasUnresolvedThreadStartMarker(storage)).toBe(true);
    expect([...storage.values.values()]).toEqual([
      '{"version":1,"unresolved":true}',
    ]);
    clearUnresolvedThreadStartMarker(storage);
    expect(hasUnresolvedThreadStartMarker(storage)).toBe(false);
  });

  it("fails closed for an unrecognized value under the reserved marker key", () => {
    const storage = memoryStorage();
    storage.setItem("codex-everywhere:thread-start-unresolved", "future");

    expect(hasUnresolvedThreadStartMarker(storage)).toBe(true);
  });

  it("never crashes when session storage is unavailable", () => {
    const unavailable: MarkerStorage = {
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    };

    expect(() => markThreadStartUnresolved(unavailable)).not.toThrow();
    expect(hasUnresolvedThreadStartMarker(unavailable)).toBe(false);
    expect(() => clearUnresolvedThreadStartMarker(unavailable)).not.toThrow();
  });
});
