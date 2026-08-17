import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

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
  const child = spawn(process.execPath, [cliEntryPoint, "agent", "serve"], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    throw new Error("Failed to start CodexEverywhere Agent");
  }
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = await readProcessRecord(paths.agentPidFile);
    if (
      record !== undefined &&
      record.pid === child.pid &&
      (await processRecordMatches(record))
    ) {
      return { started: true, pid: record.pid };
    }
    if (!isProcessAlive(child.pid)) break;
    await delay(50);
  }
  throw new Error("CodexEverywhere Agent did not become ready");
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
