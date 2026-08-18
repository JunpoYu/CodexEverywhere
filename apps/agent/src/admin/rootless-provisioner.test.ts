import { randomUUID } from "node:crypto";

import {
  NoiseInitiator,
  base64UrlToBytes,
  generateStaticKeyPair,
} from "@codex-everywhere/crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createRootlessProvisioningResponse,
  type RootlessProvisionerPaths,
  validateRootlessRequestFile,
} from "./rootless-provisioner.js";
import {
  ROOTLESS_PROVISIONING_VERSION,
  decodeHandshake,
  encodeHandshake,
  parseRootlessProvisioningResponse,
  rootlessProvisioningPrologue,
  type RootlessProvisioningRequest,
} from "../runtime/rootless-provisioning-protocol.js";

const NOW = Date.parse("2026-08-06T06:00:00.000Z");

describe("rootless Unix-user provisioner", () => {
  it("accepts only a private single-link regular file owned by another user", () => {
    const valid = {
      isFile: () => true,
      nlink: 1,
      uid: 1003,
      mode: 0o100644,
      size: 1024,
    };
    expect(() => validateRootlessRequestFile(valid, 1051)).not.toThrow();
    for (const invalid of [
      { ...valid, isFile: () => false },
      { ...valid, nlink: 2 },
      { ...valid, uid: 0 },
      { ...valid, uid: 1051 },
      { ...valid, mode: 0o100664 },
      { ...valid, size: 0 },
    ]) {
      expect(() => validateRootlessRequestFile(invalid, 1051)).toThrow(
        "Unsafe rootless provisioning request file",
      );
    }
  });

  it("binds the encrypted grant to the authenticated request file owner", async () => {
    const server = generateStaticKeyPair();
    const { initiator, raw, requestId } = createRequest(server.publicKey);
    const inspectAccount = vi.fn(async (uid: number) => ({
      eligible: true as const,
      account: {
        username: "alice",
        uid,
        gid: 100,
        home: "/public/home/alice",
        shell: "/bin/bash",
      },
    }));
    const grant = {
      version: 1 as const,
      username: "alice",
      uid: 1003,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: "route-1",
      routeCapability: "capability",
    };
    const issueGrant = vi.fn(async () => grant);

    const completed = await createRootlessProvisioningResponse(
      raw,
      1003,
      paths(),
      server,
      { now: NOW, inspectAccount, issueGrant },
    );

    expect(completed.requestId).toBe(requestId);
    expect(inspectAccount).toHaveBeenCalledWith(1003);
    expect(issueGrant).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", uid: 1003 }),
      expect.objectContaining({
        configPath: "/service/config.json",
        adminStatePath: "/service/admin-state.sqlite",
      }),
    );
    const response = parseRootlessProvisioningResponse(completed.response);
    const opened = initiator.finish(decodeHandshake(response.handshake));
    expect(JSON.parse(Buffer.from(opened.payload).toString("utf8"))).toEqual({
      ok: true,
      grant,
    });
  });

  it("returns eligibility failures only inside the authenticated response", async () => {
    const server = generateStaticKeyPair();
    const { initiator, raw } = createRequest(server.publicKey);
    const completed = await createRootlessProvisioningResponse(
      raw,
      1004,
      paths(),
      server,
      {
        now: NOW,
        inspectAccount: async () => ({
          eligible: false as const,
          reason: "Unix account has no login shell",
        }),
      },
    );
    const opened = initiator.finish(
      decodeHandshake(completed.response.handshake),
    );
    expect(JSON.parse(Buffer.from(opened.payload).toString("utf8"))).toEqual({
      ok: false,
      error: "Unix account is not eligible: Unix account has no login shell",
    });
  });

  it("returns an actionable error for an incompatible legacy admin database", async () => {
    const server = generateStaticKeyPair();
    const { initiator, raw } = createRequest(server.publicKey);
    const completed = await createRootlessProvisioningResponse(
      raw,
      1003,
      paths(),
      server,
      {
        now: NOW,
        inspectAccount: async (uid) => ({
          eligible: true as const,
          account: {
            username: "alice",
            uid,
            gid: 100,
            home: "/public/home/alice",
            shell: "/bin/bash",
          },
        }),
        issueGrant: async () => {
          throw new Error("State database kind mismatch: expected admin");
        },
      },
    );
    const opened = initiator.finish(
      decodeHandshake(completed.response.handshake),
    );
    expect(JSON.parse(Buffer.from(opened.payload).toString("utf8"))).toEqual({
      ok: false,
      error:
        "Host provisioning state is incompatible with this release; follow the documented fresh-state cutover before retrying",
    });
  });

  it("passes an encrypted Relay renewal proof only to the UID-bound issuer", async () => {
    const server = generateStaticKeyPair();
    const { initiator, raw } = createRequest(server.publicKey, NOW, {
      operation: "renew-relay",
      routeCapability: "private-current-capability",
    });
    const issueGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "alice",
      uid: 1003,
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: "A".repeat(32),
      routeCapability: "renewed-capability",
    }));
    const completed = await createRootlessProvisioningResponse(
      raw,
      1003,
      paths(),
      server,
      {
        now: NOW,
        inspectAccount: async (uid) => ({
          eligible: true as const,
          account: {
            username: "alice",
            uid,
            gid: 100,
            home: "/public/home/alice",
            shell: "/bin/bash",
          },
        }),
        issueGrant,
      },
    );

    expect(issueGrant).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", uid: 1003 }),
      expect.objectContaining({
        renewalCapability: "private-current-capability",
        routeBindingsPath: "/service/route-bindings.json",
      }),
    );
    const opened = initiator.finish(
      decodeHandshake(completed.response.handshake),
    );
    expect(JSON.parse(Buffer.from(opened.payload).toString("utf8"))).toEqual({
      ok: true,
      grant: expect.objectContaining({ routeCapability: "renewed-capability" }),
    });
  });

  it("routes administrator renewal only to the root-registered UID-bound issuer", async () => {
    const server = generateStaticKeyPair();
    const { initiator, raw } = createRequest(server.publicKey, NOW, {
      operation: "renew-admin-relay",
      routeCapability: "private-admin-capability",
    });
    const issueGrant = vi.fn();
    const issueAdminGrant = vi.fn(async () => ({
      version: 1 as const,
      username: "alice",
      uid: 1003,
      adminHandle: "cluster-admin",
      origin: "https://codex.example.com",
      relayEndpoint: "wss://codex.example.com/relay",
      routeId: "A".repeat(32),
      routeCapability: "renewed-admin-capability",
    }));
    const completed = await createRootlessProvisioningResponse(
      raw,
      1003,
      paths(),
      server,
      {
        now: NOW,
        inspectAccount: async (uid) => ({
          eligible: true as const,
          account: {
            username: "alice",
            uid,
            gid: 100,
            home: "/public/home/alice",
            shell: "/bin/bash",
          },
        }),
        issueGrant,
        issueAdminGrant,
      },
    );

    expect(issueGrant).not.toHaveBeenCalled();
    expect(issueAdminGrant).toHaveBeenCalledWith(
      expect.objectContaining({ username: "alice", uid: 1003 }),
      expect.objectContaining({
        adminInstallationPath: "/etc/codex-everywhere-admin-controller.json",
        adminRouteBindingsPath: "/service/admin-route-bindings.json",
        renewalCapability: "private-admin-capability",
      }),
    );
    const opened = initiator.finish(
      decodeHandshake(completed.response.handshake),
    );
    expect(JSON.parse(Buffer.from(opened.payload).toString("utf8"))).toEqual({
      ok: true,
      grant: expect.objectContaining({
        routeCapability: "renewed-admin-capability",
      }),
    });
  });

  it("rejects expired and clear/authenticated payload mismatches", async () => {
    const server = generateStaticKeyPair();
    const expired = createRequest(server.publicKey, NOW - 2 * 60 * 1_000 - 1);
    await expect(
      createRootlessProvisioningResponse(expired.raw, 1003, paths(), server, {
        now: NOW,
      }),
    ).rejects.toThrow("expired");

    const mismatched = createRequest(server.publicKey);
    const parsed = JSON.parse(mismatched.raw) as RootlessProvisioningRequest;
    parsed.createdAt = new Date(NOW - 1_000).toISOString();
    await expect(
      createRootlessProvisioningResponse(
        JSON.stringify(parsed),
        1003,
        paths(),
        server,
        { now: NOW },
      ),
    ).rejects.toThrow("payload mismatch");
  });
});

