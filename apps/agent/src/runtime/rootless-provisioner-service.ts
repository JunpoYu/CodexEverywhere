import { spawn } from "node:child_process";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveRootlessProvisionerPaths } from "../admin/rootless-provisioner.js";
import {
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
} from "../host/process-files.js";
import { resolveExecutable } from "../host/watchdog.js";

const MARKER_START = "# BEGIN CODEXEVERYWHERE ROOTLESS PROVISIONER";
const MARKER_END = "# END CODEXEVERYWHERE ROOTLESS PROVISIONER";

export async function installRootlessProvisionerWatchdog(
  runtime: { nodePath: string; cliPath: string },
  paths = resolveRootlessProvisionerPaths(),
): Promise<{ scriptPath: string; sessionName: string }> {
  const tmuxPath = await resolveExecutable("tmux");
  const sessionName = `codex-everywhere-provisioner-${String(process.getuid?.())}`;
  const logPath = `${paths.logsDirectory}/provisioner.log`;
  const lockPath = `${paths.watchdogScript}.lock`;
  await mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 });
  await chmod(paths.logsDirectory, 0o700);
  const command = `${shellQuote(runtime.nodePath)} ${shellQuote(runtime.cliPath)} provisioner serve >> ${shellQuote(logPath)} 2>&1`;
  const script = `#!/bin/sh
set -eu
SESSION=${shellQuote(sessionName)}
TMUX=${shellQuote(tmuxPath)}
LOCK=${shellQuote(lockPath)}
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT HUP INT TERM
if ! "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
  "$TMUX" new-session -d -s "$SESSION" ${shellQuote(command)}
fi
`;
  await writeExecutable(paths.watchdogScript, script);
  const existing = await readCrontab();
  const cleaned = removeProvisionerBlock(existing);
  const block = `${MARKER_START}\n* * * * * ${shellQuote(paths.watchdogScript)}\n${MARKER_END}`;
  await writeCrontab(
    `${cleaned.trimEnd()}${cleaned.trim() ? "\n" : ""}${block}\n`,
  );
  await run(paths.watchdogScript, []);
  return { scriptPath: paths.watchdogScript, sessionName };
}

export async function rootlessProvisionerStatus(
  paths = resolveRootlessProvisionerPaths(),
): Promise<{ running: boolean; pid?: number }> {
  const record = await readProcessRecord(paths.pidFile);
  return record && (await processRecordMatches(record))
    ? { running: true, pid: record.pid }
    : { running: false };
}

export async function stopRootlessProvisioner(
  paths = resolveRootlessProvisionerPaths(),
): Promise<boolean> {
  const record = await readProcessRecord(paths.pidFile);
  if (!record || !(await processRecordMatches(record))) {
    await rm(paths.pidFile, { force: true });
    return false;
  }
  await signalRecordedProcess(record, "SIGTERM", {
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
    commandIncludes: ["provisioner", "serve"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await processRecordMatches(record)))
    await wait(50);
  if (await processRecordMatches(record))
    throw new Error("Rootless provisioner did not stop after SIGTERM");
  return true;
}

export function removeProvisionerBlock(crontab: string): string {
  const output: string[] = [];
  let managed = false;
  for (const line of crontab.split(/\r?\n/u)) {
    if (line === MARKER_START) {
      managed = true;
      continue;
    }
    if (line === MARKER_END) {
      managed = false;
      continue;
    }
    if (!managed) output.push(line);
  }
  return output.join("\n");
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "w", 0o700);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o700);
}

async function readCrontab(): Promise<string> {
  const result = await run("crontab", ["-l"], undefined, true);
  return result.code === 0 ? result.stdout : "";
}

async function writeCrontab(contents: string): Promise<void> {
  const result = await run("crontab", ["-"], contents);
  if (result.code !== 0)
    throw new Error("Could not install rootless provisioner crontab");
}

function run(
  command: string,
  args: string[],
  input?: string,
  allowFailure = false,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1_024) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1_024) stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited from signal ${signal}`));
      else if (!allowFailure && code !== 0)
        reject(new Error(`${command} failed: ${stderr.trim()}`));
      else resolve({ code: code ?? 1, stdout });
    });
    child.stdin.end(input);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
