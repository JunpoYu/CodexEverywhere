import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedRouteCapability,
  relayInstallationPrincipalLoginId,
  routeCapabilityLoginId,
  verifyRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import {
  installHostProvisioner,
  issueProvisioningGrantForAccount,
  issueSelfProvisioningGrant,
  loadHostProvisioner,
  pruneExpiredRenewalVerificationCredentials,
  setHostProvisionerDefaultCodexNetwork,
} from "./self-provision.js";
import { HostStateStore } from "../host/state-store.js";
import { AdminUserRegistry } from "./registry.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("host self-provisioner", () => {
  it("installs one private host credential and issues for the sudo Unix user", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "etc", "provisioner.json");
    const relayKey = generateRelaySigningKey();
    const credential = issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential,
        defaultCodexNetwork: {
          mode: "proxy",
          httpsProxy: "http://proxy.example.com:8080",
        },
      },
      configPath,
    );

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    await expect(loadHostProvisioner(configPath)).resolves.toMatchObject({
      credential: { installationId: "hpc-cluster-1" },
      defaultCodexNetwork: {
        mode: "proxy",
        httpsProxy: "http://proxy.example.com:8080",
      },
    });

    const uid = process.getuid?.() ?? 501;
    const grant = await issueSelfProvisioningGrant({
      env: { SUDO_USER: "bob", SUDO_UID: String(uid) },
      configPath,
      adminStatePath: join(home, "admin", "state.sqlite"),
      runGetent: async () =>
        `bob:x:${uid}:${process.getgid?.() ?? 20}::${home}:/bin/bash\n`,
    });
    const verified = verifyRouteCapability(grant.routeCapability, relayKey);

    expect(grant).toMatchObject({
      username: "bob",
      uid,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      defaultCodexNetwork: {
        mode: "proxy",
        httpsProxy: "http://proxy.example.com:8080",
      },
    });
    expect(routeCapabilityLoginId(verified, relayKey)).toBe(
      relayInstallationPrincipalLoginId(
        relayKey,
        "hpc-cluster-1",
        "user",
        "bob",
      ),
    );
  });

  it("updates the deployment default without replacing its credential", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "etc", "provisioner.json");
    const relayKey = generateRelaySigningKey();
    const credential = issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential,
      },
      configPath,
    );

    await setHostProvisionerDefaultCodexNetwork(
      { mode: "proxy", httpsProxy: "http://proxy.example.com:8080" },
      configPath,
    );

    await expect(loadHostProvisioner(configPath)).resolves.toMatchObject({
      credential: { installationId: "hpc-cluster-1" },
      defaultCodexNetwork: {
        mode: "proxy",
        httpsProxy: "http://proxy.example.com:8080",
      },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("migrates an existing valid capability once and renews the same random route after restart", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "provisioner.json");
    const statePath = join(home, "state.sqlite");
    const bindingsPath = join(home, "route-bindings.json");
    const relayKey = generateRelaySigningKey();
    const oldCredential = issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 20 * 86_400_000),
    });
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential: oldCredential,
      },
      configPath,
    );
    const account = currentAccount("bob", home);
    const legacyGrant = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
    });
    const nextCredential = issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 400 * 86_400_000),
    });
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential: nextCredential,
      },
      configPath,
    );

    const migrated = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
      renewalCapability: legacyGrant.routeCapability,
    });
    const afterRestart = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
      renewalCapability: migrated.routeCapability,
    });

    expect(migrated.routeId).toBe(legacyGrant.routeId);
    expect(afterRestart.routeId).toBe(legacyGrant.routeId);
    expect(
      verifyRouteCapability(afterRestart.routeCapability, relayKey),
    ).toMatchObject({
      routeId: legacyGrant.routeId,
      provisionerExpiresAt: nextCredential.expiresAt,
    });
    expect((await stat(bindingsPath)).mode & 0o777).toBe(0o600);
  });

  it("never accepts another user's route ID from the renewal payload", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "provisioner.json");
    const statePath = join(home, "state.sqlite");
    const bindingsPath = join(home, "route-bindings.json");
    const credential = issueHostProvisionerCredential(
      generateRelaySigningKey(),
      {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    );
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential,
      },
      configPath,
    );
    const account = currentAccount("bob", home);
    const victim = issueProvisionedRouteCapability(credential, {
      loginName: "alice",
    });

    await expect(
      issueProvisioningGrantForAccount(account, {
        configPath,
        adminStatePath: statePath,
        routeBindingsPath: bindingsPath,
        renewalCapability: victim.capability,
      }),
    ).rejects.toThrow("cannot prove this route");
    const bound = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
    });
    await expect(
      issueProvisioningGrantForAccount(account, {
        configPath,
        adminStatePath: statePath,
        routeBindingsPath: bindingsPath,
        renewalCapability: victim.capability,
      }),
    ).rejects.toThrow("does not match the bound route");
    const renewed = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
      renewalCapability: bound.routeCapability,
    });
    expect(renewed.routeId).toBe(bound.routeId);
  });

  it("rejects UID or username reuse before consulting the route registry", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "provisioner.json");
    const statePath = join(home, "state.sqlite");
    const bindingsPath = join(home, "route-bindings.json");
    const credential = issueHostProvisionerCredential(
      generateRelaySigningKey(),
      {
        installationId: "hpc-cluster-1",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    );
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential,
      },
      configPath,
    );
    await issueProvisioningGrantForAccount(currentAccount("bob", home), {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
    });

    await expect(
      issueProvisioningGrantForAccount(currentAccount("alice", home), {
        configPath,
        adminStatePath: statePath,
        routeBindingsPath: bindingsPath,
      }),
    ).rejects.toThrow("identity conflicts");
    await expect(
      issueProvisioningGrantForAccount(
        {
          ...currentAccount("bob", home),
          uid: (process.getuid?.() ?? 501) + 1,
        },
        {
          configPath,
          adminStatePath: statePath,
          routeBindingsPath: bindingsPath,
        },
      ),
    ).rejects.toThrow("home is not owned");
  });

  it("treats an identical NSS tuple as the same principal and renews an expired route proof", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "provisioner.json");
    const statePath = join(home, "state.sqlite");
    const bindingsPath = join(home, "route-bindings.json");
    const relayKey = generateRelaySigningKey();
    const now = new Date();
    const credential = issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential,
      },
      configPath,
      now,
    );
    const account = currentAccount("bob", home);
    const initial = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
      now,
    });
    const retriedInitialization = await issueProvisioningGrantForAccount(
      account,
      {
        configPath,
        adminStatePath: statePath,
        routeBindingsPath: bindingsPath,
        now,
      },
    );
    const shortLived = issueProvisionedRouteCapability(
      credential,
      {
        loginName: "bob",
        routeId: initial.routeId,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      now,
    );
    const renewed = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      routeBindingsPath: bindingsPath,
      renewalCapability: shortLived.capability,
      now: new Date(now.getTime() + 60_001),
    });

    expect(retriedInitialization.routeId).toBe(initial.routeId);
    expect(renewed.routeId).toBe(initial.routeId);
    expect(
      verifyRouteCapability(
        renewed.routeCapability,
        relayKey,
        new Date(now.getTime() + 60_001),
      ),
    ).toMatchObject({ routeId: initial.routeId, loginName: "bob" });
  });

  it("does not use an expired old credential to bootstrap a route binding", async () => {
    const home = await temporaryDirectory();
    const configPath = join(home, "provisioner.json");
    const statePath = join(home, "state.sqlite");
    const bindingsPath = join(home, "route-bindings.json");
    const relayKey = generateRelaySigningKey();
    const installedAt = new Date();
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
    const account = currentAccount("bob", home);
    const oldGrant = await issueProvisioningGrantForAccount(account, {
      configPath,
      adminStatePath: statePath,
      now: installedAt,
    });
    const nextCredential = issueHostProvisionerCredential(relayKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(installedAt.getTime() + 86_400_000),
    });
    await installHostProvisioner(
      {
        origin: "https://codex.example.com",
        relayEndpoint: "wss://codex.example.com/relay",
        credential: nextCredential,
      },
      configPath,
      new Date(installedAt.getTime() + 30_000),
    );

    await expect(
      issueProvisioningGrantForAccount(account, {
        configPath,
        adminStatePath: statePath,
        routeBindingsPath: bindingsPath,
        renewalCapability: oldGrant.routeCapability,
        now: new Date(installedAt.getTime() + 60_001),
      }),
    ).rejects.toThrow("cannot prove this route");
    await expect(
      pruneExpiredRenewalVerificationCredentials(
        configPath,
        new Date(installedAt.getTime() + 60_001),
      ),
    ).resolves.toBe(true);
    expect(await readPrivateJson(configPath)).not.toHaveProperty(
      "renewalVerificationCredentials",
    );
  });

  it("rejects a sudo identity that does not match NSS", async () => {
    const home = await temporaryDirectory();
    const uid = process.getuid?.() ?? 501;

    await expect(
      issueSelfProvisioningGrant({
        env: { SUDO_USER: "bob", SUDO_UID: String(uid + 1) },
        configPath: join(home, "missing.json"),
        runGetent: async () =>
          `bob:x:${uid}:${process.getgid?.() ?? 20}::${home}:/bin/bash\n`,
      }),
    ).rejects.toThrow("does not match");
  });

  it("cannot be invoked by an ordinary root shell without sudo identity", async () => {
    await expect(issueSelfProvisioningGrant({ env: {} })).rejects.toThrow(
      "installed sudo helper",
    );
  });

  it.each(["disabled", "removal_pending", "removing", "removed"] as const)(
    "rejects self-provisioning while administrator status is %s",
    async (status) => {
      const home = await temporaryDirectory();
      const configPath = join(home, "etc", "provisioner.json");
      const adminStatePath = join(home, "admin", "state.sqlite");
      const uid = process.getuid?.() ?? 501;
      const gid = process.getgid?.() ?? 20;
      const credential = issueHostProvisionerCredential(
        generateRelaySigningKey(),
        {
          installationId: "hpc-cluster-1",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      );
      await installHostProvisioner(
        {
          origin: "https://codex.example.com",
          relayEndpoint: "wss://codex.example.com/relay",
          credential,
        },
        configPath,
      );
      const state = await HostStateStore.open(adminStatePath);
      const registry = new AdminUserRegistry(state);
      const registered = await registry.register({
        username: "bob",
        uid,
        gid,
        home,
        shell: "/bin/bash",
      });
      await registry.setStatus({
        username: "bob",
        expectedRevision: registered.revision,
        status,
      });
      await state.close();

      await expect(
        issueSelfProvisioningGrant({
          env: { SUDO_USER: "bob", SUDO_UID: String(uid) },
          configPath,
          adminStatePath,
          runGetent: async () => `bob:x:${uid}:${gid}::${home}:/bin/bash\n`,
        }),
      ).rejects.toThrow("disabled");
    },
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-self-provision-test-"));
  temporaryDirectories.push(path);
  return path;
}

function currentAccount(username: string, home: string) {
  return {
    username,
    uid: process.getuid?.() ?? 501,
    gid: process.getgid?.() ?? 20,
    home,
    shell: "/bin/bash",
  };
}

async function readPrivateJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
