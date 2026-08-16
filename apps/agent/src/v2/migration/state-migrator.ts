import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { syncDirectoryForDurability } from "../../host/durable-file.js";
import { acquireStateLock } from "../../host/state-lock.js";
import {
  AdminStateDatabase,
  ADMIN_STATE_APPLICATION_ID,
  UserStateDatabase,
  USER_STATE_APPLICATION_ID,
  V4_STATE_SCHEMA_VERSION,
  stateSnapshotCounts,
  type StateSnapshotV1,
} from "../repositories/index.js";
import {
  openLegacyDatabase,
  readLegacyStateSnapshot,
  StateConversionError,
  writeLegacyStateSnapshot,
  type LegacyStateKind,
} from "../repositories/legacy-state-conversion.js";

export type StateMigrationDirection = "v0.3-to-v0.4" | "v0.4-to-v0.3";

export interface MigrationRuntimeState {
  readonly activeSideSessions: number;
  readonly runningTurns: number;
  readonly unresolvedInteractions: number;
  readonly deliveringQueue: number;
  readonly pendingMutations: number;
  readonly loginFlows: number;
  readonly activeLeases: number;
}

export interface StateMigrationOptions {
  readonly statePath: string;
  readonly kind: LegacyStateKind;
  readonly direction: StateMigrationDirection;
  readonly runtime: MigrationRuntimeState;
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface StateMigrationResult {
  readonly version: 1;
  readonly direction: StateMigrationDirection;
  readonly kind: LegacyStateKind;
  readonly dryRun: boolean;
  readonly sourceSha256: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly backupPath?: string;
  readonly receiptPath?: string;
}

interface MigrationReceiptV1 {
  readonly version: 1;
  readonly id: string;
  readonly direction: StateMigrationDirection;
  readonly kind: LegacyStateKind;
  readonly createdAt: string;
  readonly sourceSha256: string;
  readonly backupFile: string;
  readonly finalizedAt?: string;
}

export async function migrateState(
  options: StateMigrationOptions,
): Promise<StateMigrationResult> {
  assertRuntimeQuiescent(options.direction, options.runtime);
  return options.direction === "v0.3-to-v0.4"
    ? migrateForward(options)
    : migrateReverse(options);
}

export async function finalizeStateMigration(input: {
  readonly statePath: string;
  readonly receiptPath: string;
  readonly now?: Date;
}): Promise<void> {
  if (dirname(input.receiptPath) !== dirname(input.statePath)) {
    throw new Error("Migration receipt must be adjacent to the state database");
  }
  const receipt = parseReceipt(await readPrivateFile(input.receiptPath));
  if (receipt.finalizedAt !== undefined) return;
  if (
    basename(receipt.backupFile) !== receipt.backupFile ||
    !receipt.backupFile.startsWith(`${basename(input.statePath)}.`)
  ) {
    throw new Error("Migration receipt backup target is invalid");
  }
  const backupPath = join(dirname(input.statePath), receipt.backupFile);
  await rm(backupPath);
  const finalized: MigrationReceiptV1 = {
    ...receipt,
    finalizedAt: (input.now ?? new Date()).toISOString(),
  };
  await writePrivateJsonAtomic(input.receiptPath, finalized, { replace: true });
}

async function migrateForward(
  options: StateMigrationOptions,
): Promise<StateMigrationResult> {
  const now = options.now ?? new Date();
  const statePath = options.statePath;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const lock = await acquireStateLock(`${statePath}.lock`);
  let backupPath: string | undefined;
  let temporaryPath: string | undefined;
  let replaced = false;
  let sourceSha256 = "";
  let snapshot: StateSnapshotV1 | undefined;
  try {
    const sourceBytes = await requirePrivateFile(statePath);
    sourceSha256 = sha256(sourceBytes);
    const legacy = await openLegacyDatabase(sourceBytes);
    try {
      snapshot = readLegacyStateSnapshot(legacy, options.kind, now);
    } finally {
      legacy.close();
    }
    const counts = stateSnapshotCounts(snapshot);
    if (options.dryRun === true) {
      return migrationResult(options, sourceSha256, counts);
    }

    const migrationId = migrationIdentifier(now);
    backupPath = `${statePath}.v0.3-backup.${migrationId}.sqlite`;
    await writePrivateFileExclusive(backupPath, sourceBytes);

    temporaryPath = `${statePath}.v0.4.${migrationId}.tmp`;
    const state =
      snapshot.kind === "user"
        ? await UserStateDatabase.createFromSnapshot(temporaryPath, snapshot)
        : await AdminStateDatabase.createFromSnapshot(temporaryPath, snapshot);
    try {
      const imported = await state.exportSnapshot();
      if (!sameCounts(counts, stateSnapshotCounts(imported))) {
        throw new Error("Imported v0.4 state counts did not match the source");
      }
      await state.verify();
    } finally {
      await state.close();
    }

    const migratedSha256 = sha256(await requirePrivateFile(temporaryPath));
    await publishExistingFile(temporaryPath, statePath, lock);
    temporaryPath = undefined;
    replaced = true;
    const publishedBytes = await requirePrivateFile(statePath);
    if (sha256(publishedBytes) !== migratedSha256) {
      throw new Error("Published v0.4 database differs from verified import");
    }
    await smokeV4Database(publishedBytes, options.kind);
    const receiptPath = receiptPathFor(statePath, migrationId);
    await writeMigrationReceipt(receiptPath, {
      version: 1,
      id: migrationId,
      direction: options.direction,
      kind: options.kind,
      createdAt: now.toISOString(),
      sourceSha256,
      backupFile: basename(backupPath),
    });
    return {
      ...migrationResult(options, sourceSha256, counts),
      backupPath,
      receiptPath,
    };
  } catch (error) {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true });
    if (replaced && backupPath !== undefined) {
      await restoreBackupUnderLock(backupPath, statePath, lock);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

async function smokeV4Database(
  bytes: Uint8Array,
  kind: LegacyStateKind,
): Promise<void> {
  const database = await openLegacyDatabase(bytes);
  try {
    const expectedApplicationId =
      kind === "user" ? USER_STATE_APPLICATION_ID : ADMIN_STATE_APPLICATION_ID;
    const applicationId = Number(
      database.exec("PRAGMA application_id")[0]?.values[0]?.[0] ?? -1,
    );
    const schemaVersion = Number(
      database.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? -1,
    );
    const integrity = database.exec("PRAGMA integrity_check")[0]
      ?.values[0]?.[0];
    if (
      applicationId !== expectedApplicationId ||
      schemaVersion !== V4_STATE_SCHEMA_VERSION ||
      integrity !== "ok"
    ) {
      throw new Error("Published v0.4 database failed read-only smoke checks");
    }
  } finally {
    database.close();
  }
}

async function migrateReverse(
  options: StateMigrationOptions,
): Promise<StateMigrationResult> {
  const now = options.now ?? new Date();
  const statePath = options.statePath;
  const initialBytes = await requirePrivateFile(statePath);
  const sourceSha256 = sha256(initialBytes);
  const state =
    options.kind === "user"
      ? await UserStateDatabase.open(statePath)
      : await AdminStateDatabase.open(statePath);
  let snapshot: StateSnapshotV1;
  try {
    snapshot = await state.exportSnapshot();
  } finally {
    await state.close();
  }
  const legacyBytes = await writeLegacyStateSnapshot(snapshot);
  const counts = stateSnapshotCounts(snapshot);
  if (options.dryRun === true) {
    return migrationResult(options, sourceSha256, counts);
  }

  const lock = await acquireStateLock(`${statePath}.lock`);
  let backupPath: string | undefined;
  let temporaryPath: string | undefined;
  let replaced = false;
  try {
    const currentBytes = await requirePrivateFile(statePath);
    if (sha256(currentBytes) !== sourceSha256) {
      throw new StateConversionError(
        "SOURCE_CHANGED",
        "State changed while preparing reverse migration; retry after quiescing",
      );
    }
    const migrationId = migrationIdentifier(now);
    backupPath = `${statePath}.v0.4-backup.${migrationId}.sqlite`;
    await writePrivateFileExclusive(backupPath, currentBytes);
    temporaryPath = `${statePath}.v0.3.${migrationId}.tmp`;
    await writePrivateFileExclusive(temporaryPath, legacyBytes);
    await publishExistingFile(temporaryPath, statePath, lock);
    temporaryPath = undefined;
    replaced = true;

    const smoke = await openLegacyDatabase(await requirePrivateFile(statePath));
    try {
      const roundTrip = readLegacyStateSnapshot(smoke, options.kind, now);
      if (!sameCounts(counts, stateSnapshotCounts(roundTrip))) {
        throw new Error("Reverse migration semantic counts did not round-trip");
      }
    } finally {
      smoke.close();
    }

    const receiptPath = receiptPathFor(statePath, migrationId);
    await writeMigrationReceipt(receiptPath, {
      version: 1,
      id: migrationId,
      direction: options.direction,
      kind: options.kind,
      createdAt: now.toISOString(),
      sourceSha256,
      backupFile: basename(backupPath),
    });
    return {
      ...migrationResult(options, sourceSha256, counts),
      backupPath,
      receiptPath,
    };
  } catch (error) {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true });
    if (replaced && backupPath !== undefined) {
      await restoreBackupUnderLock(backupPath, statePath, lock);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

function assertRuntimeQuiescent(
  direction: StateMigrationDirection,
  runtime: MigrationRuntimeState,
): void {
  for (const [name, count] of Object.entries(runtime)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid migration runtime count: ${name}`);
    }
  }
  const relevant =
    direction === "v0.3-to-v0.4"
      ? {
          activeSideSessions: runtime.activeSideSessions,
          runningTurns: runtime.runningTurns,
          unresolvedInteractions: runtime.unresolvedInteractions,
          deliveringQueue: runtime.deliveringQueue,
          pendingMutations: runtime.pendingMutations,
          loginFlows: runtime.loginFlows,
        }
      : {
          activeLeases: runtime.activeLeases,
          unresolvedInteractions: runtime.unresolvedInteractions,
          deliveringQueue: runtime.deliveringQueue,
          pendingMutations: runtime.pendingMutations,
          loginFlows: runtime.loginFlows,
        };
  const blockers = Object.fromEntries(
    Object.entries(relevant).filter(([, count]) => count > 0),
  );
  if (Object.keys(blockers).length > 0) {
    throw new StateConversionError(
      "RUNTIME_NOT_QUIESCENT",
      "Runtime activity must stop before state migration",
      blockers,
    );
  }
}

async function publishExistingFile(
  source: string,
  destination: string,
  lock: Awaited<ReturnType<typeof acquireStateLock>>,
): Promise<void> {
  const fence = await lock.beginCommit();
  try {
    await lock.assertOwned();
    await rename(source, destination);
    await syncDirectoryForDurability(dirname(destination));
  } finally {
    await fence.release();
  }
}

async function restoreBackupUnderLock(
  backupPath: string,
  statePath: string,
  lock: Awaited<ReturnType<typeof acquireStateLock>>,
): Promise<void> {
  const bytes = await requirePrivateFile(backupPath);
  const temporary = `${statePath}.restore.${randomUUID()}.tmp`;
  await writePrivateFileExclusive(temporary, bytes);
  await publishExistingFile(temporary, statePath, lock);
}

async function writeMigrationReceipt(
  path: string,
  receipt: MigrationReceiptV1,
): Promise<void> {
  await writePrivateJsonAtomic(path, receipt, { replace: false });
}

async function writePrivateJsonAtomic(
  path: string,
  value: unknown,
  options: { readonly replace: boolean },
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePrivateFileExclusive(
      temporary,
      new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
    );
    if (!options.replace && (await pathExists(path))) {
      throw new Error("Migration receipt already exists");
    }
    await rename(temporary, path);
    await syncDirectoryForDurability(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writePrivateFileExclusive(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryForDurability(dirname(path));
}

async function requirePrivateFile(path: string): Promise<Uint8Array> {
  const bytes = await readPrivateFile(path);
  if (bytes === undefined) throw new Error("State database is missing");
  return bytes;
}

async function readPrivateFile(path: string): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new Error("Migration source is not a regular file");
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && metadata.uid !== currentUid) {
      throw new Error("Migration source is not owned by the current user");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Migration source permissions must be 0600 or stricter");
    }
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

function migrationResult(
  options: StateMigrationOptions,
  sourceSha256: string,
  counts: Readonly<Record<string, number>>,
): StateMigrationResult {
  return {
    version: 1,
    direction: options.direction,
    kind: options.kind,
    dryRun: options.dryRun === true,
    sourceSha256,
    counts,
  };
}

function migrationIdentifier(now: Date): string {
  return `${now
    .toISOString()
    .replace(/[^0-9]/gu, "")
    .slice(0, 17)}-${randomUUID()}`;
}

function receiptPathFor(statePath: string, migrationId: string): string {
  return `${statePath}.migration.${migrationId}.receipt.json`;
}

function parseReceipt(bytes: Uint8Array | undefined): MigrationReceiptV1 {
  if (bytes === undefined) throw new Error("Migration receipt is missing");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Migration receipt is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).id !== "string" ||
    ((value as Record<string, unknown>).direction !== "v0.3-to-v0.4" &&
      (value as Record<string, unknown>).direction !== "v0.4-to-v0.3") ||
    ((value as Record<string, unknown>).kind !== "user" &&
      (value as Record<string, unknown>).kind !== "admin") ||
    typeof (value as Record<string, unknown>).createdAt !== "string" ||
    typeof (value as Record<string, unknown>).sourceSha256 !== "string" ||
    typeof (value as Record<string, unknown>).backupFile !== "string" ||
    ((value as Record<string, unknown>).finalizedAt !== undefined &&
      typeof (value as Record<string, unknown>).finalizedAt !== "string")
  ) {
    throw new Error("Migration receipt is invalid");
  }
  return value as unknown as MigrationReceiptV1;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameCounts(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
): boolean {
  return (
    Object.keys(expected).length === Object.keys(actual).length &&
    Object.entries(expected).every(([key, count]) => actual[key] === count)
  );
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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
