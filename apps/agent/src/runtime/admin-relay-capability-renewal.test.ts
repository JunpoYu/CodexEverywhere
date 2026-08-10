import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import { loadAdminControllerConfig } from "../admin/controller-config.js";
import {
  inspectAdminRelayCapabilityRenewal,
  renewAdminRelayCapabilityIfNeeded,
  startAdminRelayCapabilityRenewalLoop,
} from "./admin-relay-capability-renewal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Administrator Controller Relay capability renewal", () => {
  it("persists the rotated credential before live control rotation and uses it after restart", async () => {
    const fixture = await configuredController();
    let durableAtRotation = false;
    const rotateRouteCapability = vi.fn(async (capability: string) => {
      durableAtRotation =
        (await loadAdminControllerConfig(fixture.configPath))
          .routeCapability === capability;
    });
    const loop = startAdminRelayCapabilityRenewalLoop(fixture.configPath, {
      initialCapability: fixture.oldRoute.capability,
      now: () => fixture.now,
      currentUser: fixture.currentUser,
      requestGrant: fixture.requestGrant,
      onConfig: async (config) => {
        if (config.routeCapability === fixture.oldRoute.capability) return;
        await rotateRouteCapability(config.routeCapability);
      },
    });
    try {
      await loop.checkNow();
    } finally {
      await loop.close();
    }

    expect(fixture.requestGrant).toHaveBeenCalledWith({
      renewalCapability: fixture.oldRoute.capability,
    });
    expect(rotateRouteCapability).toHaveBeenCalledOnce();
    expect(rotateRouteCapability).toHaveBeenCalledWith(
      fixture.renewed.capability,
    );
    expect(durableAtRotation).toBe(true);
    await expect(
      loadAdminControllerConfig(fixture.configPath),
    ).resolves.toMatchObject({
      routeId: fixture.oldRoute.payload.routeId,
      routeCapability: fixture.renewed.capability,
      nodeId: "admin-node",
    });
  });

  it("does not persist a grant that changes the route, handle, or Unix owner", async () => {
    const fixture = await configuredController();
    for (const grant of [
      {
        ...fixture.grant,
        routeId: "Z".repeat(32),
      },
      { ...fixture.grant, adminHandle: "other-admin" },
      { ...fixture.grant, uid: fixture.currentUser.uid + 1 },
    ]) {
      await expect(
        renewAdminRelayCapabilityIfNeeded(fixture.configPath, {
          now: () => fixture.now,
          currentUser: fixture.currentUser,
          requestGrant: async () => grant,
        }),
      ).rejects.toThrow();
      expect(
        (await loadAdminControllerConfig(fixture.configPath)).routeCapability,
      ).toBe(fixture.oldRoute.capability);
    }
  });

  it("uses the ordinary Agent renewal window and retry status for host-admin capabilities", async () => {
    const fixture = await configuredController();
    expect(
      inspectAdminRelayCapabilityRenewal(
        fixture.oldRoute.capability,
        fixture.now,
      ),
    ).toMatchObject({
      provisioned: true,
      renewalDue: true,
      remainingMs: 2 * 86_400_000,
    });
  });
});

async function configuredController() {
  const base = await mkdtemp(join(tmpdir(), "ce-admin-controller-renewal-"));
  temporaryDirectories.push(base);
  const configPath = join(base, "config.json");
  const relayKey = generateRelaySigningKey();
  const now = Date.now();
  const oldCredential = issueHostProvisionerCredential(relayKey, {
    installationId: "hpc-cluster-1",
    expiresAt: new Date(now + 2 * 86_400_000),
  });
  const oldRoute = issueProvisionedAdminRouteCapability(
    oldCredential,
    { adminHandle: "cluster-admin" },
    new Date(now),
  );
  const renewed = issueProvisionedAdminRouteCapability(
    issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(now + 365 * 86_400_000),
    }),
    {
      adminHandle: "cluster-admin",
      routeId: oldRoute.payload.routeId,
    },
    new Date(now),
  );
  const currentUser = {
    username: "ops",
    uid: process.getuid?.() ?? 501,
  };
  await writeFile(
    configPath,
    `${JSON.stringify({
      version: 1,
      adminHandle: "cluster-admin",
      runAsUser: currentUser.username,
      runAsUid: currentUser.uid,
      installationId: "hpc-cluster-1",
      serverName: "login-1",
      origin: "https://codex.example.com",
      rpId: "codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: oldRoute.payload.routeId,
      routeCapability: oldRoute.capability,
      nodeId: "admin-node",
      home: base,
    })}\n`,
    { mode: 0o600 },
  );
  const grant = {
    version: 1 as const,
    username: currentUser.username,
    uid: currentUser.uid,
    adminHandle: "cluster-admin",
    origin: "https://codex.example.com",
    relayEndpoint: "wss://codex.example.com/relay",
    routeId: oldRoute.payload.routeId,
    routeCapability: renewed.capability,
  };
  const requestGrant = vi.fn(async () => grant);
  return {
    configPath,
    now,
    currentUser,
    oldRoute,
    renewed,
    grant,
    requestGrant,
  };
}
