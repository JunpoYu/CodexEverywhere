import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "../host/state-store.js";
import { AdminUserRegistry } from "./registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("AdminUserRegistry", () => {
  it("rejects silent reuse of a managed Unix identity tuple", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-admin-identity-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new AdminUserRegistry(state);
    const alice = {
      username: "alice",
      uid: 1003,
      gid: 1003,
      home: "/home/alice",
      shell: "/bin/bash",
    };
    const registered = await registry.register(alice);

    await expect(registry.register(alice)).resolves.toEqual(registered);
    await expect(
      registry.register({
        ...alice,
        username: "bob",
        home: "/home/bob",
      }),
    ).rejects.toThrow("identity conflicts");
    await expect(
      registry.register({ ...alice, uid: 1004, gid: 1004 }),
    ).rejects.toThrow("identity conflicts");
    await expect(
      registry.register({ ...alice, home: "/srv/home/alice" }),
    ).rejects.toThrow("identity conflicts");
    await expect(registry.list()).resolves.toEqual([registered]);
    await state.close();
  });

  it("uses revisions to prevent concurrent administrators from overwriting state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-admin-registry-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new AdminUserRegistry(state);
    const registered = await registry.register({
      username: "alice",
      uid: 1003,
      gid: 1003,
      home: "/home/alice",
      shell: "/bin/bash",
    });
    const disabled = await registry.setStatus({
      username: "alice",
      expectedRevision: registered.revision,
      status: "disabled",
    });

    expect(disabled).toMatchObject({ status: "disabled", revision: 2 });
    await expect(
      registry.setStatus({
        username: "alice",
        expectedRevision: registered.revision,
        status: "enabled",
      }),
    ).rejects.toThrow("current revision 2");
    await state.close();
  });

  it("stores only management metadata in its audit trail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-admin-audit-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new AdminUserRegistry(state);
    await registry.audit({
      requestId: "request-1",
      actor: "device:browser-1",
      action: "admin/user/disable",
      targetUsername: "alice",
      result: "succeeded",
    });

    await expect(registry.listAudit()).resolves.toEqual([
      expect.objectContaining({
        requestId: "request-1",
        actor: "device:browser-1",
        action: "admin/user/disable",
        targetUsername: "alice",
        result: "succeeded",
      }),
    ]);
    await state.close();
  });

  it("fails an expired pending idempotency claim without reassigning it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-admin-claim-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new AdminUserRegistry(state);
    const requestId = "00000000-0000-0000-0000-000000000005";
    const fingerprint = "fingerprint-1";

    await expect(
      registry.claimIdempotent(
        requestId,
        fingerprint,
        "crashed-owner",
        new Date("2026-08-01T00:00:00.000Z"),
      ),
    ).resolves.toEqual({ status: "claimed" });
    await expect(
      registry.claimIdempotent(
        requestId,
        fingerprint,
        "replacement-owner",
        new Date("2026-08-01T00:03:00.000Z"),
      ),
    ).resolves.toEqual({
      status: "failed",
      error: {
        message: expect.stringContaining("external outcome is unknown"),
      },
    });
    await expect(
      registry.claimIdempotent(
        requestId,
        "different-fingerprint",
        "replacement-owner",
      ),
    ).rejects.toThrow("request ID was reused with different input");
    await state.close();
  });
});