function createRequest(
  serverPublicKey: Uint8Array,
  now = NOW,
  payload: Record<string, unknown> = {},
) {
  const requestId = randomUUID();
  const createdAt = new Date(now).toISOString();
  const initiator = new NoiseInitiator(
    generateStaticKeyPair(),
    base64UrlToBytes(Buffer.from(serverPublicKey).toString("base64url")),
    rootlessProvisioningPrologue(requestId),
  );
  const request: RootlessProvisioningRequest = {
    version: ROOTLESS_PROVISIONING_VERSION,
    requestId,
    createdAt,
    handshake: encodeHandshake(
      initiator.start(
        Buffer.from(
          JSON.stringify({ requestId, createdAt, ...payload }),
          "utf8",
        ),
      ),
    ),
  };
  return { requestId, initiator, raw: JSON.stringify(request) };
}

function paths(): RootlessProvisionerPaths {
  return {
    home: "/service",
    configFile: "/service/config.json",
    configMutationLock: "/service/config.mutation.lock",
    routeBindingsFile: "/service/route-bindings.json",
    adminRouteBindingsFile: "/service/admin-route-bindings.json",
    adminInstallationFile: "/etc/codex-everywhere-admin-controller.json",
    adminStateFile: "/service/admin-state.sqlite",
    keysDirectory: "/service/keys",
    logsDirectory: "/service/logs",
    watchdogScript: "/service/bin/watchdog.sh",
    runtimeDirectory: "/tmp/provisioner",
    requestsDirectory: "/tmp/provisioner/requests",
    responsesDirectory: "/tmp/provisioner/responses",
    descriptorFile: "/tmp/provisioner/descriptor.json",
    lockFile: "/tmp/provisioner/lock",
    pidFile: "/tmp/provisioner/pid",
  };
}
