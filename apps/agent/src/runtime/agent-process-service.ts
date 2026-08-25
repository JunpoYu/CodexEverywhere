import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { join } from "node:path";

import { assertUserAccessEnabled } from "../admin/access-policy.js";
import type { HostPaths } from "../host/paths.js";
import {
  isProcessAlive,
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
} from "../host/process-files.js";

export async function startAgentService(
  paths: HostPaths,
  cliEntryPoint: string,
): Promise<{ readonly started: boolean; readonly pid: number }> {
  await assertUserAccessEnabled();
  const existing = await readProcessRecord(paths.agentPidFile);
  if (existing && (await processRecordMatches(existing))) {
    return { started: false, pid: existing.pid };
  }
  const watchdogScript = join(paths.home, "bin", "watchdog.sh");
  if (await isExecutable(watchdogScript)) {
    await runWatchdog(watchdogScript);
    const record = await waitForAgentRecord(paths);
    return { started: true, pid: record.pid };
  }
  const child = spawn(process.execPath, [cliEntryPoint, "agent", "serve"], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    throw new Error("Failed to start CodexEverywhere Agent");
  }
  child.unref();
  const record = await waitForAgentRecord(paths, child.pid);
  return { started: true, pid: record.pid };
}

async function waitForAgentRecord(paths: HostPaths, expectedPid?: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = await readProcessRecord(paths.agentPidFile);
    if (
      record !== undefined &&
      (expectedPid === undefined || record.pid === expectedPid) &&
      (await processRecordMatches(record))
    ) {
      return record;
    }
    if (expectedPid !== undefined && !isProcessAlive(expectedPid)) break;
    await delay(50);
  }
  throw new Error("CodexEverywhere Agent did not become ready");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runWatchdog(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("CodexEverywhere watchdog failed to start Agent"));
    });
  });
}

export async function stopAgentService(paths: HostPaths): Promise<boolean> {
  const record = await readProcessRecord(paths.agentPidFile);
  if (record === undefined || !(await processRecordMatches(record))) {
    await rm(paths.agentPidFile, { force: true });
    return false;
  }
  await signalRecordedProcess(record, "SIGTERM", {
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
    commandIncludes: ["agent", "serve"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await processRecordMatches(record))) {
    await delay(50);
  }
  if (await processRecordMatches(record)) {
    throw new Error(`Agent PID ${record.pid} did not stop after SIGTERM`);
  }
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
