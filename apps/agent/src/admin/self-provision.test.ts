import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  relayLoginId,
  routeCapabilityLoginId,
  verifyRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import {
  installHostProvisioner,
  issueSelfProvisioningGrant,
  loadHostProvisioner,
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
          httpsProxy: "http://127.0.0.1:7890",
        },
      },
      configPath,
    );

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    await expect(loadHostProvisioner(configPath)).resolves.toMatchObject({
      credential: { installationId: "hpc-cluster-1" },
      defaultCodexNetwork: {
        mode: "proxy",
        httpsProxy: "http://127.0.0.1:7890",
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
        httpsProxy: "http://127.0.0.1:7890",
      },
    });
    expect(routeCapabilityLoginId(verified, relayKey)).toBe(
      relayLoginId(relayKey, "bob"),
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
      { mode: "proxy", httpsProxy: "http://127.0.0.1:7890" },
      configPath,
    );

    await expect(loadHostProvisioner(configPath)).resolves.toMatchObject({
      credential: { installationId: "hpc-cluster-1" },
      defaultCodexNetwork: {
        mode: "proxy",
        httpsProxy: "http://127.0.0.1:7890",
      },
    });
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
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
