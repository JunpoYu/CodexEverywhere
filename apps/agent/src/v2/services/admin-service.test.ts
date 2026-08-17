import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { UnixAccount } from "../../admin/unix-accounts.js";
import { AdminStateDatabase } from "../repositories/admin-state-database.js";
import type { ManagedUserRecord } from "../repositories/admin-repository.js";
import { AdminService, type AdminSystemPort } from "./admin-service.js";

const directories: string[] = [];
const databases: AdminStateDatabase[] = [];

afterEach(async () => {
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AdminService", () => {
  it("registers, disables, and reports an exact managed account", async () => {
    const fixture = await createFixture();
    const registered = await fixture.service.handlers["admin/user/register"](
      { version: 1, username: "alice" },
      undefined as never,
    );
    const disabled = await fixture.service.handlers["admin/user/disable"](
      {
        version: 1,
        username: "alice",
        expectedRevision: registered.user.revision,
      },
      undefined as never,
    );

    expect(disabled.user).toMatchObject({
      username: "alice",
      shell: "/bin/bash",
      status: "disabled",
      revision: 2,
    });
    expect(fixture.system.setAccessDisabled).toHaveBeenCalledWith(1001, true);
    expect(fixture.system.stopAgent).toHaveBeenCalledWith(1001);
  });

  it("fails closed when the registered Unix identity changes", async () => {
    const fixture = await createFixture();
    const registered = await fixture.service.handlers["admin/user/register"](
      { version: 1, username: "alice" },
      undefined as never,
    );
    fixture.account.uid = 2001;

    await expect(
      fixture.service.handlers["admin/user/disable"](
        {
          version: 1,
          username: "alice",
          expectedRevision: registered.user.revision,
        },
        undefined as never,
      ),
    ).rejects.toThrow("identity changed");
    expect(fixture.system.setAccessDisabled).not.toHaveBeenCalled();
  });

  it("returns recovery handoff only to the caller and never stores it", async () => {
    const fixture = await createFixture();
    const registered = await fixture.service.handlers["admin/user/register"](
      { version: 1, username: "alice" },
      undefined as never,
    );
    const result = await fixture.service.handlers["admin/user/recovery/start"](
      {
        version: 1,
        username: "alice",
        expectedRevision: registered.user.revision,
      },
      undefined as never,
    );

    expect(result.handoffCode).toBe("HANDOFF-SECRET");
    expect(
      JSON.stringify(await fixture.database.exportSnapshot()),
    ).not.toContain("HANDOFF-SECRET");
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-admin-service-test-"));
  directories.push(directory);
  const database = await AdminStateDatabase.open(
    join(directory, "state.sqlite"),
    { create: true },
  );
  databases.push(database);
  const account: UnixAccount = {
    username: "alice",
    uid: 1001,
    gid: 1001,
    home: "/home/alice",
    shell: "/bin/bash",
  };
  const system = {
    inspectAccount: vi.fn(async (username: string) =>
      username === account.username
        ? { eligible: true as const, account: { ...account } }
        : { eligible: false as const, reason: "missing" },
    ),
    assertCurrentAccount: vi.fn(async (user: ManagedUserRecord) => {
      if (
        user.uid !== account.uid ||
        user.username !== account.username ||
        user.home !== account.home
      ) {
        throw new Error("Unix account identity changed; operation refused");
      }
      return { ...account };
    }),
    agentOnline: vi.fn(async () => false),
    setAccessDisabled: vi.fn(async () => undefined),
    stopAgent: vi.fn(async () => undefined),
    issueRecoveryHandoff: vi.fn(async () => ({
      handoffCode: "HANDOFF-SECRET",
      expiresAt: "2026-08-16T01:00:00.000Z",
    })),
    removeUserState: vi.fn(async () => undefined),
  } satisfies AdminSystemPort;
  return {
    database,
    account,
    system,
    service: new AdminService({
      repository: database.admin,
      system,
      installationId: "installation-test",
      serverName: "host-test",
      startedAt: "2026-08-16T00:00:00.000Z",
    }),
  };
}
