import { randomUUID } from "node:crypto";
import {
  chown,
  link,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  processRecordMatches,
  processRecordUsesCurrentHostIdentity,
  readProcessRecord,
  writeProcessRecord,
} from "./process-files.js";

export interface StateLock {
  beginCommit(): Promise<StateCommitFence>;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export interface StateCommitFence {
  release(): Promise<void>;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface StateLockWait {
  readonly deadline?: number;
  readonly signals?: readonly AbortSignal[];
}

const STATE_LOCK_TIMEOUT_MS = 10_000;
const STATE_LOCK_POLL_MS = 25;
const STATE_LOCK_HEARTBEAT_MS = 5_000;
const STATE_LOCK_LEASE_MS = 60_000;
const abandonedStateLockOwners = new Map<string, Set<string>>();

/**
 * Cross-process lock used by both v0.3 and v0.4 state stores. The commit fence
 * prevents an expired writer from publishing a stale sql.js snapshot after a
 * successor has reclaimed the renewable lease.
 */
export async function acquireStateLock(
  path: string,
  options: {
    readonly waitIndefinitely?: boolean;
    readonly signals?: readonly AbortSignal[];
    /** Root helpers use the state owner's UID/GID for hard-link-safe lock files. */
    readonly fileOwner?: { readonly uid: number; readonly gid: number };
  } = {},
): Promise<StateLock> {
  const wait: StateLockWait = {
    ...(options.waitIndefinitely
      ? {}
      : { deadline: Date.now() + STATE_LOCK_TIMEOUT_MS }),
    ...(options.signals ? { signals: options.signals } : {}),
  };
  assertStateLockWaitActive(wait);
  await retryAbandonedStateLockReleases(path);
  while (true) {
    assertStateLockWaitActive(wait);
    if (
      (await stateCommitFenceIsBlocking(path, wait)) ||
      (await hasBlockingQuarantine(path))
    ) {
      await waitForStateLock(wait);
      continue;
    }

    const ownerPath = await createStateLockOwner(path, options.fileOwner);
    let acquired = false;
    let published = false;
    try {
      try {
        await link(ownerPath, path);
        published = true;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (!(await reclaimStaleStateLock(path, wait))) {
          await waitForStateLock(wait);
        }
        continue;
      }

      if (await hasBlockingQuarantine(path)) {
        await relinquishOwnedStateLock(path, ownerPath);
        published = false;
        await waitForStateLock(wait);
        continue;
      }

      assertStateLockWaitActive(wait);
      let released = false;
      const stopHeartbeat = startStateLockHeartbeat(ownerPath);
      acquired = true;
      return {
        beginCommit: () => acquireStateCommitFence(path, ownerPath),
        assertOwned: () => assertOwnedStateLock(path, ownerPath),
        release: async () => {
          if (released) return;
          stopHeartbeat();
          try {
            await relinquishOwnedStateLock(path, ownerPath);
            await rm(ownerPath, { force: true });
            forgetAbandonedStateLockOwner(path, ownerPath);
            released = true;
          } catch (error) {
            rememberAbandonedStateLockOwner(path, ownerPath);
            throw error;
          }
        },
      };
    } finally {
      if (!acquired) {
        if (published) {
          try {
            await relinquishOwnedStateLock(path, ownerPath);
            published = false;
          } catch (error) {
            rememberAbandonedStateLockOwner(path, ownerPath);
            throw error;
          }
        }
        if (!published) await rm(ownerPath, { force: true });
      }
    }
  }
}

async function createStateLockOwner(
  path: string,
  fileOwner?: { readonly uid: number; readonly gid: number },
): Promise<string> {
  const token = randomUUID();
  const ownerPath = `${path}.owner.${token}`;
  await writeProcessRecord(ownerPath);
  if (fileOwner !== undefined) {
    if (process.getuid?.() !== 0) {
      await rm(ownerPath, { force: true });
      throw new Error("Only root can assign state lock ownership");
    }
    await chown(ownerPath, fileOwner.uid, fileOwner.gid);
  }
  return ownerPath;
}

async function reclaimStaleStateLock(
  path: string,
  wait: StateLockWait,
): Promise<boolean> {
  if (await stateCommitFenceIsBlocking(path, wait)) return false;
  const proofPath = `${path}.proof.${randomUUID()}`;
  try {
    try {
      await link(path, proofPath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }

    const snapshot = await readStateLockSnapshot(proofPath);
    if (!snapshot) return true;
    if (await stateLockLeaseIsActive(snapshot)) return false;

    const quarantinePath = stateLockQuarantinePath(path, "reclaim");
    try {
      await rename(path, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }

    if (await sameFile(quarantinePath, proofPath)) {
      const current = await readStateLockSnapshot(quarantinePath);
      if (
        (await stateCommitFenceIsBlocking(path, wait)) ||
        (current && (await stateLockLeaseIsActive(current)))
      ) {
        await restoreQuarantinedStateLock(quarantinePath, path, wait);
        return false;
      }
      await rm(quarantinePath, { force: true });
      return true;
    }

    await restoreQuarantinedStateLock(quarantinePath, path, wait);
    return false;
  } finally {
    await rm(proofPath, { force: true });
  }
}

async function acquireStateCommitFence(
  path: string,
  ownerPath: string,
): Promise<StateCommitFence> {
  const fencePath = stateCommitFencePath(path);
  try {
    await link(ownerPath, fencePath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    throw new Error("Host state commit fence is already held");
  }
  try {
    await assertOwnedStateLock(path, ownerPath);
  } catch (error) {
    await relinquishOwnedStateCommitFence(fencePath, ownerPath);
    throw error;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      await relinquishOwnedStateCommitFence(fencePath, ownerPath);
      released = true;
    },
  };
}

async function stateCommitFenceIsBlocking(
  path: string,
  wait: StateLockWait = boundedStateLockWait(),
): Promise<boolean> {
  const fencePath = stateCommitFencePath(path);
  const proofPath = `${fencePath}.proof.${randomUUID()}`;
  try {
    try {
      await link(fencePath, proofPath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const snapshot = await readStateLockSnapshot(proofPath);
    if (
      !snapshot?.record ||
      !(await processRecordUsesCurrentHostIdentity(snapshot.record)) ||
      (await stateLockProcessIdentityMatches(snapshot.record))
    ) {
      return true;
    }

    const quarantinePath = `${fencePath}.quarantine.reclaim.${randomUUID()}`;
    try {
      await rename(fencePath, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    if (await sameFile(quarantinePath, proofPath)) {
      await rm(quarantinePath, { force: true });
      return false;
    }
    await restoreQuarantinedStateLock(quarantinePath, fencePath, wait);
    return true;
  } finally {
    await rm(proofPath, { force: true });
  }
}

async function relinquishOwnedStateCommitFence(
  fencePath: string,
  ownerPath: string,
): Promise<void> {
  const quarantinePath = `${fencePath}.quarantine.release.${randomUUID()}`;
  try {
    await rename(fencePath, quarantinePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (await sameFile(quarantinePath, ownerPath)) {
    await rm(quarantinePath, { force: true });
  } else if (await pathExists(quarantinePath)) {
    await restoreQuarantinedStateLock(quarantinePath, fencePath);
  }
}

function stateCommitFencePath(path: string): string {
  return `${path}.commit`;
}

async function assertOwnedStateLock(
  path: string,
  ownerPath: string,
): Promise<void> {
  try {
    const now = new Date();
    await utimes(ownerPath, now, now);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new Error("Host state transaction lease was lost before commit");
  }
  if (!(await sameFile(path, ownerPath))) {
    throw new Error("Host state transaction lease was lost before commit");
  }
}

async function relinquishOwnedStateLock(
  path: string,
  ownerPath: string,
): Promise<void> {
  const quarantinePath = stateLockQuarantinePath(path, "release");
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (await sameFile(quarantinePath, ownerPath)) {
    await rm(quarantinePath, { force: true });
  } else if (await pathExists(quarantinePath)) {
    await restoreQuarantinedStateLock(quarantinePath, path);
  }

  for (const candidate of await stateLockQuarantines(path)) {
    if (await sameFile(candidate, ownerPath)) {
      await rm(candidate, { force: true });
    }
  }
}

async function hasBlockingQuarantine(path: string): Promise<boolean> {
  let blocked = false;
  for (const candidate of await stateLockQuarantines(path)) {
    const snapshot = await readStateLockSnapshot(candidate);
    if (!snapshot) continue;
    if (await stateLockLeaseIsActive(snapshot)) {
      blocked = true;
      continue;
    }
    await rm(candidate, { force: true });
  }
  return blocked;
}

async function stateLockLeaseIsActive(
  snapshot: NonNullable<Awaited<ReturnType<typeof readStateLockSnapshot>>>,
): Promise<boolean> {
  if (
    snapshot.record &&
    (await processRecordUsesCurrentHostIdentity(snapshot.record))
  ) {
    return stateLockProcessIdentityMatches(snapshot.record);
  }
  return Date.now() - snapshot.mtimeMs >= 0
    ? Date.now() - snapshot.mtimeMs < STATE_LOCK_LEASE_MS
    : true;
}

function stateLockProcessIdentityMatches(
  record: NonNullable<Awaited<ReturnType<typeof readProcessRecord>>>,
): Promise<boolean> {
  const { executable: _executable, cmdline: _cmdline, ...identity } = record;
  return processRecordMatches(identity);
}

function startStateLockHeartbeat(ownerPath: string): () => void {
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(ownerPath, now, now).catch(() => undefined);
  }, STATE_LOCK_HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function rememberAbandonedStateLockOwner(
  path: string,
  ownerPath: string,
): void {
  const owners = abandonedStateLockOwners.get(path) ?? new Set<string>();
  owners.add(ownerPath);
  abandonedStateLockOwners.set(path, owners);
}

function forgetAbandonedStateLockOwner(path: string, ownerPath: string): void {
  const owners = abandonedStateLockOwners.get(path);
  owners?.delete(ownerPath);
  if (owners?.size === 0) abandonedStateLockOwners.delete(path);
}

async function retryAbandonedStateLockReleases(path: string): Promise<void> {
  const owners = abandonedStateLockOwners.get(path);
  if (!owners) return;
  for (const ownerPath of [...owners]) {
    try {
      await relinquishOwnedStateLock(path, ownerPath);
      await rm(ownerPath, { force: true });
      forgetAbandonedStateLockOwner(path, ownerPath);
    } catch {
      // The normal bounded acquisition remains the final backstop.
    }
  }
}

async function restoreQuarantinedStateLock(
  quarantinePath: string,
  path: string,
  wait: StateLockWait = boundedStateLockWait(),
): Promise<void> {
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
    await waitForStateLock(wait);
  }
}

async function stateLockQuarantines(path: string): Promise<string[]> {
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

function stateLockQuarantinePath(
  path: string,
  purpose: "reclaim" | "release",
): string {
  return `${path}.quarantine.${purpose}.${randomUUID()}`;
}

async function readStateLockSnapshot(path: string): Promise<
  | {
      readonly record: Awaited<ReturnType<typeof readProcessRecord>>;
      readonly mtimeMs: number;
    }
  | undefined
> {
  try {
    const metadata = await stat(path);
    const record = await readProcessRecord(path);
    return { record, mtimeMs: metadata.mtimeMs };
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

function boundedStateLockWait(): StateLockWait {
  return { deadline: Date.now() + STATE_LOCK_TIMEOUT_MS };
}

function assertStateLockWaitActive(wait: StateLockWait): void {
  assertAbortSignalsActive(wait.signals ?? []);
  if (wait.deadline !== undefined && Date.now() >= wait.deadline) {
    throw new Error("Timed out waiting for host state transaction lock");
  }
}

export function assertAbortSignalsActive(
  signals: readonly AbortSignal[],
): void {
  const aborted = signals.find((signal) => signal.aborted);
  if (!aborted) return;
  throw aborted.reason instanceof Error
    ? aborted.reason
    : new Error("Host state lock acquisition was cancelled");
}

async function waitForStateLock(wait: StateLockWait): Promise<void> {
  assertStateLockWaitActive(wait);
  await new Promise<void>((resolve, reject) => {
    const listeners = new Map<AbortSignal, () => void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
      listeners.clear();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const cancel = (signal: AbortSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Host state lock acquisition was cancelled"),
      );
    };
    timer = setTimeout(finish, STATE_LOCK_POLL_MS);
    for (const signal of wait.signals ?? []) {
      const listener = () => cancel(signal);
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) {
        cancel(signal);
        break;
      }
    }
  });
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
