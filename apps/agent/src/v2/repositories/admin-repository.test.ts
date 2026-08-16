import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminStateDatabase } from "./admin-state-database.js";

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

describe("AdminRepository", () => {
  it("registers exact Unix identities and rejects conflicting UID reuse", async () => {
    const database = await fixture();
    const user = await database.admin.register({
      uid: 1001,
      username: "alice",
      home: "/home/alice",
      now: "2026-08-16T00:00:00.000Z",
    });

    expect(user).toMatchObject({ status: "enabled", revision: 1 });
    await expect(
      database.admin.register({
        uid: 1001,
        username: "mallory",
        home: "/home/alice",
      }),
    ).rejects.toThrow("conflicts");
    await expect(
      database.admin.setStatus({
        username: "alice",
        expectedRevision: 0,
        status: "disabled",
      }),
    ).rejects.toThrow("revision changed");
  });

  it("paginates redacted audit records with a stable cursor", async () => {
    const database = await fixture();
    for (let index = 0; index < 3; index += 1) {
      await database.admin.appendAudit({
        id: `audit-${index}`,
        requestId: `request-${index}`,
        actor: "admin:test",
        action: "admin/user/disable",
        targetUsername: "alice",
        result: "succeeded",
        now: `2026-08-16T00:00:0${index}.000Z`,
      });
    }

    const first = await database.admin.listAudit({ limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual([
      "audit-2",
      "audit-1",
    ]);
    expect(first).toMatchObject({ hasMore: true });
    const second = await database.admin.listAudit({
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.events.map((event) => event.id)).toEqual(["audit-0"]);
    expect(second.hasMore).toBe(false);
  });

  it("uses the common identity repository without a user-only audit table", async () => {
    const database = await fixture();
    await expect(
      database.identity.rememberDevice({
        id: "admin-browser",
        name: "Admin phone",
        publicKey: new Uint8Array(32).fill(9),
      }),
    ).resolves.toMatchObject({ id: "admin-browser" });
  });
});

async function fixture(): Promise<AdminStateDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-admin-state-test-"));
  directories.push(directory);
  const database = await AdminStateDatabase.open(
    join(directory, "state.sqlite"),
    { create: true },
  );
  databases.push(database);
  return database;
}
