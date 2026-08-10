import { renameSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  link,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostStateStore } from "./state-store.js";
import { writeProcessRecord } from "./process-files.js";
import { ThreadPermissionRegistry } from "./thread-permissions.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
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

  it("purges historical persistent replay rows containing authentication secrets", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const store = await HostStateStore.open(path);
    await store.transaction((database) => {
      database.run("INSERT INTO idempotency_keys VALUES (?, ?, ?)", [
        "safe",
        JSON.stringify({ ok: true, result: { removed: true } }),
        "2099-01-01T00:00:00.000Z",
      ]);
      database.run("INSERT INTO idempotency_keys VALUES (?, ?, ?)", [
        "secret",
        JSON.stringify({
          ok: true,
          result: {
            recoveryCodes: ["RECOVERY-CODE-PLAINTEXT"],
            resumeToken: "RESUME-TOKEN-PLAINTEXT",
          },
        }),
        "2099-01-01T00:00:00.000Z",
      ]);
    });
    await store.close();

    const reopened = await HostStateStore.open(path);
    await expect(
      reopened.read(
        (database) =>
          database.exec("SELECT key FROM idempotency_keys ORDER BY key")[0]
            ?.values,
      ),
    ).resolves.toEqual([["safe"]]);
    await reopened.close();
    const persisted = await readFile(path);
    expect(persisted.includes(Buffer.from("RECOVERY-CODE-PLAINTEXT"))).toBe(
      false,
    );
    expect(persisted.includes(Buffer.from("RESUME-TOKEN-PLAINTEXT"))).toBe(
      false,
    );
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

  it("queues coordination owners beyond the transaction timeout", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const first = await HostStateStore.open(path);
    const second = await HostStateStore.open(path);
    vi.useFakeTimers();
    const firstLock = await first.acquireCoordinationLock("thread-example");
    let acquiredSecond = false;
    const secondAcquisition = second
      .acquireCoordinationLock("thread-example")
      .then((lock) => {
        acquiredSecond = true;
        return lock;
      });

    await vi.advanceTimersByTimeAsync(10_025);
    expect(acquiredSecond).toBe(false);

    await firstLock.release();
    await vi.advanceTimersByTimeAsync(100);
    const secondLock = await secondAcquisition;
    expect(acquiredSecond).toBe(true);
    await secondLock.release();
    await first.close();
    await second.close();
  });

  it("keeps the ten-second timeout for ordinary transactions", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const store = await HostStateStore.open(path);
    const lockPath = `${path}.lock`;
    await writeProcessRecord(lockPath);
    vi.useFakeTimers();
    const transaction = store.transaction(() => undefined);
    const rejected = expect(transaction).rejects.toThrow(
      "Timed out waiting for host state transaction lock",
    );

    await vi.advanceTimersByTimeAsync(10_025);
    await rejected;

    await rm(lockPath, { force: true });
    await store.close();
  });

  it("allows a queued coordination acquisition to be cancelled", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const first = await HostStateStore.open(path);
    const second = await HostStateStore.open(path);
    const firstLock = await first.acquireCoordinationLock("thread-example");
    const cancellation = new AbortController();
    const secondAcquisition = second.acquireCoordinationLock("thread-example", {
      signal: cancellation.signal,
    });
    const rejected = expect(secondAcquisition).rejects.toThrow(
      "coordination cancelled",
    );

    cancellation.abort(new Error("coordination cancelled"));
    await rejected;
    await firstLock.release();
    await first.close();
    await second.close();
  });

  it("never grants a queued coordination lock after its store closes", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const first = await HostStateStore.open(path);
    const second = await HostStateStore.open(path);
    const firstLock = await first.acquireCoordinationLock("thread-example");
    let acquiredAfterClose = false;
    const secondAcquisition = second
      .acquireCoordinationLock("thread-example")
      .then((lock) => {
        acquiredAfterClose = true;
        return lock;
      });
    const rejected = expect(secondAcquisition).rejects.toThrow(
      "Host state store is closed",
    );

    await second.close();
    await rejected;
    await firstLock.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acquiredAfterClose).toBe(false);
    await first.close();
  });

  it("keeps an already acquired coordination lease fenced across store close", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const first = await HostStateStore.open(path);
    const second = await HostStateStore.open(path);
    const firstLock = await first.acquireCoordinationLock("thread-example");
    await first.close();
    let acquiredSecond = false;
    const secondAcquisition = second
      .acquireCoordinationLock("thread-example")
      .then((lock) => {
        acquiredSecond = true;
        return lock;
      });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acquiredSecond).toBe(false);
    await firstLock.release();
    const secondLock = await secondAcquisition;
    expect(acquiredSecond).toBe(true);
    await secondLock.release();
    await second.close();
  });

  it("serializes first-open migration across process-like stores", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const [first, second] = await Promise.all([
      HostStateStore.open(path),
      HostStateStore.open(path),
    ]);

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

  it("reclaims a stale owner through an inode-pinned quarantine", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const lockPath = `${path}.lock`;
    await writeProcessRecord(lockPath);
    const currentRecord = JSON.parse(
      await readFile(lockPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        ...currentRecord,
        pid: 2_147_483_647,
      })}\n`,
      { mode: 0o600 },
    );

    const store = await HostStateStore.open(path);
    await store.transaction((database) =>
      database.run("INSERT INTO workspace_roots VALUES ('/work', 'now')"),
    );
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await store.close();
  });

  it("treats the same hostname with a foreign boot id as a leased foreign owner", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const lockPath = `${path}.lock`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        startedAt: "2026-08-01T00:00:00.000Z",
        host: hostname(),
        bootId: "foreign-boot",
      })}\n`,
      { mode: 0o600 },
    );

    let opened = false;
    const opening = HostStateStore.open(path).then((store) => {
      opened = true;
      return store;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toBe(false);

    const expired = new Date(Date.now() - 2 * 60_000);
    await utimes(lockPath, expired, expired);
    const store = await opening;
    expect(opened).toBe(true);
    await store.close();
  });

  it("blocks successor reclaim after an expired writer publishes its commit fence", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const lockPath = `${path}.lock`;
    const commitFencePath = `${lockPath}.commit`;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        startedAt: "2026-08-01T00:00:00.000Z",
        host: hostname(),
        bootId: "foreign-boot-after-assertion",
      })}\n`,
      { mode: 0o600 },
    );
    await link(lockPath, commitFencePath);
    const expired = new Date(Date.now() - 2 * 60_000);
    await utimes(lockPath, expired, expired);

    let opened = false;
    const opening = HostStateStore.open(path).then((store) => {
      opened = true;
      return store;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toBe(false);

    // Model the old writer completing its already-fenced publish. Only after
    // it releases the commit fence may the successor reclaim the expired lease.
    await rm(commitFencePath);
    const store = await opening;
    expect(opened).toBe(true);
    await store.close();
  });

  it("rejects an expired writer without deleting its successor lock", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const lockPath = `${path}.lock`;
    const displacedPath = `${lockPath}.displaced`;
    const replacement = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: "successor-owner",
    };
    const store = await HostStateStore.open(path);

    await expect(
      store.transaction((database) => {
        database.run("INSERT INTO workspace_roots VALUES ('/stale', 'now')");
        // Model a successor reclaiming an expired lease while this writer was
        // paused. The old writer resumes after the stable name was replaced.
        renameSync(lockPath, displacedPath);
        writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, {
          mode: 0o600,
        });
      }),
    ).rejects.toThrow("lease was lost before commit");

    await expect(readFile(lockPath, "utf8")).resolves.toBe(
      `${JSON.stringify(replacement)}\n`,
    );
    await rm(lockPath, { force: true });
    const successor = await HostStateStore.open(path);
    await successor.transaction((database) =>
      database.run("INSERT INTO workspace_roots VALUES ('/successor', 'now')"),
    );
    await expect(
      successor.read(
        (database) =>
          database.exec("SELECT path FROM workspace_roots ORDER BY path")[0]
            ?.values,
      ),
    ).resolves.toEqual([["/successor"]]);
    await successor.close();
    await store.close();
  });

  it("adds rollback-compatible tables without bumping a schema-4 database", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const seeded = await HostStateStore.open(path);
    await seeded.transaction((database) => {
      database.run("DROP TABLE user_preferences");
      database.run("DROP TABLE thread_permissions");
      database.run(`CREATE TABLE thread_permissions (
        thread_id TEXT PRIMARY KEY,
        approval_policy_json TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      database.run("INSERT INTO thread_permissions VALUES (?, ?, ?, ?)", [
        "thread-legacy",
        '"never"',
        "read-only",
        "now",
      ]);
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
               AND name IN (
                 'thread_permission_observation_state',
                 'thread_permission_observations',
                 'thread_permissions',
                 'user_preferences'
               )
             ORDER BY name`,
        )[0]?.values,
        permissionColumns: database
          .exec("PRAGMA table_info(thread_permissions)")[0]
          ?.values.map((row) => row[1]),
      })),
    ).resolves.toEqual({
      version: 4,
      tables: [
        ["thread_permission_observation_state"],
        ["thread_permission_observations"],
        ["thread_permissions"],
        ["user_preferences"],
      ],
      permissionColumns: [
        "thread_id",
        "approval_policy_json",
        "sandbox_mode",
        "updated_at",
        "approvals_reviewer",
      ],
    });
    await expect(
      new ThreadPermissionRegistry(migrated).read("thread-legacy"),
    ).resolves.toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
      updatedAt: "now",
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
