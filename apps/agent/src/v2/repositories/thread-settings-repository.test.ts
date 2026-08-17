import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resumeThreadSettingsRepair } from "./thread-settings-repository.js";
import { UserStateDatabase } from "./user-state-database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("v0.4 TUI thread settings", () => {
  it("does not let a stale resume response overwrite a newer setting", async () => {
    const state = await database();
    const repository = state.threadSettings;
    const observation = await repository.beginObservation("thread-1");
    await repository.save("thread-1", 0, {
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });

    await repository.saveObserved(
      "thread-1",
      {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      observation,
    );

    await expect(repository.read("thread-1")).resolves.toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
    await expect(
      repository.applyToResume({ threadId: "thread-1" }),
    ).resolves.toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
    await state.close();
  });

  it("retains a deletion tombstone against delayed TUI observations", async () => {
    const state = await database();
    const repository = state.threadSettings;
    await repository.save("thread-1", 0, {
      approvalPolicy: "on-request",
    });
    const stale = await repository.beginObservation("thread-1");
    await repository.remove("thread-1");
    await repository.saveObserved(
      "thread-1",
      { approvalPolicy: "never" },
      stale,
    );

    await expect(repository.read("thread-1")).resolves.toEqual({ revision: 0 });
    await state.close();
  });

  it("treats null resume fields as absent and repairs app-server defaults", async () => {
    const state = await database();
    const repository = state.threadSettings;
    await repository.saveObserved("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    const requested = await repository.applyToResume({
      threadId: "thread-1",
      approvalPolicy: null,
      approvalsReviewer: null,
      sandbox: null,
    });
    expect(requested).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });
    expect(
      resumeThreadSettingsRepair(requested, {
        thread: { id: "thread-1" },
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      } as unknown as Parameters<typeof resumeThreadSettingsRepair>[1]),
    ).toMatchObject({
      update: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
    await state.close();
  });

  it("shares causal ordering and mutation fences across processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-settings-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const stateA = await UserStateDatabase.open(path, { create: true });
    const stateB = await UserStateDatabase.open(path);
    const repositoryA = stateA.threadSettings;
    const repositoryB = stateB.threadSettings;
    await repositoryA.saveObserved("thread-shared", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    const stale = await repositoryA.beginObservation("thread-shared");
    const current = await repositoryB.beginObservation("thread-shared");
    await expect(
      repositoryA.claimRepairObservation("thread-shared", stale),
    ).resolves.toBeUndefined();
    await repositoryB.saveObserved(
      "thread-shared",
      {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      current,
    );
    await repositoryA.saveObserved(
      "thread-shared",
      {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      stale,
    );
    await expect(repositoryA.read("thread-shared")).resolves.toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });

    const firstLease = await repositoryA.acquireMutation("thread-shared");
    const secondController = new AbortController();
    let secondSettled = false;
    const secondLease = repositoryB
      .acquireMutation("thread-shared", { signal: secondController.signal })
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondSettled).toBe(false);
    secondController.abort(new Error("test complete"));
    await expect(secondLease).rejects.toThrow();
    await firstLease.release();
    await stateB.close();
    await stateA.close();
  });
});

async function database(): Promise<UserStateDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "ce-thread-settings-"));
  directories.push(directory);
  return UserStateDatabase.open(join(directory, "state.sqlite"), {
    create: true,
  });
}
