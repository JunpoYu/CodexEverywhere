import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import type {
  AdminControllerConfig,
  AdminInstallationV2,
} from "../admin/controller-config.js";
import { inspectAdminControllerAuthorizationStatus } from "./admin-controller-status.js";

afterEach(() => vi.useRealTimers());

describe("Administrator Controller authorization status", () => {
  it("reports the legacy root registration migration without breaking status", async () => {
    const fixture = controllerFixture();
    const status = await inspectAdminControllerAuthorizationStatus(
      fixture.config,
      {
        now: fixture.now,
        loadInstallation: async () => ({
          version: 1,
          adminHandle: fixture.config.adminHandle,
          runAsUser: fixture.config.runAsUser,
          runAsUid: fixture.config.runAsUid,
          installationId: fixture.config.installationId,
          serverName: fixture.config.serverName,
          home: fixture.config.home,
        }),
      },
    );

    expect(status.relayAuthorization).toContain("renewal due");
    expect(status.rootRegistration).toContain("MIGRATION REQUIRED");
  });

  it("requires the v2 root registration, Controller config, and current NSS tuple to agree", async () => {
    const fixture = controllerFixture();
    const matching: AdminInstallationV2 = {
      version: 2,
      adminHandle: fixture.config.adminHandle,
      runAsUser: fixture.config.runAsUser,
      runAsUid: fixture.config.runAsUid,
      runAsGid: 2001,
      runAsHome: "/public/home/alice",
      runAsShell: "/bin/bash",
      installationId: fixture.config.installationId,
      serverName: fixture.config.serverName,
      routeId: fixture.config.routeId,
      home: fixture.config.home,
    };
    const inspectAccount = async () => ({
      eligible: true as const,
      account: {
        username: "alice",
        uid: fixture.config.runAsUid,
        gid: 2001,
        home: "/public/home/alice",
        shell: "/bin/bash",
      },
    });

    await expect(
      inspectAdminControllerAuthorizationStatus(fixture.config, {
        now: fixture.now,
        loadInstallation: async () => matching,
        inspectAccount,
      }),
    ).resolves.toMatchObject({
      rootRegistration: "version 2 UID/NSS route binding available",
    });
    await expect(
      inspectAdminControllerAuthorizationStatus(fixture.config, {
        now: fixture.now,
        loadInstallation: async () => ({
          ...matching,
          routeId: "Z".repeat(32),
        }),
        inspectAccount,
      }),
    ).resolves.toMatchObject({
      rootRegistration: expect.stringContaining("INVALID"),
    });
  });
});

function controllerFixture(): { now: number; config: AdminControllerConfig } {
  const now = Date.now();
  const route = issueProvisionedAdminRouteCapability(
    issueHostProvisionerCredential(generateRelaySigningKey(), {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(now + 2 * 86_400_000),
    }),
    { adminHandle: "cluster-admin" },
    new Date(now),
  );
  return {
    now,
    config: {
      version: 1,
      adminHandle: "cluster-admin",
      runAsUser: "alice",
      runAsUid: 1001,
      installationId: "hpc-cluster-1",
      serverName: "login-1",
      origin: "https://codex.example.com",
      rpId: "codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: route.payload.routeId,
      routeCapability: route.capability,
      nodeId: "admin-node",
      home: "/var/lib/codex-everywhere/admin-controller",
    },
  };
}
