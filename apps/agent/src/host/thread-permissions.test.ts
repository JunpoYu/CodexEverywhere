import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "./state-store.js";
import {
  resumePermissionRepair,
  ThreadPermissionRegistry,
} from "./thread-permissions.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ThreadPermissionRegistry", () => {
  it("preserves a thread's permissions when the Host state is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const firstState = await HostStateStore.open(path);
    const firstRegistry = new ThreadPermissionRegistry(firstState);

    await firstRegistry.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    await firstState.close();

    const secondState = await HostStateStore.open(path);
    const secondRegistry = new ThreadPermissionRegistry(secondState);
    await expect(secondRegistry.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
    });

    await secondRegistry.save("thread-1", {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    await expect(secondRegistry.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "read-only",
    });
    await expect(secondRegistry.remove("thread-1")).resolves.toBe(true);
    await expect(secondRegistry.read("thread-1")).resolves.toBeUndefined();
    await secondState.close();
  });

  it("updates fields independently and clears only values it cannot safely replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new ThreadPermissionRegistry(state);
    await registry.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    await expect(
      registry.save("thread-1", {
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "externalSandbox",
          networkAccess: "restricted",
        },
      }),
    ).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });
    await expect(registry.read("thread-1")).resolves.toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      updatedAt: expect.any(String),
    });
    await expect(
      registry.applyToResume({ threadId: "thread-1" }),
    ).resolves.toEqual({
      threadId: "thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
    });

    await registry.save("thread-1", {
      approvalPolicy: "future-policy",
    });
    await expect(registry.read("thread-1")).resolves.toEqual({
      approvalsReviewer: "auto_review",
      updatedAt: expect.any(String),
    });
    await state.close();
  });

  it("preserves missing fields and rejects an out-of-order response without trusting wall time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new ThreadPermissionRegistry(state);

    await registry.save(
      "thread-1",
      {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
      },
      observation(1, "2026-08-10T00:00:01.000Z"),
    );
    await registry.saveSettingsNotification(
      {
        threadId: "thread-1",
        threadSettings: {
          approvalPolicy: "never",
          approvalsReviewer: "auto_review",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
      observation(3, "2026-08-10T00:00:02.000Z"),
    );
    await expect(
      registry.saveResponse(
        {
          thread: { id: "thread-1" },
          approvalPolicy: "never",
        },
        observation(4, "2026-08-10T00:00:02.000Z"),
      ),
    ).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
    });

    await expect(
      registry.saveResponse(
        {
          thread: { id: "thread-1" },
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [] },
        },
        observation(2, "2026-08-10T00:00:02.000Z"),
      ),
    ).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      updatedAt: "2026-08-10T00:00:02.000Z",
    });
    await expect(registry.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
    });

    await registry.save(
      "thread-1",
      { approvalPolicy: "untrusted" },
      observation(5, "2026-08-09T23:59:59.000Z"),
    );
    await expect(registry.read("thread-1")).resolves.toMatchObject({
      approvalPolicy: "untrusted",
      approvalsReviewer: "auto_review",
      sandbox: "danger-full-access",
      updatedAt: "2026-08-09T23:59:59.000Z",
    });
    await state.close();
  });

  it("ignores a stale first response while the newer mutation has not persisted yet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new ThreadPermissionRegistry(state);
    const resumeObservation = await registry.beginObservation("thread-new");
    const updateObservation = await registry.beginObservation("thread-new");
    await expect(
      registry.saveResponse(
        {
          thread: { id: "thread-new" },
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite", writableRoots: [] },
        },
        resumeObservation,
      ),
    ).resolves.toBeUndefined();
    await expect(
      registry.saveSettingsUpdate(
        "thread-new",
        {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        updateObservation,
      ),
    ).resolves.toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await state.close();
  });

  it("treats schema null resume fields as absent and repairs an ignored override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new ThreadPermissionRegistry(state);
    await registry.save("thread-1", {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    const requested = await registry.applyToResume({
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
      resumePermissionRepair(requested, {
        thread: {
          id: "thread-1",
          cwd: "/workspace",
          source: "appServer",
          cliVersion: "test",
          createdAt: 1,
          updatedAt: 1,
          status: { type: "idle" },
          path: null,
          gitInfo: null,
          name: null,
          agentNickname: null,
          agentRole: null,
          ephemeral: false,
          turns: [],
        },
        model: "test",
        modelProvider: "openai",
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        reasoningEffort: null,
      } as unknown as Parameters<typeof resumePermissionRepair>[1]),
    ).toMatchObject({
      update: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });
    await state.close();
  });

  it("orders updates, responses, repairs, notifications, and restarts across Registry processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const stateA = await HostStateStore.open(path);
    const stateB = await HostStateStore.open(path);
    const registryA = new ThreadPermissionRegistry(stateA);
    const registryB = new ThreadPermissionRegistry(stateB);
    await registryA.save("thread-shared", {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    const delayedResume = await registryA.beginObservation("thread-shared");
    const explicitUpdate = await registryB.beginObservation("thread-shared");
    await expect(
      registryA.claimRepairObservation("thread-shared", delayedResume),
    ).resolves.toBeUndefined();
    await registryB.saveSettingsUpdate(
      "thread-shared",
      {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
      explicitUpdate,
    );
    await registryA.saveResponse(
      {
        thread: { id: "thread-shared" },
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      },
      delayedResume,
    );
    await expect(registryA.read("thread-shared")).resolves.toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });

    const responseAllocatedBeforeRestart =
      await registryB.beginObservation("thread-shared");
    await stateB.close();
    const notification = await registryA.beginObservation("thread-shared");
    await registryA.saveSettingsNotification(
      {
        threadId: "thread-shared",
        threadSettings: {
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
      notification,
    );

    const restartedState = await HostStateStore.open(path);
    const restartedRegistry = new ThreadPermissionRegistry(restartedState);
    await restartedRegistry.saveResponse(
      {
        thread: { id: "thread-shared" },
        approvalPolicy: "on-request",
        sandbox: { type: "readOnly", networkAccess: false },
      },
      responseAllocatedBeforeRestart,
    );
    await expect(
      restartedRegistry.read("thread-shared"),
    ).resolves.toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const afterRestart =
      await restartedRegistry.beginObservation("thread-shared");
    expect(afterRestart.generation).toBeGreaterThan(notification.generation);
    await restartedRegistry.saveSettingsUpdate(
      "thread-shared",
      {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
      },
      afterRestart,
    );
    await expect(
      restartedRegistry.read("thread-shared"),
    ).resolves.toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    await restartedState.close();
    await stateA.close();
  });

  it("serializes cross-process partial mutations without losing non-overlapping fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const stateA = await HostStateStore.open(path);
    const stateB = await HostStateStore.open(path);
    const registryA = new ThreadPermissionRegistry(stateA);
    const registryB = new ThreadPermissionRegistry(stateB);
    await registryA.save("thread-shared", {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [] },
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const first = registryA.serializeMutation("thread-shared", async () => {
      const observation = await registryA.beginObservation("thread-shared");
      signalFirstEntered();
      await firstGate;
      await registryA.saveSettingsUpdate(
        "thread-shared",
        { approvalPolicy: "never" },
        observation,
      );
    });
    await firstEntered;

    let secondEntered = false;
    const second = registryB.serializeMutation("thread-shared", async () => {
      secondEntered = true;
      const observation = await registryB.beginObservation("thread-shared");
      await registryB.saveSettingsUpdate(
        "thread-shared",
        { sandboxPolicy: { type: "dangerFullAccess" } },
        observation,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    await expect(registryA.read("thread-shared")).resolves.toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await stateB.close();
    await stateA.close();
  });

  it("keeps a newer delete tombstone ahead of delayed creation responses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-thread-permissions-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new ThreadPermissionRegistry(state);
    const delayedStart = await registry.beginObservation();

    await expect(registry.remove("thread-deleted")).resolves.toBe(false);
    await expect(
      registry.saveResponse(
        {
          thread: { id: "thread-deleted" },
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
        },
        delayedStart,
      ),
    ).resolves.toBeUndefined();
    await expect(registry.read("thread-deleted")).resolves.toBeUndefined();
    await state.close();
  });
});

function observation(generation: number, observedAt: string) {
  return { generation, observedAt };
}
