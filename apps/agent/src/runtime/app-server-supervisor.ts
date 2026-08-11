import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";

import type { HostPaths } from "../host/paths.js";
import {
  ProcessLock,
  type ProcessRecord,
  captureProcessRecord,
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
  writePrivateJsonAtomically,
} from "../host/process-files.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";

type AppServerSupervisorHooks = {
  afterSpawnBeforeOwnerPublish?: (child: ChildProcess) => Promise<void> | void;
};

type AppServerSupervisorOptions = {
  codexBinary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  hooks?: AppServerSupervisorHooks;
};

type AppServerStartupReservation = ProcessRecord & {
  recordType: "codex-app-server-startup";
  recordVersion: 1;
  appServerStartupNonce: string;
};

type AppServerProcessRecord = ProcessRecord & {
  appServerStartupNonce?: string;
};

const APP_SERVER_STARTUP_TIMEOUT_MS = 60_000;

export type AppServerInspection = {
  health:
    | "healthy"
    | "starting"
    | "live-unresponsive"
    | "stale-artifacts"
    | "stopped";
  socketExists: boolean;
  pid?: number;
  startupSupervisorPid?: number;
};

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

export async function inspectAppServer(
  paths: HostPaths,
): Promise<AppServerInspection> {
  const socketExists = await pathExists(paths.appServerSocket);
  if (await probeAppServer(paths.appServerSocket)) {
    const record = await readAppServerProcessRecord(paths);
    return {
      health: "healthy",
      socketExists: true,
      ...(record ? { pid: record.pid } : {}),
    };
  }

  const record = await readAppServerProcessRecord(paths);
  if (record && (await processRecordMatches(record))) {
    return {
      health: "live-unresponsive",
      socketExists,
      pid: record.pid,
    };
  }
  const reservation = await readStartupReservation(paths);
  if (reservation && (await processRecordMatches(reservation))) {
    return {
      health: "starting",
      socketExists,
      startupSupervisorPid: reservation.pid,
    };
  }
  if (record || reservation || socketExists) {
    return {
      health: "stale-artifacts",
      socketExists,
      ...(record ? { pid: record.pid } : {}),
      ...(reservation ? { startupSupervisorPid: reservation.pid } : {}),
    };
  }
  return { health: "stopped", socketExists: false };
}

