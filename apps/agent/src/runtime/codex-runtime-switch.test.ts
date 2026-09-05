import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveHostPaths } from "../host/paths.js";
import {
  clearCodexRuntimeSwitchState,
  readCodexRuntimeSwitchState,
  writeCodexRuntimeSwitchState,
} from "./codex-runtime-switch.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Codex runtime switch state", () => {
  it("persists only the minimal recovery marker with private permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "ce-runtime-switch-test-"));
    directories.push(home);
    const paths = resolveHostPaths({
      CE_HOME: home,
      CE_RUNTIME_DIR: join(home, "runtime"),
    });
    const state = {
      version: 1 as const,
      phase: "restart-required" as const,
      createdAt: "2026-09-05T00:00:00.000Z",
      installedVersion: "0.153.4",
    };

    await writeCodexRuntimeSwitchState(paths, state);

    await expect(readCodexRuntimeSwitchState(paths)).resolves.toEqual(state);
    expect(
      (await stat(join(home, "codex-runtime-switch.json"))).mode & 0o777,
    ).toBe(0o600);
    await clearCodexRuntimeSwitchState(paths);
    await expect(readCodexRuntimeSwitchState(paths)).resolves.toBeUndefined();
  });
});
