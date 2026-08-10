import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
  verifyRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import {
  assertSafeAdminInstallationFile,
  validateAdminInstallation,
  type AdminInstallationV2,
} from "./controller-config.js";
import { installHostProvisioner } from "./self-provision.js";
import { issueAdminRouteRenewalGrantForAccount } from "./admin-route-provisioning.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("administrator Relay route provisioning", () => {
  it("migrates an old credential once, then renews the bound route after that proof expires", async () => {
    const fixture = await fixtureWithRotatedCredential();
    const migrated = await issueAdminRouteRenewalGrantForAccount(
      fixture.account,
      fixture.options(fixture.migrationTime),
    );
    const afterRestart = await issueAdminRouteRenewalGrantForAccount(
      fixture.account,
      {
        ...fixture.options(fixture.afterOldExpiry),
        renewalCapability: fixture.oldRoute.capability,
      },
    );

    expect(migrated.routeId).toBe(fixture.oldRoute.payload.routeId);
    expect(afterRestart.routeId).toBe(fixture.oldRoute.payload.routeId);
    expect(
      verifyRouteCapability(
        afterRestart.routeCapability,
        fixture.relayKey,
        fixture.afterOldExpiry,
      ),
    ).toMatchObject({
      principal: "host-admin",
      loginName: "cluster-admin",
      routeId: fixture.oldRoute.payload.routeId,
      provisionerExpiresAt: fixture.nextCredential.expiresAt,
    });
    const registry = JSON.parse(
      await readFile(fixture.bindingsPath, "utf8"),
    ) as { bindings: unknown[] };
    expect(registry.bindings).toHaveLength(1);
  });

  it("rejects another request UID even when it presents the valid administrator capability", async () => {
    const fixture = await fixtureWithRotatedCredential();
    const foreignRegistration: AdminInstallationV2 = {
      ...fixture.installation,
      runAsUid: fixture.account.uid + 1,
    };

    await expect(
      issueAdminRouteRenewalGrantForAccount(fixture.account, {
        ...fixture.options(fixture.migrationTime),
        loadInstallation: async () => foreignRegistration,
      }),
    ).rejects.toThrow("does not match the root-registered");
  });

  it("rejects a root registration whose handle or route differs from the capability", async () => {
    const fixture = await fixtureWithRotatedCredential();
    await expect(
      issueAdminRouteRenewalGrantForAccount(fixture.account, {
        ...fixture.options(fixture.migrationTime),
        loadInstallation: async () => ({
          ...fixture.installation,
          adminHandle: "other-admin",
        }),
      }),
    ).rejects.toThrow("does not match root registration");
    await expect(
      issueAdminRouteRenewalGrantForAccount(fixture.account, {
        ...fixture.options(fixture.migrationTime),
        loadInstallation: async () => ({
          ...fixture.installation,
          routeId: "Z".repeat(32),
        }),
      }),
    ).rejects.toThrow("does not match root registration");
  });

  it("requires one root migration for legacy v1 registrations without breaking their loader", async () => {
    const legacy = validateAdminInstallation({
      version: 1,
      adminHandle: "cluster-admin",
      runAsUser: "ops",
      runAsUid: 1001,
      installationId: "hpc-cluster-1",
      serverName: "login-1",
      home: "/var/lib/codex-everywhere/admin-controller",
    });
    expect(legacy.version).toBe(1);

    const fixture = await fixtureWithRotatedCredential();
    await expect(
      issueAdminRouteRenewalGrantForAccount(fixture.account, {
        ...fixture.options(fixture.migrationTime),
        loadInstallation: async () => legacy,
      }),
    ).rejects.toThrow("rerun ce admin install-controller");
  });

  it("fails closed for a non-root-owned, writable, linked, or non-regular registration", () => {
    const safe = {
      isFile: () => true,
      nlink: 1,
      uid: 0,
      mode: 0o100644,
    };
    expect(() => assertSafeAdminInstallationFile(safe)).not.toThrow();
    for (const unsafe of [
      { ...safe, isFile: () => false },
      { ...safe, nlink: 2 },
      { ...safe, uid: 1001 },
      { ...safe, mode: 0o100664 },
      { ...safe, mode: 0o100600 },
    ]) {
      expect(() => assertSafeAdminInstallationFile(unsafe)).toThrow(
        "root-owned 0644",
      );
    }
  });
});

async function fixtureWithRotatedCredential() {
  const home = await mkdtemp(join(tmpdir(), "ce-admin-route-renewal-test-"));
  temporaryDirectories.push(home);
  const configPath = join(home, "provisioner.json");
  const bindingsPath = join(home, "admin-route-bindings.json");
  const relayKey = generateRelaySigningKey();
  const installedAt = new Date(Date.now() + 1_000);
  const migrationTime = new Date(installedAt.getTime() + 30_000);
  const afterOldExpiry = new Date(installedAt.getTime() + 60_001);
  const oldCredential = issueHostProvisionerCredential(relayKey, {
    installationId: "hpc-cluster-1",
    expiresAt: new Date(installedAt.getTime() + 60_000),
  });
  await installHostProvisioner(
    {
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      credential: oldCredential,
    },
    configPath,
    installedAt,
  );
  const oldRoute = issueProvisionedAdminRouteCapability(
    oldCredential,
    { adminHandle: "cluster-admin" },
    installedAt,
  );
  const nextCredential = issueHostProvisionerCredential(relayKey, {
    installationId: "hpc-cluster-1",
    expiresAt: new Date(installedAt.getTime() + 365 * 86_400_000),
  });
  await installHostProvisioner(
    {
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      credential: nextCredential,
    },
    configPath,
    migrationTime,
  );
  const account = {
    username: "ops",
    uid: process.getuid?.() ?? 501,
    gid: process.getgid?.() ?? 20,
    home,
    shell: "/bin/bash",
  };
  const installation: AdminInstallationV2 = {
    version: 2,
    adminHandle: "cluster-admin",
    runAsUser: account.username,
    runAsUid: account.uid,
    runAsGid: account.gid,
    runAsHome: account.home,
    runAsShell: account.shell,
    installationId: "hpc-cluster-1",
    serverName: "login-1",
    routeId: oldRoute.payload.routeId,
    home: join(home, "controller"),
  };
  const options = (now: Date) => ({
    configPath,
    adminInstallationPath: join(home, "root-registration.json"),
    adminRouteBindingsPath: bindingsPath,
    renewalCapability: oldRoute.capability,
    now,
    loadInstallation: async () => installation,
  });
  return {
    relayKey,
    nextCredential,
    oldRoute,
    account,
    installation,
    bindingsPath,
    migrationTime,
    afterOldExpiry,
    options,
  };
}
