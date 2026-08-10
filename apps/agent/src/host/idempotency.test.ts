import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EphemeralIdempotencyRegistry,
  IdempotencyRegistry,
  usesEphemeralGatewayIdempotency,
} from "./idempotency.js";
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

  it("keeps secret-bearing gateway exchanges out of persistent replay", async () => {
    expect(usesEphemeralGatewayIdempotency("auth/login/verify")).toBe(true);
    expect(usesEphemeralGatewayIdempotency("codex/account/login/start")).toBe(
      true,
    );
    expect(usesEphemeralGatewayIdempotency("admin/recovery/start")).toBe(true);
    expect(usesEphemeralGatewayIdempotency("workspace/add")).toBe(false);

    const registry = new EphemeralIdempotencyRegistry();
    const request = {
      version: 1 as const,
      requestId: "request-1",
      idempotencyKey: "secret-request-key",
      method: "auth/login/verify",
      payload: { assertion: "hashed-not-retained" },
    };
    await expect(
      registry.execute(request, async () => ({
        authenticated: true,
        resumeToken: "RESUME-TOKEN-PLAINTEXT",
      })),
    ).resolves.toEqual({
      ok: true,
      result: {
        authenticated: true,
        resumeToken: "RESUME-TOKEN-PLAINTEXT",
      },
    });
    await expect(
      registry.execute(request, async () => ({ authenticated: true })),
    ).resolves.toEqual({
      ok: true,
      result: {
        authenticated: true,
        resumeToken: "RESUME-TOKEN-PLAINTEXT",
      },
    });
  });

  it("rejects an ephemeral idempotency key reused for another request", async () => {
    const registry = new EphemeralIdempotencyRegistry();
    const base = {
      version: 1 as const,
      requestId: "request-1",
      idempotencyKey: "shared-request-key",
      method: "auth/recover",
    };
    await registry.execute({ ...base, payload: { code: "one" } }, async () => ({
      registrationRequired: true,
    }));
    await expect(
      registry.execute({ ...base, payload: { code: "two" } }, async () => ({
        registrationRequired: true,
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("different request") },
    });
  });

  it("expires a secret result without requiring another request or transport close", async () => {
    vi.useFakeTimers();
    try {
      const registry = new EphemeralIdempotencyRegistry();
      const request = {
        version: 1 as const,
        requestId: "request-1",
        idempotencyKey: "expiring-secret-key",
        method: "auth/login/verify",
        payload: { response: "proof" },
      };
      let calls = 0;
      const operation = async () => ({ call: ++calls, resumeToken: "secret" });
      await registry.execute(request, operation);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
      await registry.execute(request, operation);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears expiry timers on LRU eviction and transport close", async () => {
    vi.useFakeTimers();
    try {
      const registry = new EphemeralIdempotencyRegistry(1);
      const request = (key: string) => ({
        version: 1 as const,
        requestId: key,
        idempotencyKey: key,
        method: "auth/login/verify",
        payload: {},
      });
      await registry.execute(request("first-secret-key"), async () => "one");
      expect(vi.getTimerCount()).toBe(1);
      await registry.execute(request("second-secret-key"), async () => "two");
      expect(vi.getTimerCount()).toBe(1);
      registry.clear();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
