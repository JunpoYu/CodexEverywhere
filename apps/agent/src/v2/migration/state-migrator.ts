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
  /** Expected owner of statePath when a root-run admin migration is required. */
  readonly owner?: MigrationFileOwner;
  /** v0.3 kept privileged admin domain data outside the Controller identity DB. */
  readonly auxiliaryAdminStatePath?: string;
  readonly auxiliaryAdminOwner?: MigrationFileOwner;
  readonly dryRun?: boolean;
  readonly now?: Date;
}

export interface MigrationFileOwner {
  readonly uid: number;
  readonly gid: number;
}

export interface StateMigrationResult {
  readonly version: 1;
  readonly direction: StateMigrationDirection;
  readonly kind: LegacyStateKind;
  readonly dryRun: boolean;
  readonly sourceSha256: string;
  readonly auxiliarySourceSha256?: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly backupPath?: string;
  readonly auxiliaryBackupPath?: string;
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
  readonly auxiliarySourceSha256?: string;
  readonly auxiliaryBackupFile?: string;
  readonly finalizedAt?: string;
}

export async function migrateState(
  options: StateMigrationOptions,
): Promise<StateMigrationResult> {
  validateMigrationOptions(options);
  assertRuntimeQuiescent(options.direction, options.runtime);
  return options.direction === "v0.3-to-v0.4"
    ? migrateForward(options)
    : migrateReverse(options);
}

export async function finalizeStateMigration(input: {
  readonly statePath: string;
  readonly receiptPath: string;
  readonly owner?: MigrationFileOwner;
  readonly auxiliaryAdminStatePath?: string;
  readonly auxiliaryAdminOwner?: MigrationFileOwner;
  readonly now?: Date;
}): Promise<void> {
  if (dirname(input.receiptPath) !== dirname(input.statePath)) {
    throw new Error("Migration receipt must be adjacent to the state database");
  }
  const receipt = parseReceipt(
    await readPrivateFile(input.receiptPath, input.owner?.uid),
  );
  if (receipt.finalizedAt !== undefined) return;
  assertBackupFileName(input.statePath, receipt.backupFile);
  const backupPath = join(dirname(input.statePath), receipt.backupFile);
  let auxiliaryBackupPath: string | undefined;
  if (receipt.auxiliaryBackupFile !== undefined) {
    if (input.auxiliaryAdminStatePath === undefined) {
      throw new Error(
        "Administrator migration receipt requires the auxiliary state path",
      );
    }
    assertBackupFileName(
      input.auxiliaryAdminStatePath,
      receipt.auxiliaryBackupFile,
    );
    auxiliaryBackupPath = join(
      dirname(input.auxiliaryAdminStatePath),
      receipt.auxiliaryBackupFile,
    );
  } else if (input.auxiliaryAdminStatePath !== undefined) {
    // A single-file legacy admin database remains a supported test/dev source.
  }
  await rm(backupPath);
  if (auxiliaryBackupPath !== undefined) await rm(auxiliaryBackupPath);
  const finalized: MigrationReceiptV1 = {
    ...receipt,
    finalizedAt: (input.now ?? new Date()).toISOString(),
  };
  await writePrivateJsonAtomic(
    input.receiptPath,
    finalized,
    { replace: true },
    input.owner,
  );
}

