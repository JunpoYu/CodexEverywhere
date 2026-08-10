import { randomUUID } from "node:crypto";
import {
  link,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { syncDirectoryForDurability } from "./durable-file.js";

export type ProcessRecord = {
  pid: number;
  startedAt: string;
  host?: string;
  procStartTime?: string;
  bootId?: string;
  uid?: number;
  executable?: string;
  cmdline?: string[];
};

export type ProcessRecordExpectation = {
  uid?: number;
  executable?: string;
  commandIncludes?: readonly string[];
  requireIdentity?: boolean;
};

export type AtomicRecordWriteOptions = {
  beforePublish?: (temporaryPath: string) => Promise<void> | void;
};

export type ProcessRecordCaptureOptions = {
  includeMutableIdentity?: boolean;
};

let linuxBootId: Promise<string | undefined> | undefined;

type FileIdentity = { dev: bigint; ino: bigint };

const PROCESS_LOCK_INITIALIZATION_GRACE_MS = 1_000;
const PROCESS_LOCK_RESTORE_TIMEOUT_MS = 20_000;

export class ProcessLock {
  readonly #path: string;
  readonly #ownerPath: string;
  #released = false;

  private constructor(path: string, ownerPath: string) {
    this.#path = path;
    this.#ownerPath = ownerPath;
  }

  static async acquire(path: string): Promise<ProcessLock> {
    const ownerPath = `${path}.owner.${randomUUID()}`;
    await createExclusiveRecord(ownerPath);
    try {
      while (true) {
        const quarantinedOwner = await blockingProcessLockQuarantine(path);
        if (quarantinedOwner) throw processLockHeldError(quarantinedOwner);
        try {
          await link(ownerPath, path);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const currentOwner = await inspectAndReclaimProcessLock(path);
          if (currentOwner) throw processLockHeldError(currentOwner);
          continue;
        }

        try {
          // A stale owner can race a takeover and temporarily move the new
          // public link. A post-publish quarantine check prevents both owners
          // from entering their critical sections.
          const displacedOwner = await blockingProcessLockQuarantine(path);
          if (displacedOwner) {
            await relinquishOwnedProcessLock(path, ownerPath);
            throw processLockHeldError(displacedOwner);
          }
          return new ProcessLock(path, ownerPath);
        } catch (error) {
          await relinquishOwnedProcessLock(path, ownerPath);
          throw error;
        }
      }
    } catch (error) {
      await rm(ownerPath, { force: true });
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    await relinquishOwnedProcessLock(this.#path, this.#ownerPath);
    await rm(this.#ownerPath, { force: true });
    this.#released = true;
  }
}

export async function writeProcessRecord(
  path: string,
  pid = process.pid,
  options: AtomicRecordWriteOptions & ProcessRecordCaptureOptions = {},
): Promise<ProcessRecord> {
  const record = await captureProcessRecord(pid, options);
  await writePrivateJsonAtomically(path, record, options);
  return record;
}

export async function writePrivateJsonAtomically(
  path: string,
  value: unknown,
  options: AtomicRecordWriteOptions = {},
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  let published = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforePublish?.(temporary);
    await rename(temporary, path);
    published = true;
    await syncDirectoryForDurability(dirname(path));
  } catch (error) {
    if (temporaryCreated && !published) await rm(temporary, { force: true });
    throw error;
  }
}

export async function readProcessRecord(
  path: string,
): Promise<ProcessRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      Number.isSafeInteger((value as ProcessRecord).pid) &&
      (value as ProcessRecord).pid > 0 &&
      typeof (value as ProcessRecord).startedAt === "string" &&
      optionalString((value as ProcessRecord).host) &&
      optionalString((value as ProcessRecord).procStartTime) &&
      optionalString((value as ProcessRecord).bootId) &&
      optionalSafeInteger((value as ProcessRecord).uid) &&
      optionalString((value as ProcessRecord).executable) &&
      optionalStringArray((value as ProcessRecord).cmdline)
    ) {
      return value as ProcessRecord;
    }
    return undefined;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

export async function processRecordMatches(
  record: ProcessRecord,
  expectation: ProcessRecordExpectation = {},
): Promise<boolean> {
  if (record.host !== undefined && record.host !== hostname()) return false;
  if (!isProcessAlive(record.pid)) return false;
  if (process.platform !== "linux") return true;

  const current = await readLinuxProcessIdentity(record.pid);
  if (!current) return false;
  if (
    record.procStartTime === undefined ||
    record.bootId === undefined ||
    record.uid === undefined
  ) {
    // Legacy records may still be reported as live during a rolling upgrade,
    // but they deliberately cannot authorize a signal.
    if (expectation.requireIdentity) return false;
    return matchesExpectation(current, expectation);
  }
  if (
    current.procStartTime !== record.procStartTime ||
    current.bootId !== record.bootId ||
    current.uid !== record.uid
  ) {
    return false;
  }
  // executable and cmdline are intentionally excluded from liveness. Both
  // can change while the same process identity remains alive (for example,
  // an atomic Node runtime upgrade changes /proc/<pid>/exe to a deleted
  // pathname). Callers that are about to signal a process still pass explicit
  // expectations below, which are checked against the current /proc values.
  return matchesExpectation(current, expectation);
}

/**
 * Returns true only when the record can be tied to this machine's current
 * boot. Hostnames alone are not unique across HPC login nodes, so a Linux
 * record with a missing or different boot id must be treated as foreign.
 */
export async function processRecordUsesCurrentHostIdentity(
  record: ProcessRecord,
): Promise<boolean> {
  if (record.host !== hostname()) return false;
  if (record.bootId === undefined) return process.platform !== "linux";
  const bootId = await readLinuxBootId();
  return bootId !== undefined && record.bootId === bootId;
}

export async function signalRecordedProcess(
  record: ProcessRecord,
  signal: NodeJS.Signals,
  expectation: ProcessRecordExpectation = {},
): Promise<void> {
  if (
    !(await processRecordMatches(record, {
      ...expectation,
      requireIdentity: true,
    }))
  ) {
    throw new Error(
      `Refusing to signal PID ${record.pid} because its recorded process identity no longer matches`,
    );
  }
  process.kill(record.pid, signal);
}

async function createExclusiveRecord(path: string): Promise<void> {
  const record = await captureProcessRecord(process.pid);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectAndReclaimProcessLock(
  path: string,
): Promise<ProcessRecord | "initializing" | undefined> {
  const proofPath = `${path}.proof.${randomUUID()}`;
  try {
    try {
      await link(path, proofPath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const snapshot = await readProcessLockSnapshot(proofPath);
    if (!snapshot) return undefined;
    if (snapshot.record && (await processRecordMayOwnLock(snapshot.record))) {
      return snapshot.record;
    }
    if (
      !snapshot.record &&
      Date.now() - snapshot.mtimeMs < PROCESS_LOCK_INITIALIZATION_GRACE_MS
    ) {
      return "initializing";
    }

    const quarantinePath = processLockQuarantinePath(path, "reclaim");
    try {
      await rename(path, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (await sameFile(quarantinePath, proofPath)) {
      await rm(quarantinePath, { force: true });
      await removeProcessLockOwnerAliases(path, proofPath);
      return undefined;
    }
    await restoreQuarantinedProcessLock(quarantinePath, path);
    return "initializing";
  } finally {
    await rm(proofPath, { force: true });
  }
}

async function relinquishOwnedProcessLock(
  path: string,
  ownerPath: string,
): Promise<void> {
  const quarantinePath = processLockQuarantinePath(path, "release");
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (await sameFile(quarantinePath, ownerPath)) {
    await rm(quarantinePath, { force: true });
  } else if (await pathExists(quarantinePath)) {
    await restoreQuarantinedProcessLock(quarantinePath, path);
  }

  for (const candidate of await processLockQuarantines(path)) {
    if (await sameFile(candidate, ownerPath)) {
      await rm(candidate, { force: true });
    }
  }
}

async function blockingProcessLockQuarantine(
  path: string,
): Promise<ProcessRecord | "initializing" | undefined> {
  for (const candidate of await processLockQuarantines(path)) {
    const snapshot = await readProcessLockSnapshot(candidate);
    if (!snapshot) continue;
    if (snapshot.record && (await processRecordMayOwnLock(snapshot.record))) {
      return snapshot.record;
    }
    if (
      !snapshot.record &&
      Date.now() - snapshot.mtimeMs < PROCESS_LOCK_INITIALIZATION_GRACE_MS
    ) {
      return "initializing";
    }
    await rm(candidate, { force: true });
  }
  return undefined;
}

async function processRecordMayOwnLock(
  record: ProcessRecord,
): Promise<boolean> {
  // ProcessLock is used for host-local services. A foreign-host record cannot
  // be proven stale from this host's /proc, so fail closed instead of stealing
  // it. HostStateStore has a separate heartbeat lease for shared filesystems.
  return (
    (record.host !== undefined && record.host !== hostname()) ||
    processRecordMatches(record)
  );
}

function processLockHeldError(owner: ProcessRecord | "initializing"): Error {
  return new Error(
    owner === "initializing"
      ? "CodexEverywhere agent is already running (lock is initializing)"
      : `CodexEverywhere agent is already running (PID ${owner.pid})`,
  );
}

async function restoreQuarantinedProcessLock(
  quarantinePath: string,
  path: string,
): Promise<void> {
  const deadline = Date.now() + PROCESS_LOCK_RESTORE_TIMEOUT_MS;
  while (await pathExists(quarantinePath)) {
    try {
      await link(quarantinePath, path);
      await rm(quarantinePath, { force: true });
      return;
    } catch (error) {
      if (isMissing(error)) return;
      if (!isAlreadyExists(error)) throw error;
    }
    if (await sameFile(quarantinePath, path)) {
      await rm(quarantinePath, { force: true });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out restoring a displaced process lock owner");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function processLockQuarantines(path: string): Promise<string[]> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.quarantine.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(directory, entry));
}

function processLockQuarantinePath(
  path: string,
  purpose: "reclaim" | "release",
): string {
  return `${path}.quarantine.${purpose}.${randomUUID()}`;
}

async function removeProcessLockOwnerAliases(
  path: string,
  identityPath: string,
): Promise<void> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.owner.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const candidate = join(directory, entry);
        if (await sameFile(candidate, identityPath)) {
          await rm(candidate, { force: true });
        }
      }),
  );
}

async function readProcessLockSnapshot(path: string): Promise<
  | {
      record: ProcessRecord | undefined;
      mtimeMs: number;
    }
  | undefined
> {
  try {
    const metadata = await stat(path);
    return {
      record: await readProcessRecord(path),
      mtimeMs: metadata.mtimeMs,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function sameFile(first: string, second: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      fileIdentity(first),
      fileIdentity(second),
    ]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const metadata = await stat(path, { bigint: true });
  return { dev: metadata.dev, ino: metadata.ino };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function captureProcessRecord(
  pid: number,
  options: ProcessRecordCaptureOptions = {},
): Promise<ProcessRecord> {
  const startedAt = new Date().toISOString();
  const host = hostname();
  if (process.platform !== "linux") return { pid, startedAt, host };
  const identity = await readLinuxProcessIdentity(pid);
  if (!identity) {
    throw new Error(`Cannot read Linux process identity for PID ${pid}`);
  }
  if (options.includeMutableIdentity ?? true) {
    return { pid, startedAt, host, ...identity };
  }
  const { executable: _executable, cmdline: _cmdline, ...immutable } = identity;
  return { pid, startedAt, host, ...immutable };
}

async function readLinuxProcessIdentity(pid: number): Promise<
  | {
      procStartTime: string;
      bootId: string;
      uid: number;
      executable?: string;
      cmdline: string[];
    }
  | undefined
> {
  try {
    const [stat, status, bootId, executable, command] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
      readLinuxBootId(),
      readlink(`/proc/${pid}/exe`).catch(() => undefined),
      readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0)),
    ]);
    if (!bootId) return undefined;
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/u);
    const procStartTime = fields[19];
    const uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
    if (!procStartTime || uid === undefined) return undefined;
    const cmdline = command
      .toString("utf8")
      .split("\0")
      .filter((part) => part.length > 0);
    return {
      procStartTime,
      bootId,
      uid: Number(uid),
      ...(executable ? { executable } : {}),
      cmdline,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function readLinuxBootId(): Promise<string | undefined> {
  linuxBootId ??= readFile("/proc/sys/kernel/random/boot_id", "utf8")
    .then((value) => value.trim() || undefined)
    .catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
  return linuxBootId;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function matchesExpectation(
  current: {
    uid: number;
    executable?: string;
    cmdline: readonly string[];
  },
  expectation: ProcessRecordExpectation,
): boolean {
  if (expectation.uid !== undefined && current.uid !== expectation.uid) {
    return false;
  }
  if (
    expectation.executable !== undefined &&
    current.executable !== expectation.executable
  ) {
    return false;
  }
  return !expectation.commandIncludes?.some(
    (part) => !current.cmdline.includes(part),
  );
}

function isAlreadyExists(error: unknown): boolean {
  return isCode(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return isCode(error, "ENOENT");
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
