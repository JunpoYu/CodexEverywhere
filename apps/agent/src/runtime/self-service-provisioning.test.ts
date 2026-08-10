import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedRouteCapability,
} from "@codex-everywhere/protocol/relay-capability";

import {
  initializeHost,
  readHostConfig,
  updateHostConfig,
} from "../host/config.js";
import { resolveHostPaths } from "../host/paths.js";
import {
  applySelfProvisioningGrant,
  parseSelfProvisioningGrant,
} from "./self-service-provisioning.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("user self-service provisioning", () => {
  it("configures only the requesting Unix user's host state", async () => {
    const paths = await temporaryPaths();
    const grant = {
      ...selfProvisioningGrant("bob", 2025),
      defaultCodexNetwork: {
        mode: "proxy" as const,
        httpsProxy: "http://proxy.example.com:8080",
      },
    };

    await applySelfProvisioningGrant(paths, grant, {
      username: "bob",
      uid: 2025,
    });

    await expect(readHostConfig(paths)).resolves.toMatchObject({
      transport: {
        mode: "relay",
        endpoint: "wss://codex.example.com/relay",
        routeId: grant.routeId,
      },
      webAuthn: {
        origin: "https://codex.example.com",
        rpId: "codex.example.com",
      },
      network: {
        mode: "proxy",
        httpsProxy: "http://proxy.example.com:8080",
      },
    });
  });

  it("does not replace a user's existing network choice", async () => {
    const paths = await temporaryPaths();
    const existing = await initializeHost(paths);
    await updateHostConfig(paths, () => ({
      ...existing,
      network: { mode: "direct" },
    }));
    const grant = {
      ...selfProvisioningGrant("bob", 2025),
      defaultCodexNetwork: {
        mode: "proxy" as const,
        httpsProxy: "http://proxy.example.com:8080",
      },
    };

    await applySelfProvisioningGrant(paths, grant, {
      username: "bob",
      uid: 2025,
    });

    await expect(readHostConfig(paths)).resolves.toMatchObject({
      network: { mode: "direct" },
    });
  });

  it("rejects a grant issued to another Unix identity", async () => {
    const paths = await temporaryPaths();
    const grant = selfProvisioningGrant("alice", 1001);

    await expect(
      applySelfProvisioningGrant(paths, grant, {
        username: "bob",
        uid: 2025,
      }),
    ).rejects.toThrow("different Unix identity");
  });

  it("rejects a route ID that does not match its signed capability", () => {
    const grant = selfProvisioningGrant("bob", 2025);
    expect(() =>
      parseSelfProvisioningGrant({ ...grant, routeId: "A".repeat(32) }),
    ).toThrow("Invalid self-provisioning grant");
  });
});

function selfProvisioningGrant(username: string, uid: number) {
  const relayKey = generateRelaySigningKey();
  const credential = issueHostProvisionerCredential(relayKey, {
    installationId: "hpc-cluster-1",
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const route = issueProvisionedRouteCapability(credential, {
    loginName: username,
  });
  return {
    version: 1 as const,
    username,
    uid,
    origin: "https://codex.example.com",
    relayEndpoint: "wss://codex.example.com/relay",
    routeId: route.payload.routeId,
    routeCapability: route.capability,
  };
}

async function temporaryPaths() {
  const base = await mkdtemp(join(tmpdir(), "ce-self-service-test-"));
  temporaryDirectories.push(base);
  return resolveHostPaths({
    CE_HOME: join(base, "home"),
    CE_RUNTIME_DIR: join(base, "runtime"),
  });
}
