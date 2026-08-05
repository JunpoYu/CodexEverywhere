import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

import { HostStateStore } from "./state-store.js";
import {
  browseWorkspaceDirectories,
  resolveWorkspacePath,
  WorkspaceRegistry,
} from "./workspaces.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("workspace boundary", () => {
  it("allows canonical descendants of a registered root", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "root");
    const child = join(root, "project");
    await mkdir(child, { recursive: true });
    await expect(
      resolveWorkspacePath([await realpath(root)], child),
    ).resolves.toBe(await realpath(child));
  });

  it("rejects a symlink that escapes a registered root", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "root");
    const outside = join(base, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await symlink(outside, join(root, "escape"));
    await expect(
      resolveWorkspacePath([await realpath(root)], join(root, "escape")),
    ).rejects.toThrow("outside registered workspace roots");
  });

  it("does not confuse sibling path prefixes", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "work");
    const sibling = join(base, "workspace-secret");
    await Promise.all([mkdir(root), mkdir(sibling)]);
    await expect(
      resolveWorkspacePath([await realpath(root)], sibling),
    ).rejects.toThrow();
  });
});

describe("WorkspaceRegistry defaults", () => {
  it("persists a selectable default and replaces it when removed", async () => {
    const base = await temporaryDirectory();
    const first = join(base, "first");
    const second = join(base, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const store = await HostStateStore.open(join(base, "state.sqlite"));
    const registry = new WorkspaceRegistry(store);

    await registry.add(first);
    await registry.add(second);
    await expect(registry.profile()).resolves.toEqual({
      roots: [await realpath(first), await realpath(second)],
      defaultRoot: await realpath(first),
    });
    await registry.setDefault(second);
    await expect(registry.profile()).resolves.toMatchObject({
      defaultRoot: await realpath(second),
    });
    await registry.remove(second);
    await expect(registry.profile()).resolves.toEqual({
      roots: [await realpath(first)],
      defaultRoot: await realpath(first),
    });
    await store.close();
  });

  it("checks duplicate history paths once against one root snapshot", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "root");
    const child = join(root, "project");
    const outside = join(base, "outside");
    await Promise.all([
      mkdir(child, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const store = await HostStateStore.open(join(base, "state.sqlite"));
    const registry = new WorkspaceRegistry(store);
    await registry.add(root);
    const read = vi.spyOn(store, "read");

    await expect(
      registry.allowedPaths([child, child, outside, join(base, "missing")]),
    ).resolves.toEqual(new Set([child]));
    expect(read).toHaveBeenCalledTimes(1);
    await store.close();
  });
});

describe("workspace directory browsing", () => {
  it("lists descendants without following symlinks outside safe anchors", async () => {
    const base = await temporaryDirectory();
    const home = join(base, "home");
    const project = join(home, "project");
    const nested = join(project, "nested");
    const outside = join(base, "outside");
    await Promise.all([
      mkdir(nested, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await symlink(outside, join(home, "escape"));

    await expect(
      browseWorkspaceDirectories([project], undefined, home),
    ).resolves.toMatchObject({
      path: await realpath(home),
      home: await realpath(home),
      directories: [{ name: "project", path: await realpath(project) }],
    });
    await expect(
      browseWorkspaceDirectories([project], project, home),
    ).resolves.toMatchObject({
      path: await realpath(project),
      parent: await realpath(home),
      directories: [{ name: "nested", path: await realpath(nested) }],
    });
    await expect(
      browseWorkspaceDirectories([project], outside, home),
    ).rejects.toThrow("outside browsable directories");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-workspace-test-"));
  temporaryDirectories.push(path);
  return path;
}
