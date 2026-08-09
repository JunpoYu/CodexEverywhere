import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "./state-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("HostStateStore", () => {
  it("persists a committed transaction as a private SQLite file", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const store = await HostStateStore.open(path);
    store.transaction((database) =>
      database.run("INSERT INTO workspace_roots VALUES (?, ?)", [
        "/work/project",
        "2026-08-01T00:00:00Z",
      ]),
    );
    await store.close();

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const reopened = await HostStateStore.open(path);
    const rows = await reopened.read(
      (database) =>
        database.exec("SELECT path FROM workspace_roots")[0]?.values,
    );
    expect(rows).toEqual([["/work/project"]]);
    await reopened.close();
  });

  it("rolls back and does not persist a failed transaction", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const store = await HostStateStore.open(path);

    await expect(
      store.transaction((database) => {
        database.run("INSERT INTO workspace_roots VALUES ('/work', 'now')");
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    const count = await store.read(
      (database) =>
        database.exec("SELECT count(*) FROM workspace_roots")[0]
          ?.values[0]?.[0],
    );
    expect(count).toBe(0);
    await store.close();
  });

  it("observes transactions committed by another process-like store", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const agentStore = await HostStateStore.open(path);
    const cliStore = await HostStateStore.open(path);

    await cliStore.transaction((database) =>
      database.run("INSERT INTO workspace_roots VALUES (?, ?)", [
        "/work/from-cli",
        "2026-08-02T00:00:00Z",
      ]),
    );
    await cliStore.close();

    await expect(
      agentStore.read(
        (database) =>
          database.exec("SELECT path FROM workspace_roots")[0]?.values,
      ),
    ).resolves.toEqual([["/work/from-cli"]]);
    await agentStore.close();
  });

  it("serializes concurrent writers without losing either transaction", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const first = await HostStateStore.open(path);
    const second = await HostStateStore.open(path);

    await Promise.all([
      first.transaction((database) =>
        database.run("INSERT INTO workspace_roots VALUES ('/one', 'now')"),
      ),
      second.transaction((database) =>
        database.run("INSERT INTO workspace_roots VALUES ('/two', 'now')"),
      ),
    ]);

    await expect(
      first.read(
        (database) =>
          database.exec("SELECT path FROM workspace_roots ORDER BY path")[0]
            ?.values,
      ),
    ).resolves.toEqual([["/one"], ["/two"]]);
    await first.close();
    await second.close();
  });

  it("adds rollback-compatible tables without bumping a schema-4 database", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const seeded = await HostStateStore.open(path);
    await seeded.transaction((database) => {
      database.run("DROP TABLE user_preferences");
      database.run("DROP TABLE thread_permissions");
      database.run("PRAGMA user_version = 4");
    });
    await seeded.close();

    const migrated = await HostStateStore.open(path);
    await expect(
      migrated.read((database) => ({
        version: database.exec("PRAGMA user_version")[0]?.values[0]?.[0],
        tables: database.exec(
          `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('thread_permissions', 'user_preferences')
             ORDER BY name`,
        )[0]?.values,
      })),
    ).resolves.toEqual({
      version: 4,
      tables: [["thread_permissions"], ["user_preferences"]],
    });
    await migrated.close();
  });

  it("normalizes the unreleased schema-5 marker for safe release rollback", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const seeded = await HostStateStore.open(path);
    await seeded.transaction((database) =>
      database.run("PRAGMA user_version = 5"),
    );
    await seeded.close();

    const migrated = await HostStateStore.open(path);
    await expect(
      migrated.read(
        (database) => database.exec("PRAGMA user_version")[0]?.values[0]?.[0],
      ),
    ).resolves.toBe(4);
    await migrated.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-state-test-"));
  temporaryDirectories.push(path);
  return path;
}
