import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "../../host/state-store.js";
import { UserStateDatabase } from "../repositories/user-state-database.js";
import { loadSqliteRuntime } from "../repositories/sqlite-runtime.js";
import { StateConversionError } from "../repositories/legacy-state-conversion.js";
import {
  finalizeStateMigration,
  migrateState,
  type MigrationRuntimeState,
} from "./state-migrator.js";

const directories: string[] = [];
const now = new Date("2026-08-16T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("state migration", () => {
  it("migrates user state forward and back with rollback barriers", async () => {
    const statePath = join(await temporaryDirectory(), "state.sqlite");
    await createLegacyUserState(statePath);

    const forward = await migrateState({
      statePath,
      kind: "user",
      direction: "v0.3-to-v0.4",
      runtime: quietRuntime(),
      now,
    });

    expect(forward).toMatchObject({
      version: 1,
      direction: "v0.3-to-v0.4",
      dryRun: false,
      counts: {
        workspaces: 1,
        mutationReceipts: 2,
        queueItems: 1,
      },
    });
    expect((await stat(forward.backupPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(forward.receiptPath!)).mode & 0o777).toBe(0o600);
    await expect(HostStateStore.open(statePath)).rejects.toThrow(
      "newer schema kind",
    );

    const v4 = await UserStateDatabase.open(statePath);
    const snapshot = await v4.exportSnapshot();
    expect(snapshot.records.workspaces).toEqual([
      expect.objectContaining({
        path: "/work/project",
        label: "project",
      }),
    ]);
    expect(snapshot.records.queueItems).toEqual([
      expect.objectContaining({ id: "queue-1", status: "pending" }),
    ]);
    expect(snapshot.records.trustedDevices[0]?.publicKey).toEqual(
      Uint8Array.from([1, 2, 3]),
    );
    await v4.close();

    const reverse = await migrateState({
      statePath,
      kind: "user",
      direction: "v0.4-to-v0.3",
      runtime: quietRuntime(),
      now: new Date("2026-08-16T12:01:00.000Z"),
    });
    expect(reverse.counts).toEqual(forward.counts);

    const legacy = await HostStateStore.open(statePath);
    await expect(
      legacy.read((database) => ({
        workspace: database.exec("SELECT path FROM workspace_roots")[0]?.values,
        physicalQueue: database.exec(
          "SELECT status FROM queue_items WHERE id = 'queue-1'",
        )[0]?.values,
        logicalQueue: database.exec(
          "SELECT status FROM queue_item_states WHERE queue_item_id = 'queue-1'",
        )[0]?.values,
        threadCache: database.exec("SELECT COUNT(*) FROM thread_cache")[0]
          ?.values[0]?.[0],
      })),
    ).resolves.toEqual({
      workspace: [["/work/project"]],
      physicalQueue: [["done"]],
      logicalQueue: [["pending"]],
      threadCache: 0,
    });
    await legacy.close();
  });

  it("keeps the source backup until explicit finalization", async () => {
    const statePath = join(await temporaryDirectory(), "state.sqlite");
    await createLegacyUserState(statePath);
    const result = await migrateState({
      statePath,
      kind: "user",
      direction: "v0.3-to-v0.4",
      runtime: quietRuntime(),
      now,
    });

    await finalizeStateMigration({
      statePath,
      receiptPath: result.receiptPath!,
      now: new Date("2026-08-17T00:00:00.000Z"),
    });

    await expect(stat(result.backupPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const receipt = JSON.parse(
      await readFile(result.receiptPath!, "utf8"),
    ) as Record<string, unknown>;
    expect(receipt.finalizedAt).toBe("2026-08-17T00:00:00.000Z");
    await expect(
      finalizeStateMigration({
        statePath,
        receiptPath: result.receiptPath!,
      }),
    ).resolves.toBeUndefined();
  });

  it("performs a non-mutating dry run", async () => {
    const directory = await temporaryDirectory();
    const statePath = join(directory, "state.sqlite");
    await createLegacyUserState(statePath);
    const before = sha256(await readFile(statePath));
    const beforeFiles = await readdir(directory);

    const result = await migrateState({
      statePath,
      kind: "user",
      direction: "v0.3-to-v0.4",
      runtime: quietRuntime(),
      dryRun: true,
      now,
    });

    expect(result.dryRun).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(sha256(await readFile(statePath))).toBe(before);
    expect(await readdir(directory)).toEqual(beforeFiles);
  });

  it("fails closed on Schedule or Push records and reports only counts", async () => {
    const directory = await temporaryDirectory();
    const statePath = join(directory, "state.sqlite");
    const state = await HostStateStore.open(statePath);
    await state.transaction((database) => {
      database.run(
        "INSERT INTO schedules (id, workspace_path, schedule_json, enabled, created_at, updated_at) VALUES ('schedule-1', '/work', '{}', 1, ?, ?)",
        [now.toISOString(), now.toISOString()],
      );
    });
    await state.close();
    const before = sha256(await readFile(statePath));

    const error = await migrateState({
      statePath,
      kind: "user",
      direction: "v0.3-to-v0.4",
      runtime: quietRuntime(),
      now,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StateConversionError);
    expect(error).toMatchObject({
      code: "UNSUPPORTED_LEGACY_DATA",
      counts: { schedules: 1, scheduleRuns: 0, pushSubscriptions: 0 },
    });
    expect(JSON.stringify(error)).not.toContain("schedule-1");
    expect(sha256(await readFile(statePath))).toBe(before);
    expect(
      (await readdir(directory)).some((file) => file.includes("backup")),
    ).toBe(false);
  });

  it("rejects schema 1 through 3 instead of guessing an upgrade", async () => {
    for (const version of [1, 2, 3]) {
      const statePath = join(
        await temporaryDirectory(),
        `state-v${version}.sqlite`,
      );
      await createLegacyUserState(statePath);
      await rewriteUserVersion(statePath, version);

      await expect(
        migrateState({
          statePath,
          kind: "user",
          direction: "v0.3-to-v0.4",
          runtime: quietRuntime(),
          dryRun: true,
          now,
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE_SCHEMA" });
    }
  });

  it("checks runtime quiescence before touching the database", async () => {
    const statePath = join(await temporaryDirectory(), "state.sqlite");
    await createLegacyUserState(statePath);
    const before = sha256(await readFile(statePath));

    await expect(
      migrateState({
        statePath,
        kind: "user",
        direction: "v0.3-to-v0.4",
        runtime: { ...quietRuntime(), runningTurns: 1, activeSideSessions: 2 },
        now,
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_NOT_QUIESCENT",
      counts: { runningTurns: 1, activeSideSessions: 2 },
    });
    expect(sha256(await readFile(statePath))).toBe(before);
  });

  it("refuses a reverse migration that would lose v0.4-only preferences", async () => {
    const statePath = join(await temporaryDirectory(), "state.sqlite");
    const database = await UserStateDatabase.open(statePath, { create: true });
    const snapshot = await database.exportSnapshot();
    await database.replaceSnapshot({
      ...snapshot,
      records: {
        ...snapshot.records,
        preferences: {
          ...snapshot.records.preferences!,
          theme: "dark",
        },
      },
    });
    await database.close();

    await expect(
      migrateState({
        statePath,
        kind: "user",
        direction: "v0.4-to-v0.3",
        runtime: quietRuntime(),
        dryRun: true,
        now,
      }),
    ).rejects.toMatchObject({ code: "UNREPRESENTABLE_V4_STATE" });

    const stillV4 = await UserStateDatabase.open(statePath);
    expect((await stillV4.exportSnapshot()).records.preferences?.theme).toBe(
      "dark",
    );
    await stillV4.close();
  });

  it("migrates administrator identity into its separate schema", async () => {
    const statePath = join(await temporaryDirectory(), "admin.sqlite");
    const state = await HostStateStore.open(statePath);
    await state.transaction((database) => {
      database.run(
        "INSERT INTO web_password (id, registration_record, updated_at) VALUES (1, 'admin-record', ?)",
        [now.toISOString()],
      );
      database.run(
        "INSERT INTO admin_managed_users (uid, username, home, status, registered_at, updated_at, revision, remove_after) VALUES (1001, 'alice', '/home/alice', 'enabled', ?, ?, 1, NULL)",
        [now.toISOString(), now.toISOString()],
      );
    });
    await state.close();

    const result = await migrateState({
      statePath,
      kind: "admin",
      direction: "v0.3-to-v0.4",
      runtime: quietRuntime(),
      now,
    });
    expect(result.counts).toMatchObject({ managedUsers: 1, identities: 1 });
    await expect(UserStateDatabase.open(statePath)).rejects.toThrow(
      "kind mismatch",
    );
  });
});

async function createLegacyUserState(statePath: string): Promise<void> {
  const state = await HostStateStore.open(statePath);
  await state.transaction((database) => {
    const timestamp = now.toISOString();
    database.run(
      "INSERT INTO workspace_roots (path, created_at) VALUES ('/work/project', ?)",
      [timestamp],
    );
    database.run(
      "INSERT INTO workspace_settings (id, default_path) VALUES (1, '/work/project')",
    );
    database.run(
      "UPDATE workspace_authorization_state SET revision = 3 WHERE id = 1",
    );
    database.run(
      "INSERT INTO user_preferences (id, default_sandbox, default_approval_policy, updated_at) VALUES (1, 'workspace-write', 'on-request', ?)",
      [timestamp],
    );
    database.run(
      "INSERT INTO thread_permissions (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, updated_at) VALUES ('thread-1', '\"on-request\"', 'user', 'workspace-write', ?)",
      [timestamp],
    );
    database.run(
      "UPDATE thread_permission_observation_state SET generation = 7 WHERE id = 1",
    );
    database.run(
      "INSERT INTO thread_permission_observations (thread_id, generation) VALUES ('thread-1', 7)",
    );
    database.run(
      "INSERT INTO trusted_devices (id, name, public_key, created_at, revoked_at) VALUES ('device-1', 'Phone', ?, ?, NULL)",
      [Uint8Array.from([1, 2, 3]), timestamp],
    );
    database.run(
      "INSERT INTO passkeys (credential_id, public_key, sign_count, created_at) VALUES (?, ?, 0, ?)",
      [Uint8Array.from([4]), Uint8Array.from([5]), timestamp],
    );
    database.run(
      "INSERT INTO recovery_codes (hash, created_at, used_at) VALUES (?, ?, NULL)",
      [Uint8Array.from([6]), timestamp],
    );
    database.run(
      "INSERT INTO web_password (id, registration_record, updated_at) VALUES (1, 'opaque-record', ?)",
      [timestamp],
    );
    database.run(
      "INSERT INTO idempotency_keys (key, result_json, expires_at) VALUES ('generic-key', '{\"ok\":true,\"result\":{\"removed\":true}}', '2026-08-17T12:00:00.000Z')",
    );
    database.run(
      "INSERT INTO durable_mutation_claims (key, method, request_fingerprint, result_json, created_at, completed_at) VALUES ('durable-key', 'queue/add', 'fingerprint', '{\"ok\":true,\"result\":{\"id\":\"queue-1\"}}', ?, ?)",
      [timestamp, timestamp],
    );
    database.run(
      'INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (\'queue-1\', \'/work/project\', \'{"threadId":"thread-1","turnPayload":{"clientUserMessageId":"message-1"}}\', \'done\', ?, ?)',
      [timestamp, timestamp],
    );
    database.run(
      "INSERT INTO queue_item_states (queue_item_id, status, updated_at) VALUES ('queue-1', 'pending', ?)",
      [timestamp],
    );
    database.run(
      "INSERT INTO audit_events (kind, subject_id, created_at) VALUES ('recovery/rotated', NULL, ?)",
      [timestamp],
    );
    database.run(
      "INSERT INTO thread_cache (thread_id, workspace_path, status, updated_at) VALUES ('thread-1', '/work/project', 'idle', ?)",
      [timestamp],
    );
  });
  await state.close();
}

async function rewriteUserVersion(
  statePath: string,
  version: number,
): Promise<void> {
  const SQL = await loadSqliteRuntime();
  const database = new SQL.Database(await readFile(statePath));
  try {
    database.run(`PRAGMA user_version = ${version}`);
    await writeFile(statePath, database.export(), { mode: 0o600 });
  } finally {
    database.close();
  }
}

function quietRuntime(): MigrationRuntimeState {
  return {
    activeSideSessions: 0,
    runningTurns: 0,
    unresolvedInteractions: 0,
    deliveringQueue: 0,
    pendingMutations: 0,
    loginFlows: 0,
    activeLeases: 0,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ce-migration-"));
  directories.push(directory);
  return directory;
}
