import { renameSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  link,
  readFile,
  open,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueueRegistry } from "./queue.js";
import { HostStateStore } from "./state-store.js";
import { writeProcessRecord } from "./process-files.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("HostStateStore", () => {
  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])(
    "keeps a durable commit successful when directory fsync returns %s",
    async (code) => {
      const directory = await temporaryDirectory();
      const path = join(directory, "state.sqlite");
      const store = await HostStateStore.open(path);
      await mockNextDirectorySyncFailure(directory, code);

      await expect(
        store.transaction((database) => {
          database.run("INSERT INTO workspace_roots VALUES (?, ?)", [
            "/work/durable",
            "2026-08-10T00:00:00Z",
          ]);
        }),
      ).resolves.toBeUndefined();
      await store.close();

      const reopened = await HostStateStore.open(path);
      await expect(
        reopened.read(
          (database) =>
            database.exec("SELECT path FROM workspace_roots")[0]?.values,
        ),
      ).resolves.toEqual([["/work/durable"]]);
      await reopened.close();
    },
  );

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
  }, 15_000);

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
      migrated.read(
        (database) =>
          database.exec(
            "SELECT approval_policy_json, approvals_reviewer, sandbox_mode, updated_at FROM thread_permissions WHERE thread_id = 'thread-legacy'",
          )[0]?.values[0],
      ),
    ).resolves.toEqual(['"never"', "", "read-only", "now"]);
    await migrated.close();
  });

  it("quarantines every legacy non-done queue item behind a rollback-safe barrier", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const seeded = await HostStateStore.open(path);
    await seeded.transaction((database) => {
      database.run("DROP TABLE queue_consumption_claims");
      database.run("DROP TABLE queue_item_states");
      for (const [index, status] of [
        "pending",
        "paused",
        "running",
      ].entries()) {
        database.run(
          "INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            `legacy-${status}`,
            "/work/legacy",
            JSON.stringify({
              threadId: "thread-legacy",
              turnPayload: {
                clientUserMessageId: `operation-${status}`,
                input: [
                  { type: "text", text: `PRIVATE LEGACY PROMPT ${index}` },
                ],
              },
            }),
            status,
            `2026-08-10T00:00:0${index}.000Z`,
            `2026-08-10T00:00:0${index}.000Z`,
          ],
        );
      }
    });
    await seeded.close();

    const migrated = await HostStateStore.open(path);
    const queue = new QueueRegistry(migrated);
    await expect(queue.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "legacy-pending",
          status: "indeterminate",
        }),
        expect.objectContaining({
          id: "legacy-paused",
          status: "indeterminate",
        }),
        expect.objectContaining({
          id: "legacy-running",
          status: "indeterminate",
        }),
      ]),
    );
    const persisted = await migrated.read((database) => ({
      oldAgentVisible: database.exec(
        "SELECT id FROM queue_items WHERE status IN ('pending', 'paused', 'running') ORDER BY id",
      )[0]?.values,
      claims: database.exec(
        "SELECT queue_item_id, operation, thread_id, client_user_message_id, outcome FROM queue_consumption_claims ORDER BY queue_item_id",
      )[0]?.values,
    }));
    expect(persisted.oldAgentVisible ?? []).toEqual([]);
    expect(persisted.claims).toEqual([
      [
        "legacy-paused",
        "legacy",
        "thread-legacy",
        "operation-paused",
        "indeterminate",
      ],
      [
        "legacy-pending",
        "legacy",
        "thread-legacy",
        "operation-pending",
        "indeterminate",
      ],
      [
        "legacy-running",
        "legacy",
        "thread-legacy",
        "operation-running",
        "indeterminate",
      ],
    ]);
    expect(JSON.stringify(persisted.claims)).not.toContain(
      "PRIVATE LEGACY PROMPT",
    );
    await expect(queue.remove("legacy-pending")).resolves.toBe(false);
    await expect(
      queue.remove("legacy-pending", { acknowledgeIndeterminate: true }),
    ).resolves.toBe(true);
    await expect(
      migrated.read(
        (database) =>
          database.exec(
            "SELECT outcome FROM queue_consumption_claims WHERE queue_item_id = 'legacy-pending'",
          )[0]?.values,
      ),
    ).resolves.toEqual([["abandoned"]]);
    await migrated.close();
  });

  it("quarantines old-Agent restores even when additive Queue tables already exist", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const current = await HostStateStore.open(path);
    const currentQueue = new QueueRegistry(current);
    const currentItem = await currentQueue.add({
      workspacePath: "/work/current",
      threadId: "thread-current",
      turnPayload: {
        clientUserMessageId: "operation-current",
        input: [{ type: "text", text: "PRIVATE CURRENT CONTENT" }],
      },
    });
    await expect(
      current.read(
        (database) =>
          database.exec("SELECT id FROM queue_items WHERE status != 'done'")[0]
            ?.values,
      ),
    ).resolves.toBeUndefined();

    // Model an old rollback build accepting two messages and restoring its
    // physical status after losing the app-server response. The additive
    // tables remain present, which is the downgrade path that the original
    // one-time migration failed to quarantine.
    await current.transaction((database) => {
      for (const [id, status, operation] of [
        ["old-dispatch", "paused", "operation-old-dispatch"],
        ["old-steer", "pending", "operation-old-steer"],
      ] as const) {
        database.run(
          "INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            id,
            "/work/old",
            JSON.stringify({
              threadId: "thread-old",
              turnPayload: {
                clientUserMessageId: operation,
                input: [{ type: "text", text: `PRIVATE ${id} CONTENT` }],
              },
            }),
            status,
            `2026-08-10T00:00:0${id === "old-dispatch" ? "0" : "1"}.000Z`,
            "2026-08-10T00:00:02.000Z",
          ],
        );
      }
    });
    await current.close();

    const upgraded = await HostStateStore.open(path);
    const upgradedQueue = new QueueRegistry(upgraded);
    await expect(upgradedQueue.get(currentItem.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(upgradedQueue.get("old-dispatch")).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(upgradedQueue.get("old-steer")).resolves.toMatchObject({
      status: "indeterminate",
    });
    await expect(
      upgradedQueue.claimNext("thread-old"),
    ).resolves.toBeUndefined();
    await expect(
      upgradedQueue.claimForSteer("old-steer"),
    ).resolves.toBeUndefined();
    await expect(
      upgradedQueue.claimNext("thread-current"),
    ).resolves.toMatchObject({ id: currentItem.id });

    const persisted = await upgraded.read((database) => ({
      schemaVersion: database.exec("PRAGMA user_version")[0]?.values[0]?.[0],
      oldAgentVisible: database.exec(
        "SELECT id FROM queue_items WHERE status != 'done' ORDER BY id",
      )[0]?.values,
      oldClaims: database.exec(
        "SELECT queue_item_id, operation, client_user_message_id, outcome FROM queue_consumption_claims WHERE queue_item_id LIKE 'old-%' ORDER BY queue_item_id",
      )[0]?.values,
      currentState: database.exec(
        "SELECT queue_item_id, status FROM queue_item_states WHERE queue_item_id = ?",
        [currentItem.id],
      )[0]?.values[0],
    }));
    expect(persisted.schemaVersion).toBe(4);
    expect(persisted.oldAgentVisible).toBeUndefined();
    expect(persisted.oldClaims).toEqual([
      ["old-dispatch", "legacy", "operation-old-dispatch", "indeterminate"],
      ["old-steer", "legacy", "operation-old-steer", "indeterminate"],
    ]);
    expect(persisted.currentState).toEqual([currentItem.id, "running"]);
    expect(JSON.stringify(persisted.oldClaims)).not.toContain("PRIVATE");
    await upgraded.close();
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

async function mockNextDirectorySyncFailure(
  directory: string,
  code: string,
): Promise<void> {
  const sample = await open(directory, "r");
  const prototype = Object.getPrototypeOf(sample) as {
    sync(): Promise<void>;
  };
  await sample.close();
  const error = Object.assign(new Error(`injected ${code}`), { code });
  vi.spyOn(prototype, "sync")
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(error);
}