export async function ensureAppServer(
  paths: HostPaths,
  options: AppServerSupervisorOptions = {},
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
  options: AppServerSupervisorOptions,
): Promise<{ started: boolean; pid?: number }> {
  if (await probeAppServer(paths.appServerSocket)) return { started: false };

  const existing = await readAppServerProcessRecord(paths);
  if (existing && (await processRecordMatches(existing))) {
    const reservation = await readStartupReservation(paths);
    if (
      reservation &&
      existing.appServerStartupNonce === reservation.appServerStartupNonce
    ) {
      await removeOwnedStartupReservation(paths, reservation);
    }
    throw new Error(
      `Codex app-server PID ${existing.pid} is still alive but its protocol endpoint is unresponsive; refusing to start a second instance`,
    );
  }
  await reclaimOrRejectStartupReservation(paths, existing);

  // The runtime directory is private to this Unix user. Only remove an
  // stale socket after both the protocol probe and recorded-owner check fail.
  await rm(paths.appServerPidFile, { force: true });
  await rm(paths.appServerSocket, { force: true });
  const startupReservation = await publishStartupReservation(paths);
  let child: ChildProcess | undefined;
  let childError: Error | undefined;
  let ownerRecord: AppServerProcessRecord | undefined;
  try {
    child = spawn(
      options.codexBinary ?? "codex",
      ["app-server", "--listen", `unix://${paths.appServerSocket}`],
      {
        detached: true,
        env: options.env ?? process.env,
        stdio: "ignore",
      },
    );
    child.once("error", (error) => {
      childError = error;
    });
    const childPid = child.pid;
    if (!childPid) {
      await new Promise<void>((resolve) => child!.once("close", resolve));
      throw new Error("Failed to start Codex app-server", {
        ...(childError ? { cause: childError } : {}),
      });
    }
    await options.hooks?.afterSpawnBeforeOwnerPublish?.(child);

    // Only immutable Linux identity fields are published here. Codex is
    // normally a `#!/usr/bin/env node` shim, so executable and cmdline may
    // legitimately change while the same PID execs env and then Node.
    const capturedOwner: AppServerProcessRecord = {
      ...(await captureProcessRecord(childPid, {
        includeMutableIdentity: false,
      })),
      appServerStartupNonce: startupReservation.appServerStartupNonce,
    };
    await writePrivateJsonAtomically(paths.appServerPidFile, capturedOwner);
    ownerRecord = capturedOwner;
    if (!(await removeOwnedStartupReservation(paths, startupReservation))) {
      throw new Error(
        "Codex app-server startup reservation changed before owner publication",
      );
    }
    const deadline =
      Date.now() + (options.timeoutMs ?? APP_SERVER_STARTUP_TIMEOUT_MS);
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
        child.unref();
        return { started: true, pid: childPid };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Timed out waiting for Codex app-server at ${paths.appServerSocket}`,
    );
  } catch (error) {
    if (child) await stopSpawnedChild(child);
    await cleanupSpawnedChild(paths, ownerRecord, startupReservation);
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
    hooks?: AppServerSupervisorHooks;
    expectedPid?: number;
  } = {},
): Promise<{ started: boolean; pid?: number }> {
  if (options.force !== true) {
    throw new Error(
      "Restarting Codex app-server can interrupt active turns; pass force: true after explicit user confirmation",
    );
  }
  const lock = await acquireSupervisorLock(paths);
  try {
    const record = await readAppServerProcessRecord(paths);
    const reservation = await readStartupReservation(paths);
    if (
      options.expectedPid !== undefined &&
      record?.pid !== options.expectedPid
    ) {
      throw new Error(
        `Codex app-server owner changed before recovery: expected PID ${options.expectedPid}, found ${record?.pid ?? "none"}`,
      );
    }
    if (record && (await processRecordMatches(record))) {
      if (
        reservation &&
        record.appServerStartupNonce !== reservation.appServerStartupNonce
      ) {
        throw ambiguousStartupReservationError(paths);
      }
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
        // `force` is an explicit acknowledgement that an unresponsive
        // app-server may still own an active turn. Escalate only after
        // revalidating the exact immutable process identity and command.
        await signalRecordedProcess(record, "SIGKILL", {
          ...(typeof process.getuid === "function"
            ? { uid: process.getuid() }
            : {}),
          commandIncludes: [
            "app-server",
            "--listen",
            `unix://${paths.appServerSocket}`,
          ],
        });
        const forcedDeadline = Date.now() + 5_000;
        while (
          Date.now() < forcedDeadline &&
          (await processRecordMatches(record))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (await processRecordMatches(record)) {
          throw new Error("Codex app-server did not stop after SIGKILL");
        }
      }
    } else if (await probeAppServer(paths.appServerSocket)) {
      throw new Error(
        "Cannot safely restart Codex app-server because its bound process identity is missing or stale",
      );
    }
    await reclaimOrRejectStartupReservation(paths, record);
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

function startupReservationPath(paths: HostPaths): string {
  return `${paths.appServerPidFile}.starting`;
}

async function publishStartupReservation(
  paths: HostPaths,
): Promise<AppServerStartupReservation> {
  const reservation: AppServerStartupReservation = {
    ...(await captureProcessRecord(process.pid)),
    recordType: "codex-app-server-startup",
    recordVersion: 1,
    appServerStartupNonce: randomUUID(),
  };
  try {
    await writePrivateJsonAtomically(
      startupReservationPath(paths),
      reservation,
    );
  } catch (error) {
    // No child exists yet, so a successfully-renamed reservation from a
    // directory-fsync failure can be removed without creating a spawn gap.
    await removeOwnedStartupReservation(paths, reservation).catch(() => false);
    throw error;
  }
  return reservation;
}

async function readStartupReservation(
  paths: HostPaths,
): Promise<AppServerStartupReservation | undefined> {
  const path = startupReservationPath(paths);
  const record = await readProcessRecord(path);
  if (!record) {
    if (await pathExists(path)) {
      throw new Error(
        `Invalid Codex app-server startup reservation at ${path}; refusing to start a second instance`,
      );
    }
    return undefined;
  }
  const candidate = record as ProcessRecord &
    Partial<
      Pick<
        AppServerStartupReservation,
        "recordType" | "recordVersion" | "appServerStartupNonce"
      >
    >;
  if (
    candidate.recordType !== "codex-app-server-startup" ||
    candidate.recordVersion !== 1 ||
    typeof candidate.appServerStartupNonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      candidate.appServerStartupNonce,
    ) ||
    (process.platform === "linux" &&
      (candidate.host === undefined ||
        candidate.procStartTime === undefined ||
        candidate.bootId === undefined ||
        candidate.uid === undefined))
  ) {
    throw new Error(
      `Invalid Codex app-server startup reservation at ${path}; refusing to start a second instance`,
    );
  }
  return candidate as AppServerStartupReservation;
}

