import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

import type { HostPaths } from "./paths.js";

const MARKER_START = "# BEGIN CODEXEVERYWHERE WATCHDOG";
const MARKER_END = "# END CODEXEVERYWHERE WATCHDOG";

export async function installWatchdog(
  paths: HostPaths,
  runtime: { nodePath: string; cliPath: string },
): Promise<{ scriptPath: string; sessionName: string }> {
  const scriptPath = join(paths.home, "bin", "watchdog.sh");
  const sessionName = `codex-everywhere-${process.getuid?.() ?? "user"}`;
  const logPath = join(paths.logsDir, "agent.log");
  const watchdogLock = `${scriptPath}.lock`;
  const tmuxPath = await resolveExecutable("tmux");
  const script = renderWatchdogScript(paths, runtime, tmuxPath);
  await writeExecutable(scriptPath, script);

  const existing = await readCrontab();
  const withoutManagedBlock = removeManagedBlock(existing);
  const block = `${MARKER_START}\n* * * * * ${shellQuote(scriptPath)}\n${MARKER_END}`;
  const updated = `${withoutManagedBlock.trimEnd()}${withoutManagedBlock.trim() ? "\n" : ""}${block}\n`;
  await writeCrontab(updated);
  return { scriptPath, sessionName };
}

export function renderWatchdogScript(
  paths: HostPaths,
  runtime: { nodePath: string; cliPath: string },
  tmuxPath: string,
): string {
  const scriptPath = join(paths.home, "bin", "watchdog.sh");
  const sessionName = `codex-everywhere-${process.getuid?.() ?? "user"}`;
  const logPath = join(paths.logsDir, "agent.log");
  const watchdogLock = `${scriptPath}.lock`;
  const disabledMarker = `/etc/codex-everywhere-access/${process.getuid?.() ?? "unknown"}.disabled`;
  return `#!/bin/sh
set -eu
SESSION=${shellQuote(sessionName)}
LOG=${shellQuote(logPath)}
LOCK=${shellQuote(watchdogLock)}
TMUX=${shellQuote(tmuxPath)}
DISABLED=${shellQuote(disabledMarker)}
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT HUP INT TERM
if [ -f "$DISABLED" ]; then
  if "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
    "$TMUX" kill-session -t "$SESSION" || true
  fi
  exit 0
fi
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 10485760 ]; then
  if "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
    "$TMUX" send-keys -t "$SESSION" C-c || true
    ATTEMPTS=0
    while "$TMUX" has-session -t "$SESSION" 2>/dev/null && [ "$ATTEMPTS" -lt 10 ]; do
      sleep 1
      ATTEMPTS=$((ATTEMPTS + 1))
    done
    if "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
      "$TMUX" kill-session -t "$SESSION" || true
    fi
  fi
  mv -f "$LOG" "$LOG.1"
fi
if ! "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
  "$TMUX" new-session -d -s "$SESSION" ${shellQuote(`${runtime.nodePath} ${shellQuote(runtime.cliPath)} agent serve >> ${shellQuote(logPath)} 2>&1`)}
fi
`;
}

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH until an executable candidate is found.
    }
  }
  throw new Error(`Could not find executable in PATH: ${command}`);
}

export function removeManagedBlock(crontab: string): string {
  const lines = crontab.split(/\r?\n/);
  const output: string[] = [];
  let managed = false;
  for (const line of lines) {
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

async function readCrontab(): Promise<string> {
  const result = await run("crontab", ["-l"], undefined, true);
  return result.code === 0 ? result.stdout : "";
}

async function writeCrontab(contents: string): Promise<void> {
  const result = await run("crontab", ["-"], contents);
  if (result.code !== 0) throw new Error("Could not install user crontab");
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o700);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o700);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function run(
  command: string,
  args: string[],
  input?: string,
  tolerateFailure = false,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", (error) => {
      if (tolerateFailure) resolve({ code: 1, stdout: "" });
      else reject(error);
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(input);
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
