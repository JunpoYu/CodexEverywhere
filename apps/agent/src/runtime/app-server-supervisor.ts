import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";

import type { HostPaths } from "../host/paths.js";
import {
  isProcessAlive,
  readProcessRecord,
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
  if (await probeAppServer(paths.appServerSocket)) return { started: false };

  // The runtime directory is private to this Unix user. Only remove an
  // unresponsive socket after a real protocol probe has failed.
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
  if (!child.pid) throw new Error("Failed to start Codex app-server");
  child.unref();
  await writeProcessRecord(paths.appServerPidFile, child.pid);

  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (await probeAppServer(paths.appServerSocket)) {
      return { started: true, pid: child.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for Codex app-server at ${paths.appServerSocket}`,
  );
}

export async function restartAppServer(
  paths: HostPaths,
  options: {
    codexBinary?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<{ started: boolean; pid?: number }> {
  const record = await readProcessRecord(paths.appServerPidFile);
  if (record && isProcessAlive(record.pid)) {
    process.kill(record.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && isProcessAlive(record.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (isProcessAlive(record.pid))
      throw new Error("Codex app-server did not stop cleanly");
  } else if (await probeAppServer(paths.appServerSocket)) {
    throw new Error(
      "Cannot safely restart Codex app-server because its process record is missing",
    );
  }
  await rm(paths.appServerPidFile, { force: true });
  await rm(paths.appServerSocket, { force: true });
  return ensureAppServer(paths, options);
}