async function readAppServerProcessRecord(
  paths: HostPaths,
): Promise<AppServerProcessRecord | undefined> {
  const record = await readProcessRecord(paths.appServerPidFile);
  if (!record && (await pathExists(paths.appServerPidFile))) {
    throw new Error(
      `Invalid Codex app-server process record at ${paths.appServerPidFile}; refusing to start a second instance`,
    );
  }
  return record as AppServerProcessRecord | undefined;
}

async function reclaimOrRejectStartupReservation(
  paths: HostPaths,
  processRecord: AppServerProcessRecord | undefined,
): Promise<void> {
  const reservation = await readStartupReservation(paths);
  if (!reservation) return;
  if (
    processRecord?.appServerStartupNonce === reservation.appServerStartupNonce
  ) {
    await removeOwnedStartupReservation(paths, reservation);
    return;
  }

  const currentHost = await captureProcessRecord(process.pid, {
    includeMutableIdentity: false,
  });
  if (
    process.platform === "linux" &&
    reservation.host === currentHost.host &&
    reservation.bootId !== currentHost.bootId
  ) {
    await removeOwnedStartupReservation(paths, reservation);
    return;
  }
  throw ambiguousStartupReservationError(paths);
}

function ambiguousStartupReservationError(paths: HostPaths): Error {
  const path = startupReservationPath(paths);
  return new Error(
    `Codex app-server startup ownership on this host boot is unresolved; refusing to start a second instance. Inspect the process and socket, then remove ${path} only after confirming that no startup child remains`,
  );
}

async function removeOwnedStartupReservation(
  paths: HostPaths,
  expected: AppServerStartupReservation,
): Promise<boolean> {
  const current = await readStartupReservation(paths);
  if (!current || !sameStartupReservation(current, expected)) return false;
  await rm(startupReservationPath(paths), { force: true });
  return true;
}

function sameStartupReservation(
  left: AppServerStartupReservation,
  right: AppServerStartupReservation,
): boolean {
  return (
    left.appServerStartupNonce === right.appServerStartupNonce &&
    sameProcessRecord(left, right)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function cleanupSpawnedChild(
  paths: HostPaths,
  ownerRecord: ProcessRecord | undefined,
  startupReservation: AppServerStartupReservation,
): Promise<void> {
  try {
    const current = await readProcessRecord(paths.appServerPidFile);
    if (
      ownerRecord
        ? !current || !sameAppServerProcessRecord(current, ownerRecord)
        : current !== undefined
    ) {
      // A successor or external repair replaced the ownership record. Its
      // socket and record no longer belong to this failed startup attempt.
      return;
    }
    await rm(paths.appServerSocket, { force: true });

    // Keep the ownership check adjacent to removal. The supervisor lock
    // excludes cooperating successors, while this second check also avoids
    // deleting a record replaced by an external recovery in the meantime.
    const recordBeforeRemoval = await readProcessRecord(paths.appServerPidFile);
    if (
      ownerRecord
        ? recordBeforeRemoval &&
          sameAppServerProcessRecord(recordBeforeRemoval, ownerRecord)
        : recordBeforeRemoval === undefined
    ) {
      await rm(paths.appServerPidFile, { force: true });
    }
  } finally {
    await removeOwnedStartupReservation(paths, startupReservation);
  }
}

function sameAppServerProcessRecord(
  left: ProcessRecord,
  right: AppServerProcessRecord,
): boolean {
  return (
    (left as AppServerProcessRecord).appServerStartupNonce ===
      right.appServerStartupNonce && sameProcessRecord(left, right)
  );
}

function sameProcessRecord(left: ProcessRecord, right: ProcessRecord): boolean {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.host === right.host &&
    left.procStartTime === right.procStartTime &&
    left.bootId === right.bootId &&
    left.uid === right.uid &&
    left.executable === right.executable &&
    sameOptionalStrings(left.cmdline, right.cmdline)
  );
}

function sameOptionalStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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
