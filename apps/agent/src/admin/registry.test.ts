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
});