async function migrateForward(
  options: StateMigrationOptions,
): Promise<StateMigrationResult> {
  const now = options.now ?? new Date();
  const statePath = options.statePath;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const lock = await acquireMigrationLock(statePath, options.owner);
  const auxiliaryLock =
    options.auxiliaryAdminStatePath === undefined
      ? undefined
      : await acquireMigrationLock(
          options.auxiliaryAdminStatePath,
          options.auxiliaryAdminOwner,
        );
  let backupPath: string | undefined;
  let auxiliaryBackupPath: string | undefined;
  let temporaryPath: string | undefined;
  let replaced = false;
  let sourceSha256 = "";
  let auxiliarySourceSha256: string | undefined;
  let snapshot: StateSnapshotV1 | undefined;
  try {
    const sourceBytes = await requirePrivateFile(statePath, options.owner?.uid);
    sourceSha256 = sha256(sourceBytes);
    snapshot = await readLegacySnapshot(sourceBytes, options.kind, now);
    if (options.auxiliaryAdminStatePath !== undefined) {
      const auxiliaryBytes = await requirePrivateFile(
        options.auxiliaryAdminStatePath,
        options.auxiliaryAdminOwner?.uid,
      );
      auxiliarySourceSha256 = sha256(auxiliaryBytes);
      const auxiliarySnapshot = await readLegacySnapshot(
        auxiliaryBytes,
        "admin",
        now,
      );
      snapshot = mergeLegacyAdminSnapshots(
        requireAdminSnapshot(snapshot),
        requireAdminSnapshot(auxiliarySnapshot),
      );
    }
    const counts = stateSnapshotCounts(snapshot);
    if (options.dryRun === true) {
      return migrationResult(
        options,
        sourceSha256,
        counts,
        auxiliarySourceSha256,
      );
    }

    const migrationId = migrationIdentifier(now);
    backupPath = `${statePath}.v0.3-backup.${migrationId}.sqlite`;
    await writePrivateFileExclusive(backupPath, sourceBytes, options.owner);
    if (options.auxiliaryAdminStatePath !== undefined) {
      const auxiliaryBytes = await requirePrivateFile(
        options.auxiliaryAdminStatePath,
        options.auxiliaryAdminOwner?.uid,
      );
      auxiliaryBackupPath = `${options.auxiliaryAdminStatePath}.v0.3-backup.${migrationId}.sqlite`;
      await writePrivateFileExclusive(
        auxiliaryBackupPath,
        auxiliaryBytes,
        options.auxiliaryAdminOwner,
      );
    }

    temporaryPath = `${statePath}.v0.4.${migrationId}.tmp`;
    const state =
      snapshot.kind === "user"
        ? await UserStateDatabase.createFromSnapshot(temporaryPath, snapshot)
        : await AdminStateDatabase.createFromSnapshot(temporaryPath, snapshot, {
            ...(options.owner === undefined ? {} : { owner: options.owner }),
          });
    try {
      const imported = await state.exportSnapshot();
      if (!sameCounts(counts, stateSnapshotCounts(imported))) {
        throw new Error("Imported v0.4 state counts did not match the source");
      }
      await state.verify();
    } finally {
      await state.close();
    }

    const migratedSha256 = sha256(
      await requirePrivateFile(temporaryPath, options.owner?.uid),
    );
    await publishExistingFile(temporaryPath, statePath, lock);
    temporaryPath = undefined;
    replaced = true;
    const publishedBytes = await requirePrivateFile(
      statePath,
      options.owner?.uid,
    );
    if (sha256(publishedBytes) !== migratedSha256) {
      throw new Error("Published v0.4 database differs from verified import");
    }
    await smokeV4Database(publishedBytes, options.kind);
    const receiptPath = receiptPathFor(statePath, migrationId);
    await writeMigrationReceipt(
      receiptPath,
      {
        version: 1,
        id: migrationId,
        direction: options.direction,
        kind: options.kind,
        createdAt: now.toISOString(),
        sourceSha256,
        backupFile: basename(backupPath),
        ...(auxiliarySourceSha256 === undefined
          ? {}
          : { auxiliarySourceSha256 }),
        ...(auxiliaryBackupPath === undefined
          ? {}
          : { auxiliaryBackupFile: basename(auxiliaryBackupPath) }),
      },
      options.owner,
    );
    return {
      ...migrationResult(options, sourceSha256, counts, auxiliarySourceSha256),
      backupPath,
      ...(auxiliaryBackupPath === undefined ? {} : { auxiliaryBackupPath }),
      receiptPath,
    };
  } catch (error) {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true });
    if (replaced && backupPath !== undefined) {
      await restoreBackupUnderLock(backupPath, statePath, lock, options.owner);
    }
    throw error;
  } finally {
    await auxiliaryLock?.release();
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
  const initialBytes = await requirePrivateFile(statePath, options.owner?.uid);
  const sourceSha256 = sha256(initialBytes);
  const initialAuxiliaryBytes =
    options.auxiliaryAdminStatePath === undefined
      ? undefined
      : await readPrivateFile(
          options.auxiliaryAdminStatePath,
          options.auxiliaryAdminOwner?.uid,
        );
  const auxiliarySourceSha256 =
    initialAuxiliaryBytes === undefined
      ? undefined
      : sha256(initialAuxiliaryBytes);
  const state =
    options.kind === "user"
      ? await UserStateDatabase.open(statePath)
      : await AdminStateDatabase.open(statePath, {
          ...(options.owner === undefined ? {} : { owner: options.owner }),
        });
  let snapshot: StateSnapshotV1;
  try {
    snapshot = await state.exportSnapshot();
  } finally {
    await state.close();
  }
  const split =
    options.auxiliaryAdminStatePath === undefined
      ? undefined
      : splitAdminSnapshot(requireAdminSnapshot(snapshot));
  const legacyBytes = await writeLegacyStateSnapshot(
    split?.controller ?? snapshot,
  );
  const auxiliaryLegacyBytes =
    split === undefined
      ? undefined
      : await writeLegacyStateSnapshot(split.privileged);
  const counts = stateSnapshotCounts(snapshot);
  if (options.dryRun === true) {
    return migrationResult(
      options,
      sourceSha256,
      counts,
      auxiliarySourceSha256,
    );
  }

  const lock = await acquireMigrationLock(statePath, options.owner);
  const auxiliaryLock =
    options.auxiliaryAdminStatePath === undefined
      ? undefined
      : await acquireMigrationLock(
          options.auxiliaryAdminStatePath,
          options.auxiliaryAdminOwner,
        );
  let backupPath: string | undefined;
  let auxiliaryBackupPath: string | undefined;
  let temporaryPath: string | undefined;
  let auxiliaryTemporaryPath: string | undefined;
  let replaced = false;
  let auxiliaryReplaced = false;
  try {
    const currentBytes = await requirePrivateFile(
      statePath,
      options.owner?.uid,
    );
    if (sha256(currentBytes) !== sourceSha256) {
      throw new StateConversionError(
        "SOURCE_CHANGED",
        "State changed while preparing reverse migration; retry after quiescing",
      );
    }
    const currentAuxiliaryBytes =
      options.auxiliaryAdminStatePath === undefined
        ? undefined
        : await readPrivateFile(
            options.auxiliaryAdminStatePath,
            options.auxiliaryAdminOwner?.uid,
          );
    if (
      (currentAuxiliaryBytes === undefined
        ? undefined
        : sha256(currentAuxiliaryBytes)) !== auxiliarySourceSha256
    ) {
      throw new StateConversionError(
        "SOURCE_CHANGED",
        "Auxiliary administrator state changed while preparing reverse migration",
      );
    }
    const migrationId = migrationIdentifier(now);
    backupPath = `${statePath}.v0.4-backup.${migrationId}.sqlite`;
    await writePrivateFileExclusive(backupPath, currentBytes, options.owner);
    if (
      options.auxiliaryAdminStatePath !== undefined &&
      currentAuxiliaryBytes !== undefined
    ) {
      auxiliaryBackupPath = `${options.auxiliaryAdminStatePath}.v0.4-backup.${migrationId}.sqlite`;
      await writePrivateFileExclusive(
        auxiliaryBackupPath,
        currentAuxiliaryBytes,
        options.auxiliaryAdminOwner,
      );
    }
    temporaryPath = `${statePath}.v0.3.${migrationId}.tmp`;
    await writePrivateFileExclusive(temporaryPath, legacyBytes, options.owner);
    if (
      options.auxiliaryAdminStatePath !== undefined &&
      auxiliaryLegacyBytes !== undefined
    ) {
      auxiliaryTemporaryPath = `${options.auxiliaryAdminStatePath}.v0.3.${migrationId}.tmp`;
      await writePrivateFileExclusive(
        auxiliaryTemporaryPath,
        auxiliaryLegacyBytes,
        options.auxiliaryAdminOwner,
      );
    }
    await publishExistingFile(temporaryPath, statePath, lock);
    temporaryPath = undefined;
    replaced = true;
    if (
      auxiliaryTemporaryPath !== undefined &&
      options.auxiliaryAdminStatePath !== undefined &&
      auxiliaryLock !== undefined
    ) {
      await publishExistingFile(
        auxiliaryTemporaryPath,
        options.auxiliaryAdminStatePath,
        auxiliaryLock,
      );
      auxiliaryTemporaryPath = undefined;
      auxiliaryReplaced = true;
    }

    let roundTrip = await readLegacySnapshot(
      await requirePrivateFile(statePath, options.owner?.uid),
      options.kind,
      now,
    );
    if (options.auxiliaryAdminStatePath !== undefined) {
      const auxiliaryRoundTrip = await readLegacySnapshot(
        await requirePrivateFile(
          options.auxiliaryAdminStatePath,
          options.auxiliaryAdminOwner?.uid,
        ),
        "admin",
        now,
      );
      roundTrip = mergeLegacyAdminSnapshots(
        requireAdminSnapshot(roundTrip),
        requireAdminSnapshot(auxiliaryRoundTrip),
      );
    }
    if (!sameCounts(counts, stateSnapshotCounts(roundTrip))) {
      throw new Error("Reverse migration semantic counts did not round-trip");
    }

    const receiptPath = receiptPathFor(statePath, migrationId);
    await writeMigrationReceipt(
      receiptPath,
      {
        version: 1,
        id: migrationId,
        direction: options.direction,
        kind: options.kind,
        createdAt: now.toISOString(),
        sourceSha256,
        backupFile: basename(backupPath),
        ...(auxiliarySourceSha256 === undefined
          ? {}
          : { auxiliarySourceSha256 }),
        ...(auxiliaryBackupPath === undefined
          ? {}
          : { auxiliaryBackupFile: basename(auxiliaryBackupPath) }),
      },
      options.owner,
    );
    return {
      ...migrationResult(options, sourceSha256, counts, auxiliarySourceSha256),
      backupPath,
      ...(auxiliaryBackupPath === undefined ? {} : { auxiliaryBackupPath }),
      receiptPath,
    };
  } catch (error) {
    if (temporaryPath !== undefined) await rm(temporaryPath, { force: true });
    if (auxiliaryTemporaryPath !== undefined) {
      await rm(auxiliaryTemporaryPath, { force: true });
    }
    if (
      auxiliaryReplaced &&
      options.auxiliaryAdminStatePath !== undefined &&
      auxiliaryLock !== undefined
    ) {
      if (auxiliaryBackupPath === undefined) {
        await removePublishedFileUnderLock(
          options.auxiliaryAdminStatePath,
          auxiliaryLock,
        );
      } else {
        await restoreBackupUnderLock(
          auxiliaryBackupPath,
          options.auxiliaryAdminStatePath,
          auxiliaryLock,
          options.auxiliaryAdminOwner,
        );
      }
    }
    if (replaced && backupPath !== undefined) {
      await restoreBackupUnderLock(backupPath, statePath, lock, options.owner);
    }
    throw error;
  } finally {
    await auxiliaryLock?.release();
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

function validateMigrationOptions(options: StateMigrationOptions): void {
  validateMigrationOwner(options.owner);
  validateMigrationOwner(options.auxiliaryAdminOwner);
  if (
    options.auxiliaryAdminStatePath !== undefined &&
    options.kind !== "admin"
  ) {
    throw new Error("Only administrator state has an auxiliary v0.3 database");
  }
  if (
    options.auxiliaryAdminStatePath !== undefined &&
    options.auxiliaryAdminStatePath === options.statePath
  ) {
    throw new Error("Administrator migration state paths must be distinct");
  }
  if (
    options.auxiliaryAdminOwner !== undefined &&
    options.auxiliaryAdminStatePath === undefined
  ) {
    throw new Error("Auxiliary state owner requires an auxiliary state path");
  }
}

function validateMigrationOwner(owner: MigrationFileOwner | undefined): void {
  if (owner === undefined) return;
  if (
    !Number.isSafeInteger(owner.uid) ||
    owner.uid < 0 ||
    !Number.isSafeInteger(owner.gid) ||
    owner.gid < 0
  ) {
    throw new Error("Migration file owner is invalid");
  }
  if (process.getuid?.() !== 0) {
    throw new Error("Only root can migrate state owned by another account");
  }
}

function acquireMigrationLock(
  statePath: string,
  owner?: MigrationFileOwner,
): ReturnType<typeof acquireStateLock> {
  return acquireStateLock(`${statePath}.lock`, {
    ...(owner === undefined ? {} : { fileOwner: owner }),
  });
}

async function readLegacySnapshot(
  bytes: Uint8Array,
  kind: LegacyStateKind,
  now: Date,
): Promise<StateSnapshotV1> {
  const legacy = await openLegacyDatabase(bytes);
  try {
    return readLegacyStateSnapshot(legacy, kind, now);
  } finally {
    legacy.close();
  }
}

type AdminSnapshot = Extract<StateSnapshotV1, { kind: "admin" }>;

function requireAdminSnapshot(snapshot: StateSnapshotV1): AdminSnapshot {
  if (snapshot.kind !== "admin") {
    throw new Error("Administrator migration received user state");
  }
  return snapshot;
}

/**
 * v0.3 split admin identity and privileged lifecycle data between two full
 * schema-4 files. Refuse ambiguous overlap instead of selecting one silently.
 */
function mergeLegacyAdminSnapshots(
  controller: AdminSnapshot,
  privileged: AdminSnapshot,
): AdminSnapshot {
  assertSingleAdminPartition(
    "identity",
    adminIdentityCount(controller),
    adminIdentityCount(privileged),
  );
  assertSingleAdminPartition(
    "managed users",
    controller.records.managedUsers.length,
    privileged.records.managedUsers.length,
  );
  assertSingleAdminPartition(
    "audit events",
    controller.records.auditEvents.length,
    privileged.records.auditEvents.length,
  );
  assertSingleAdminPartition(
    "mutation receipts",
    controller.records.mutationReceipts.length,
    privileged.records.mutationReceipts.length,
  );
  return {
    version: 1,
    kind: "admin",
    records: {
      createdAt: controller.records.createdAt,
      sourceSchema: controller.records.sourceSchema,
      identity:
        adminIdentityCount(controller) > 0
          ? controller.records.identity
          : privileged.records.identity,
      managedUsers:
        privileged.records.managedUsers.length > 0
          ? privileged.records.managedUsers
          : controller.records.managedUsers,
      auditEvents:
        privileged.records.auditEvents.length > 0
          ? privileged.records.auditEvents
          : controller.records.auditEvents,
      mutationReceipts:
        privileged.records.mutationReceipts.length > 0
          ? privileged.records.mutationReceipts
          : controller.records.mutationReceipts,
    },
  };
}

function assertSingleAdminPartition(
  name: string,
  controllerCount: number,
  privilegedCount: number,
): void {
  if (controllerCount > 0 && privilegedCount > 0) {
    throw new StateConversionError(
      "AMBIGUOUS_ADMIN_STATE",
      `Both v0.3 administrator databases contain ${name}`,
      { controller: controllerCount, privileged: privilegedCount },
    );
  }
}

function adminIdentityCount(snapshot: AdminSnapshot): number {
  const identity = snapshot.records.identity;
  return (
    identity.trustedDevices.length +
    identity.pairingSessions.length +
    identity.passkeys.length +
    identity.recoveryCodes.length +
    (identity.password === undefined ? 0 : 1)
  );
}

function splitAdminSnapshot(snapshot: AdminSnapshot): {
  readonly controller: AdminSnapshot;
  readonly privileged: AdminSnapshot;
} {
  const common = {
    createdAt: snapshot.records.createdAt,
    sourceSchema: snapshot.records.sourceSchema,
  };
  return {
    controller: {
      version: 1,
      kind: "admin",
      records: {
        ...common,
        identity: snapshot.records.identity,
        managedUsers: [],
        auditEvents: [],
        mutationReceipts: [],
      },
    },
    privileged: {
      version: 1,
      kind: "admin",
      records: {
        ...common,
        identity: {
          trustedDevices: [],
          pairingSessions: [],
          passkeys: [],
          recoveryCodes: [],
        },
        managedUsers: snapshot.records.managedUsers,
        auditEvents: snapshot.records.auditEvents,
        mutationReceipts: snapshot.records.mutationReceipts,
      },
    },
  };
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
  owner?: MigrationFileOwner,
): Promise<void> {
  const bytes = await requirePrivateFile(backupPath, owner?.uid);
  const temporary = `${statePath}.restore.${randomUUID()}.tmp`;
  await writePrivateFileExclusive(temporary, bytes, owner);
  await publishExistingFile(temporary, statePath, lock);
}

async function removePublishedFileUnderLock(
  statePath: string,
  lock: Awaited<ReturnType<typeof acquireStateLock>>,
): Promise<void> {
  const fence = await lock.beginCommit();
  try {
    await lock.assertOwned();
    await rm(statePath, { force: true });
    await syncDirectoryForDurability(dirname(statePath));
  } finally {
    await fence.release();
  }
}

async function writeMigrationReceipt(
  path: string,
  receipt: MigrationReceiptV1,
  owner?: MigrationFileOwner,
): Promise<void> {
  await writePrivateJsonAtomic(path, receipt, { replace: false }, owner);
}

async function writePrivateJsonAtomic(
  path: string,
  value: unknown,
  options: { readonly replace: boolean },
  owner?: MigrationFileOwner,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePrivateFileExclusive(
      temporary,
      new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
      owner,
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
  owner?: MigrationFileOwner,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    if (owner !== undefined) await handle.chown(owner.uid, owner.gid);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryForDurability(dirname(path));
}

async function requirePrivateFile(
  path: string,
  expectedUid?: number,
): Promise<Uint8Array> {
  const bytes = await readPrivateFile(path, expectedUid);
  if (bytes === undefined) throw new Error("State database is missing");
  return bytes;
}

async function readPrivateFile(
  path: string,
  expectedUid = process.getuid?.(),
): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1)
      throw new Error("Migration source must be a single-link regular file");
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw new Error("Migration source has the wrong owner");
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
  auxiliarySourceSha256?: string,
): StateMigrationResult {
  return {
    version: 1,
    direction: options.direction,
    kind: options.kind,
    dryRun: options.dryRun === true,
    sourceSha256,
    ...(auxiliarySourceSha256 === undefined ? {} : { auxiliarySourceSha256 }),
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
    ((value as Record<string, unknown>).auxiliarySourceSha256 !== undefined &&
      typeof (value as Record<string, unknown>).auxiliarySourceSha256 !==
        "string") ||
    ((value as Record<string, unknown>).auxiliaryBackupFile !== undefined &&
      typeof (value as Record<string, unknown>).auxiliaryBackupFile !==
        "string") ||
    ((value as Record<string, unknown>).finalizedAt !== undefined &&
      typeof (value as Record<string, unknown>).finalizedAt !== "string")
  ) {
    throw new Error("Migration receipt is invalid");
  }
  return value as unknown as MigrationReceiptV1;
}

function assertBackupFileName(statePath: string, backupFile: string): void {
  if (
    basename(backupFile) !== backupFile ||
    !backupFile.startsWith(`${basename(statePath)}.`)
  ) {
    throw new Error("Migration receipt backup target is invalid");
  }
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
