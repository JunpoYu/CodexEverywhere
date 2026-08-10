import { spawn, type ChildProcess } from "node:child_process";
import { rm, stat } from "node:fs/promises";

import type { HostPaths } from "../host/paths.js";
import {
  ProcessLock,
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
  writeProcessRecord,
} from "../host/process-files.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

export async function probeAppServer(socketPath: string): Promise<boolean> {
  try {
    if (!(await stat(socketPath)).isSocket()) return false;
    const client = await CodexAppServerClient.connectUnix(socketPath, {
      timeoutMs: 2_000,
    });
    await client.close();
    return true;
  } catch {
    return false;
  }
}

export async function ensureAppServer(
  paths: HostPaths,
  options: {
    codexBinary?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<{ started: boolean; pid?: number }> {
  const lock = await acquireSupervisorLock(paths);
  try {
    return await ensureAppServerLocked(paths, options);
  } finally {
    await lock.release();
  }
}

async function ensureAppServerLocked(
  paths: HostPaths,
  options: {
    codexBinary?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ started: boolean; pid?: number }> {
  if (await probeAppServer(paths.appServerSocket)) return { started: false };

  const existing = await readProcessRecord(paths.appServerPidFile);
  if (existing && (await processRecordMatches(existing))) {
    throw new Error(
      `Codex app-server PID ${existing.pid} is still alive but its protocol endpoint is unresponsive; refusing to start a second instance`,
    );
  }

  // The runtime directory is private to this Unix user. Only remove an
  // stale socket after both the protocol probe and recorded-owner check fail.
  await rm(paths.appServerSocket, { force: true });
  const child = spawn(
    options.codexBinary ?? "codex",
    ["app-server", "--listen", `unix://${paths.appServerSocket}`],
    {
      detached: true,
      env: options.env ?? process.env,
      stdio: "ignore",
    },
  );
  let childError: Error | undefined;
  child.once("error", (error) => {
    childError = error;
  });
  const childPid = child.pid;
  if (!childPid) {
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    throw new Error("Failed to start Codex app-server", {
      ...(childError ? { cause: childError } : {}),
    });
  }

  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  try {
    while (Date.now() < deadline) {
      if (childError) {
        throw new Error("Failed to start Codex app-server", {
          cause: childError,
        });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Codex app-server exited before becoming ready");
      }
      if (await probeAppServer(paths.appServerSocket)) {
        await writeProcessRecord(paths.appServerPidFile, childPid);
        child.unref();
        return { started: true, pid: childPid };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Timed out waiting for Codex app-server at ${paths.appServerSocket}`,
    );
  } catch (error) {
    await stopSpawnedChild(child);
    await rm(paths.appServerPidFile, { force: true });
    await rm(paths.appServerSocket, { force: true });
    throw error;
  }
}

export async function restartAppServer(
  paths: HostPaths,
  options: {
    codexBinary?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    force?: boolean;
  } = {},
): Promise<{ started: boolean; pid?: number }> {
  if (options.force !== true) {
    throw new Error(
      "Restarting Codex app-server can interrupt active turns; pass force: true after explicit user confirmation",
    );
  }
  const lock = await acquireSupervisorLock(paths);
  try {
    const record = await readProcessRecord(paths.appServerPidFile);
    if (record && (await processRecordMatches(record))) {
      await signalRecordedProcess(record, "SIGTERM", {
        ...(typeof process.getuid === "function"
          ? { uid: process.getuid() }
          : {}),
        commandIncludes: [
          "app-server",
          "--listen",
          `unix://${paths.appServerSocket}`,
        ],
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await processRecordMatches(record))) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (await processRecordMatches(record)) {
        throw new Error("Codex app-server did not stop cleanly");
      }
    } else if (await probeAppServer(paths.appServerSocket)) {
      throw new Error(
        "Cannot safely restart Codex app-server because its bound process identity is missing or stale",
      );
    }
    await rm(paths.appServerPidFile, { force: true });
    await rm(paths.appServerSocket, { force: true });
    return await ensureAppServerLocked(paths, options);
  } finally {
    await lock.release();
  }
}

async function acquireSupervisorLock(paths: HostPaths): Promise<ProcessLock> {
  const lockPath = `${paths.appServerPidFile}.supervisor.lock`;
  const deadline = Date.now() + 20_000;
  while (true) {
    try {
      return await ProcessLock.acquire(lockPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("already running") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function stopSpawnedChild(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if ((await waitForExit(exited, 5_000)) === "exited") return;
  child.kill("SIGKILL");
  await exited;
}

async function waitForExit(
  exited: Promise<void>,
  timeoutMs: number,
): Promise<"exited" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
