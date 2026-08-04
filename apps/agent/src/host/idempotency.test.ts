import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { IdempotencyRegistry } from "./idempotency.js";
import { HostStateStore } from "./state-store.js";

describe("IdempotencyRegistry", () => {
  let directory: string | undefined;
  let state: HostStateStore | undefined;

  afterEach(async () => {
    await state?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("runs concurrent and later retries only once per device", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    let calls = 0;
    const operation = async () => ({ call: ++calls });
    const [first, concurrent] = await Promise.all([
      registry.execute("device-a", "request-key", operation),
      registry.execute("device-a", "request-key", operation),
    ]);
    const later = await registry.execute("device-a", "request-key", operation);
    const otherDevice = await registry.execute(
      "device-b",
      "request-key",
      operation,
    );
    expect(first).toEqual(concurrent);
    expect(later).toEqual(first);
    expect(otherDevice).not.toEqual(first);
    expect(calls).toBe(2);
  });
});
