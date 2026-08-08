import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "./state-store.js";
import {
  INITIAL_SESSION_PERMISSION_DEFAULTS,
  UserPreferencesRegistry,
} from "./user-preferences.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("UserPreferencesRegistry", () => {
  it("starts with explicit safe defaults and persists user changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-preferences-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.sqlite");
    const state = await HostStateStore.open(statePath);
    const preferences = new UserPreferencesRegistry(state);

    await expect(preferences.readSessionPermissionDefaults()).resolves.toEqual(
      INITIAL_SESSION_PERMISSION_DEFAULTS,
    );
    await expect(
      preferences.updateSessionPermissionDefaults({
        sandbox: "read-only",
        approvalPolicy: "never",
      }),
    ).resolves.toMatchObject({
      version: 1,
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    await state.close();

    const reopened = await HostStateStore.open(statePath);
    await expect(
      new UserPreferencesRegistry(reopened).readSessionPermissionDefaults(),
    ).resolves.toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    await reopened.close();
  });

  it("rejects unknown permission values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-preferences-"));
    temporaryDirectories.push(directory);
    const state = await HostStateStore.open(join(directory, "state.sqlite"));
    const preferences = new UserPreferencesRegistry(state);

    await expect(
      preferences.updateSessionPermissionDefaults({
        sandbox: "outside-workspace",
        approvalPolicy: "never",
      }),
    ).rejects.toThrow("Invalid default session sandbox");
    await state.close();
  });
});
