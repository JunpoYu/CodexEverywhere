import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { HostPaths } from "../host/paths.js";
import { syncDirectoryForDurability } from "../host/durable-file.js";
import { writePrivateJsonAtomically } from "../host/process-files.js";

export type CodexRuntimeSwitchState = {
  readonly version: 1;
  readonly phase: "installing" | "restart-required";
  readonly createdAt: string;
  readonly installedVersion?: string;
};

export async function readCodexRuntimeSwitchState(
  paths: HostPaths,
): Promise<CodexRuntimeSwitchState | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(runtimeSwitchPath(paths), "utf8"),
    );
    if (!isCodexRuntimeSwitchState(value)) {
      throw new Error("Invalid Codex runtime switch state");
    }
    return value;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export function writeCodexRuntimeSwitchState(
  paths: HostPaths,
  state: CodexRuntimeSwitchState,
): Promise<void> {
  if (!isCodexRuntimeSwitchState(state)) {
    throw new Error("Refusing to write invalid Codex runtime switch state");
  }
  return writePrivateJsonAtomically(runtimeSwitchPath(paths), state);
}

export async function clearCodexRuntimeSwitchState(
  paths: HostPaths,
): Promise<void> {
  try {
    await rm(runtimeSwitchPath(paths));
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  await syncDirectoryForDurability(paths.home);
}

function runtimeSwitchPath(paths: HostPaths): string {
  return join(paths.home, "codex-runtime-switch.json");
}

function isCodexRuntimeSwitchState(
  value: unknown,
): value is CodexRuntimeSwitchState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    (record.phase === "installing" || record.phase === "restart-required") &&
    typeof record.createdAt === "string" &&
    (record.installedVersion === undefined ||
      (typeof record.installedVersion === "string" &&
        record.installedVersion.length > 0 &&
        record.installedVersion.length <= 256))
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
