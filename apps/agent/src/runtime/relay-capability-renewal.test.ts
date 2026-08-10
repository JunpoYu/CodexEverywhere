import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import {
  initializeHost,
  readHostConfig,
  relayTransport,
  updateHostConfig,
  withRelayTransport,
} from "../host/config.js";
import { resolveHostPaths } from "../host/paths.js";
import { relayCapabilityDoctorCheck } from "../host/doctor.js";
import {
  RELAY_CAPABILITY_RENEWAL_WINDOW_MS,
  inspectRelayCapabilityRenewal,
  relayCapabilityRenewalRetryDelay,
  renewRelayCapabilityIfNeeded,
  startRelayCapabilityRenewalLoop,
} from "./relay-capability-renewal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Relay capability renewal", () => {
  it("atomically persists a later capability without changing the random route", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now);
    const nextCredential = issueHostProvisionerCredential(fixture.relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(now + 365 * 86_400_000),
    });
    const renewed = issueProvisionedRouteCapability(
      nextCredential,
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    const requestGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "bob",
      uid: 2025,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    }));

    const result = await renewRelayCapabilityIfNeeded(fixture.paths, {
      now: () => now,
      requestGrant,
      currentUser: { username: "bob", uid: 2025 },
    });

    expect(result.state).toBe("renewed");
    expect(requestGrant).toHaveBeenCalledWith({
      renewalCapability: fixture.route.capability,
    });
    const stored = relayTransport(
      (await readHostConfig(fixture.paths)).transport,
    );
    expect(stored).toMatchObject({
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    });
  });

  it("rejects a provisioner response that tries to move SavedHost to another route", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now);
    const victim = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob" },
      new Date(now),
    );

    await expect(
      renewRelayCapabilityIfNeeded(fixture.paths, {
        now: () => now,
        requestGrant: async () => ({
          version: 1,
          username: "bob",
          uid: 2025,
          origin: "https://codex.example.com",
          relayEndpoint: "wss://codex.example.com/relay",
          routeId: victim.payload.routeId,
          routeCapability: victim.capability,
        }),
        currentUser: { username: "bob", uid: 2025 },
      }),
    ).rejects.toThrow("replace the Relay route ID");
    expect(
      relayTransport((await readHostConfig(fixture.paths)).transport)
        ?.routeCapability,
    ).toBe(fixture.route.capability);
  });

  it("invokes control rotation only after the new capability is durable", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now);
    const renewed = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    let observedDurable = false;
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      initialCapability: fixture.route.capability,
      now: () => now,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant: async () => ({
        version: 1,
        username: "bob",
        uid: 2025,
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        routeId: fixture.route.payload.routeId,
        routeCapability: renewed.capability,
      }),
      onConfig: async (config) => {
        const stored = relayTransport(
          (await readHostConfig(fixture.paths)).transport,
        );
        observedDurable =
          stored?.routeCapability === renewed.capability &&
          relayTransport(config.transport)?.routeCapability ===
            renewed.capability;
      },
    });
    try {
      await loop.checkNow();
    } finally {
      await loop.close();
    }

    expect(observedDurable).toBe(true);
  });

  it("waits for the operator when the provisioner has not rotated its credential", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now);
    const result = await renewRelayCapabilityIfNeeded(fixture.paths, {
      now: () => now,
      requestGrant: async () => ({
        version: 1,
        username: "bob",
        uid: 2025,
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        routeId: fixture.route.payload.routeId,
        routeCapability: fixture.route.capability,
      }),
      currentUser: { username: "bob", uid: 2025 },
    });

    expect(result.state).toBe("awaiting-provisioner");
    expect(
      relayTransport((await readHostConfig(fixture.paths)).transport)
        ?.routeCapability,
    ).toBe(fixture.route.capability);
  });

  it("warns thirty days early and retries forever with bounded urgency", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now);
    const status = inspectRelayCapabilityRenewal(fixture.route.capability, now);
    expect(status).toMatchObject({ provisioned: true, renewalDue: true });
    expect(relayCapabilityRenewalRetryDelay(status)).toBeGreaterThan(0);
    expect(relayCapabilityRenewalRetryDelay(status)).toBeLessThanOrEqual(
      12 * 60 * 60_000,
    );
    expect(RELAY_CAPABILITY_RENEWAL_WINDOW_MS).toBe(30 * 86_400_000);
    expect(
      relayCapabilityDoctorCheck(await readHostConfig(fixture.paths), now),
    ).toMatchObject({
      name: "Relay capability",
      ok: false,
      required: false,
      detail: expect.stringContaining("Agent is retrying"),
    });
    expect(
      relayCapabilityDoctorCheck(
        await readHostConfig(fixture.paths),
        now + 3 * 86_400_000,
      ),
    ).toMatchObject({
      name: "Relay capability",
      ok: false,
      required: true,
      detail: expect.stringContaining("expired"),
    });
  });

  it("retries a normal failure on the jittered twelve-hour tier instead of every five minutes", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now, 20 * 86_400_000);
    const status = inspectRelayCapabilityRenewal(fixture.route.capability, now);
    const expectedDelay = relayCapabilityRenewalRetryDelay(
      status,
      fixture.route.capability,
    );
    const requestGrant = vi.fn(async () => {
      throw new Error("provisioner busy");
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      now: () => now,
      initialCapability: fixture.route.capability,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant,
      onConfig: async () => undefined,
    });

    await loop.checkNow();
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(expectedDelay).toBeGreaterThanOrEqual(9 * 60 * 60_000);
    expect(expectedDelay).toBeLessThanOrEqual(12 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(expectedDelay - 1);
    expect(requestGrant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await loop.checkNow();
    expect(requestGrant).toHaveBeenCalledTimes(2);
    await loop.close();
  });

  it("starts renewal with enough safety margin when only sixty seconds remain", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now, 60_000);
    const renewed = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    const requestGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "bob",
      uid: 2025,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    }));
    const rotationTimes: number[] = [];
    const status = inspectRelayCapabilityRenewal(fixture.route.capability, now);
    const expectedDelay = relayCapabilityRenewalRetryDelay(
      status,
      fixture.route.capability,
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      initialCapability: fixture.route.capability,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant,
      onConfig: async () => {
        rotationTimes.push(Date.now());
      },
    });

    expect(expectedDelay).toBeGreaterThanOrEqual(0);
    expect(expectedDelay).toBeLessThanOrEqual(15_000);
    await vi.advanceTimersByTimeAsync(expectedDelay - 1);
    expect(requestGrant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await loop.checkNow();
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(rotationTimes[0]).toBeLessThan(now + 60_000);
    expect(
      relayCapabilityRenewalRetryDelay(
        { ...status, remainingMs: 0 },
        fixture.route.capability,
      ),
    ).toBe(0);
    expect(
      relayCapabilityRenewalRetryDelay(
        { ...status, remainingMs: 0 },
        fixture.route.capability,
        true,
      ),
    ).toBeGreaterThan(0);
    await loop.close();
  });

  it("tries immediately when less than the full safety budget remains", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now, 10_000);
    const renewed = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    const requestGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "bob",
      uid: 2025,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    }));
    const status = inspectRelayCapabilityRenewal(fixture.route.capability, now);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      initialCapability: fixture.route.capability,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant,
      onConfig: async () => undefined,
    });

    expect(
      relayCapabilityRenewalRetryDelay(status, fixture.route.capability),
    ).toBe(0);
    expect(
      relayCapabilityRenewalRetryDelay(status, fixture.route.capability, true),
    ).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(0);
    await loop.checkNow();
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(now);
    await loop.close();
  });

  it("repairs a persisted renewal before the active sixty-second capability expires", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now, 60_000);
    const renewed = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    const requestGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "bob",
      uid: 2025,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    }));
    const rotationTimes: number[] = [];
    const onConfig = vi.fn(async () => {
      rotationTimes.push(Date.now());
      if (rotationTimes.length === 1) {
        throw new Error("candidate registration failed");
      }
    });
    const oldStatus = inspectRelayCapabilityRenewal(
      fixture.route.capability,
      now,
    );
    const expectedDelay = relayCapabilityRenewalRetryDelay(
      oldStatus,
      fixture.route.capability,
      true,
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      initialCapability: fixture.route.capability,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant,
      onConfig,
    });

    await loop.checkNow();
    expect(
      relayTransport((await readHostConfig(fixture.paths)).transport)
        ?.routeCapability,
    ).toBe(renewed.capability);
    expect(expectedDelay).toBeLessThanOrEqual(15_000);
    await vi.advanceTimersByTimeAsync(expectedDelay);
    await loop.checkNow();
    expect(onConfig).toHaveBeenCalledTimes(2);
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(rotationTimes[1]).toBeLessThan(now + 60_000);
    await loop.close();
  });

  it("keeps critical retry urgency until a durably renewed capability rotates", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now, 12 * 60 * 60_000);
    const renewed = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    const requestGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "bob",
      uid: 2025,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    }));
    const onConfig = vi
      .fn<
        (config: Awaited<ReturnType<typeof readHostConfig>>) => Promise<void>
      >()
      .mockRejectedValueOnce(new Error("candidate registration failed"))
      .mockResolvedValue(undefined);
    const oldStatus = inspectRelayCapabilityRenewal(
      fixture.route.capability,
      now,
    );
    const expectedDelay = relayCapabilityRenewalRetryDelay(
      oldStatus,
      fixture.route.capability,
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      now: () => now,
      initialCapability: fixture.route.capability,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant,
      onConfig,
    });

    await loop.checkNow();
    expect(
      relayTransport((await readHostConfig(fixture.paths)).transport)
        ?.routeCapability,
    ).toBe(renewed.capability);
    expect(expectedDelay).toBeGreaterThanOrEqual(225_000);
    expect(expectedDelay).toBeLessThanOrEqual(300_000);
    await vi.advanceTimersByTimeAsync(expectedDelay);
    await loop.checkNow();
    expect(onConfig).toHaveBeenCalledTimes(2);
    expect(requestGrant).toHaveBeenCalledTimes(1);
    await loop.close();
  });

  it("waits for an in-flight check on close without applying or rotating afterward", async () => {
    const now = Date.now();
    const fixture = await configuredRelay(now);
    const renewed = issueProvisionedRouteCapability(
      issueHostProvisionerCredential(fixture.relayKey, {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(now + 365 * 86_400_000),
      }),
      { loginName: "bob", routeId: fixture.route.payload.routeId },
      new Date(now),
    );
    const grant = deferred<{
      version: 1;
      username: string;
      uid: number;
      origin: string;
      relayEndpoint: string;
      routeId: string;
      routeCapability: string;
    }>();
    const requestGrant = vi.fn(() => grant.promise);
    const onConfig = vi.fn(async () => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const loop = startRelayCapabilityRenewalLoop(fixture.paths, {
      now: () => now,
      initialCapability: fixture.route.capability,
      currentUser: { username: "bob", uid: 2025 },
      requestGrant,
      onConfig,
    });
    const checking = loop.checkNow();
    await vi.waitFor(() => expect(requestGrant).toHaveBeenCalledTimes(1));
    const closing = loop.close();
    grant.resolve({
      version: 1,
      username: "bob",
      uid: 2025,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: fixture.route.payload.routeId,
      routeCapability: renewed.capability,
    });

    await Promise.all([checking, closing]);
    await loop.checkNow();
    expect(onConfig).not.toHaveBeenCalled();
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      relayTransport((await readHostConfig(fixture.paths)).transport)
        ?.routeCapability,
    ).toBe(fixture.route.capability);
  });
});

async function configuredRelay(now: number, remainingMs = 2 * 86_400_000) {
  const base = await mkdtemp(join(tmpdir(), "ce-relay-renewal-test-"));
  temporaryDirectories.push(base);
  const paths = resolveHostPaths({
    CE_HOME: join(base, "home"),
    CE_RUNTIME_DIR: join(base, "runtime"),
  });
  const relayKey = generateRelaySigningKey();
  const credential = issueHostProvisionerCredential(relayKey, {
    installationId: "hpc-cluster-1",
    expiresAt: new Date(now + remainingMs),
  });
  const route = issueProvisionedRouteCapability(
    credential,
    { loginName: "bob" },
    new Date(now),
  );
  const config = await initializeHost(paths);
  await updateHostConfig(paths, () => ({
    ...config,
    transport: withRelayTransport(config.transport, {
      endpoint: "wss://codex.example.com/relay",
      routeId: route.payload.routeId,
      routeCapability: route.capability,
    }),
  }));
  return { paths, relayKey, route };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
