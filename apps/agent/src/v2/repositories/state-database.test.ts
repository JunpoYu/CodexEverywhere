import { chmod, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AdminStateDatabase } from "./admin-state-database.js";
import {
  ADMIN_STATE_APPLICATION_ID,
  USER_STATE_APPLICATION_ID,
} from "./state-schema.js";
import type { StateSnapshotV1 } from "./state-snapshot.js";
import { UserStateDatabase } from "./user-state-database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("v0.4 state databases", () => {
  it("creates a private user database with an independent schema kind", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const database = await UserStateDatabase.open(path, { create: true });

    const snapshot = await database.exportSnapshot();
    expect(snapshot).toMatchObject({
      version: 1,
      kind: "user",
      records: { sourceSchema: 0, workspaces: [], queueItems: [] },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await database.close();

    await expect(AdminStateDatabase.open(path)).rejects.toThrow(
      "State database kind mismatch",
    );
    expect(USER_STATE_APPLICATION_ID).not.toBe(ADMIN_STATE_APPLICATION_ID);
  });

  it("round-trips every user snapshot domain without a JSON export", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const snapshot = userSnapshot();
    const database = await UserStateDatabase.createFromSnapshot(path, snapshot);

    expect(await database.exportSnapshot()).toEqual(snapshot);
    await database.verify();
    await database.close();

    const reopened = await UserStateDatabase.open(path);
    expect(await reopened.exportSnapshot()).toEqual(snapshot);
    await reopened.close();
  });

  it("round-trips admin identity separately from managed-user state", async () => {
    const path = join(await temporaryDirectory(), "admin.sqlite");
    const snapshot = adminSnapshot();
    const database = await AdminStateDatabase.createFromSnapshot(
      path,
      snapshot,
    );

    expect(await database.exportSnapshot()).toEqual(snapshot);
    await database.close();
    await expect(UserStateDatabase.open(path)).rejects.toThrow(
      "State database kind mismatch",
    );
  });

  it("rejects state files exposed to group or other users", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const database = await UserStateDatabase.open(path, { create: true });
    await database.close();
    await chmod(path, 0o644);

    await expect(UserStateDatabase.open(path)).rejects.toThrow(
      "permissions must be 0600",
    );
  });

  it("does not follow a symbolic-link state path", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.sqlite");
    const database = await UserStateDatabase.open(target, { create: true });
    await database.close();
    const linked = join(directory, "linked.sqlite");
    await symlink(target, linked);

    await expect(UserStateDatabase.open(linked)).rejects.toMatchObject({
      code: "ELOOP",
    });
  });

  it("reloads a snapshot committed through another process-like handle", async () => {
    const path = join(await temporaryDirectory(), "state.sqlite");
    const first = await UserStateDatabase.open(path, { create: true });
    const second = await UserStateDatabase.open(path);
    const snapshot = userSnapshot();

    await second.replaceSnapshot(snapshot);
    expect(await first.exportSnapshot()).toEqual(snapshot);

    await Promise.all([first.close(), second.close()]);
  });
});

function userSnapshot(): Extract<StateSnapshotV1, { kind: "user" }> {
  const createdAt = "2026-08-16T00:00:00.000Z";
  return {
    version: 1,
    kind: "user",
    records: {
      createdAt,
      sourceSchema: 4,
      workspaceAuthorizationRevision: 3,
      workspaces: [
        {
          id: "workspace-1",
          path: "/work/project",
          label: "project",
          createdAt,
          revision: 1,
        },
      ],
      defaultWorkspaceId: "workspace-1",
      preferences: {
        theme: "system",
        locale: "zh-CN",
        defaultSandbox: "workspace-write",
        defaultApprovalPolicy: "on-request",
        revision: 1,
        updatedAt: createdAt,
      },
      threadPermissionGeneration: 7,
      threadPermissions: [
        {
          threadId: "thread-1",
          approvalPolicyJson: '"on-request"',
          approvalsReviewer: "user",
          sandboxMode: "workspace-write",
          revision: 7,
          updatedAt: createdAt,
        },
      ],
      threadPermissionObservations: [{ threadId: "thread-1", generation: 7 }],
      trustedDevices: [
        {
          id: "device-1",
          name: "Phone",
          publicKey: Uint8Array.from([1, 2, 3]),
          createdAt,
        },
      ],
      pairingSessions: [
        {
          id: "pairing-1",
          secretHash: Uint8Array.from([4, 5, 6]),
          expiresAt: "2026-08-17T00:00:00.000Z",
          createdAt,
        },
      ],
      passkeys: [
        {
          credentialId: Uint8Array.from([7]),
          publicKey: Uint8Array.from([8]),
          signCount: 2,
          createdAt,
        },
      ],
      recoveryCodes: [
        { hash: Uint8Array.from([9]), createdAt, usedAt: createdAt },
      ],
      recoveryHandoffs: [
        {
          hash: Uint8Array.from([10]),
          expiresAt: "2026-08-17T00:00:00.000Z",
          createdAt,
        },
      ],
      password: { registrationRecord: "opaque-record", updatedAt: createdAt },
      mutationReceipts: [
        {
          operationKey: "operation-1",
          method: "queue/add",
          requestFingerprint: "fingerprint-1",
          status: "completed",
          resultJson: '{"version":1}',
          createdAt,
          updatedAt: createdAt,
          expiresAt: "2026-08-17T00:00:00.000Z",
        },
      ],
      queueItems: [
        {
          id: "queue-1",
          workspacePath: "/work/project",
          threadId: "thread-1",
          requestJson: '{"threadId":"thread-1","turnPayload":{}}',
          status: "indeterminate",
          revision: 2,
          createdAt,
          updatedAt: createdAt,
        },
      ],
      queueDeliveryClaims: [
        {
          queueItemId: "queue-1",
          operation: "turn/start",
          threadId: "thread-1",
          clientUserMessageId: "message-1",
          outcome: "indeterminate",
          createdAt,
          completedAt: createdAt,
        },
      ],
      auditEvents: [{ id: "audit-1", kind: "recovery/rotated", createdAt }],
    },
  };
}

function adminSnapshot(): Extract<StateSnapshotV1, { kind: "admin" }> {
  const createdAt = "2026-08-16T00:00:00.000Z";
  return {
    version: 1,
    kind: "admin",
    records: {
      createdAt,
      sourceSchema: 4,
      identity: {
        trustedDevices: [],
        pairingSessions: [],
        passkeys: [
          {
            credentialId: Uint8Array.from([1]),
            publicKey: Uint8Array.from([2]),
            signCount: 0,
            createdAt,
          },
        ],
        recoveryCodes: [],
        password: { registrationRecord: "admin-opaque", updatedAt: createdAt },
      },
      managedUsers: [
        {
          uid: 1001,
          username: "alice",
          home: "/home/alice",
          status: "enabled",
          registeredAt: createdAt,
          updatedAt: createdAt,
          revision: 1,
        },
      ],
      auditEvents: [
        {
          id: "audit-1",
          requestId: "request-1",
          actor: "admin:test",
          action: "admin/user/register",
          targetUsername: "alice",
          result: "succeeded",
          createdAt,
        },
      ],
      mutationReceipts: [],
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-state-"));
  directories.push(directory);
  return directory;
}
