import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "./state-store.js";
import { ThreadPermissionRegistry } from "./thread-permissions.js";

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

  it("retains independent fields and clears values it cannot safely replay", async () => {
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
        approvalPolicy: "future-policy",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "externalSandbox",
          networkAccess: "restricted",
        },
      }),
    ).resolves.toMatchObject({ approvalsReviewer: "auto_review" });
    await expect(registry.read("thread-1")).resolves.toEqual({
      approvalsReviewer: "auto_review",
      updatedAt: expect.any(String),
    });
    await expect(
      registry.applyToResume({ threadId: "thread-1" }),
    ).resolves.toEqual({
      threadId: "thread-1",
      approvalsReviewer: "auto_review",
    });
    await state.close();
  });
});
