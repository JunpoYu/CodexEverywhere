import type { Database } from "sql.js";

import { AdminRepository } from "./admin-repository.js";
import { IdentityRepository } from "./identity-repository.js";
import { MutationReceiptRepository } from "./mutation-receipt-repository.js";
import {
  clearIdentity,
  insertIdentity,
  insertMutationReceipts,
  integer,
  nullableText,
  queryRows,
  readIdentity,
  readMutationReceipts,
  text,
} from "./snapshot-sql.js";
import { SqliteStateFile } from "./sqlite-state-file.js";
import { ADMIN_STATE_SPEC } from "./state-schema.js";
import type {
  AdminAuditStateRecord,
  AdminStateRecords,
  ManagedUserStateRecord,
  StateSnapshotV1,
} from "./state-snapshot.js";

export class AdminStateDatabase {
  readonly #file: SqliteStateFile;
  readonly admin: AdminRepository;
  readonly identity: IdentityRepository;
  readonly mutationReceipts: MutationReceiptRepository;

  private constructor(file: SqliteStateFile) {
    this.#file = file;
    this.admin = new AdminRepository(file);
    this.identity = new IdentityRepository(file, {
      recoveryHandoffs: false,
      securityAudit: false,
    });
    this.mutationReceipts = new MutationReceiptRepository(file);
  }

  static async open(
    path: string,
    options: {
      readonly create?: boolean;
      readonly owner?: { readonly uid: number; readonly gid: number };
    } = {},
  ): Promise<AdminStateDatabase> {
    const file = await SqliteStateFile.open(path, ADMIN_STATE_SPEC, options);
    const state = new AdminStateDatabase(file);
    const hasMetadata = await file.read(
      (database) =>
        queryRows(database, "SELECT 1 FROM metadata WHERE id = 1").length === 1,
    );
    if (!hasMetadata) {
      if (options.create !== true) {
        await file.close();
        throw new Error("Admin state metadata is missing");
      }
      await state.replaceSnapshot(emptyAdminSnapshot());
    }
    await state.verify();
    return state;
  }

  static async createFromSnapshot(
    path: string,
    snapshot: Extract<StateSnapshotV1, { kind: "admin" }>,
    options: {
      readonly owner?: { readonly uid: number; readonly gid: number };
    } = {},
  ): Promise<AdminStateDatabase> {
    const file = await SqliteStateFile.open(path, ADMIN_STATE_SPEC, {
      create: true,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
    });
    const state = new AdminStateDatabase(file);
    await state.replaceSnapshot(snapshot);
    await state.verify();
    return state;
  }

  exportSnapshot(): Promise<Extract<StateSnapshotV1, { kind: "admin" }>> {
    return this.#file.read((database) => ({
      version: 1,
      kind: "admin",
      records: readAdminRecords(database),
    }));
  }

  replaceSnapshot(
    snapshot: Extract<StateSnapshotV1, { kind: "admin" }>,
  ): Promise<void> {
    return this.#file.transaction((database) => {
      clearAdminState(database);
      insertAdminRecords(database, snapshot.records);
      validateAdminInvariants(database);
    });
  }

  async verify(): Promise<void> {
    await this.#file.verify();
    await this.#file.read(validateAdminInvariants);
  }

  acquireCoordinationLock(
    name: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ release(): Promise<void> }> {
    return this.#file.acquireCoordinationLock(name, options);
  }

  close(): Promise<void> {
    return this.#file.close();
  }
}

function emptyAdminSnapshot(): Extract<StateSnapshotV1, { kind: "admin" }> {
  return {
    version: 1,
    kind: "admin",
    records: {
      createdAt: new Date().toISOString(),
      sourceSchema: 0,
      identity: {
        trustedDevices: [],
        pairingSessions: [],
        passkeys: [],
        recoveryCodes: [],
      },
      managedUsers: [],
      auditEvents: [],
      mutationReceipts: [],
    },
  };
}

function readAdminRecords(database: Database): AdminStateRecords {
  const metadata = queryRows(
    database,
    "SELECT created_at, source_schema FROM metadata WHERE id = 1 AND kind = 'admin'",
  )[0];
  if (!metadata) throw new Error("Admin state metadata is missing");
  return {
    createdAt: text(metadata.created_at, "admin metadata created_at"),
    sourceSchema: integer(metadata.source_schema, "admin source schema"),
    identity: readIdentity(database),
    managedUsers: readManagedUsers(database),
    auditEvents: readAdminAudit(database),
    mutationReceipts: readMutationReceipts(database),
  };
}

function readManagedUsers(database: Database): ManagedUserStateRecord[] {
  return queryRows(
    database,
    "SELECT uid, username, home, status, registered_at, updated_at, revision, remove_after FROM managed_users ORDER BY username",
  ).map((row) => ({
    uid: integer(row.uid, "managed user uid"),
    username: text(row.username, "managed username"),
    home: text(row.home, "managed user home"),
    status: text(row.status, "managed user status"),
    registeredAt: text(row.registered_at, "managed user registered_at"),
    updatedAt: text(row.updated_at, "managed user updated_at"),
    revision: integer(row.revision, "managed user revision"),
    ...(nullableText(row.remove_after, "managed user remove_after") ===
    undefined
      ? {}
      : {
          removeAfter: nullableText(
            row.remove_after,
            "managed user remove_after",
          )!,
        }),
  }));
}

function readAdminAudit(database: Database): AdminAuditStateRecord[] {
  return queryRows(
    database,
    "SELECT id, request_id, actor, action, target_username, result, created_at FROM admin_audit ORDER BY created_at, id",
  ).map((row) => ({
    id: text(row.id, "admin audit id"),
    requestId: text(row.request_id, "admin audit request id"),
    actor: text(row.actor, "admin audit actor"),
    action: text(row.action, "admin audit action"),
    ...(nullableText(row.target_username, "admin audit target") === undefined
      ? {}
      : {
          targetUsername: nullableText(
            row.target_username,
            "admin audit target",
          )!,
        }),
    result: text(row.result, "admin audit result"),
    createdAt: text(row.created_at, "admin audit created_at"),
  }));
}

function insertAdminRecords(
  database: Database,
  records: AdminStateRecords,
): void {
  database.run(
    "INSERT INTO metadata (id, kind, created_at, source_schema) VALUES (1, 'admin', ?, ?)",
    [records.createdAt, records.sourceSchema],
  );
  insertIdentity(database, records.identity);
  insertMutationReceipts(database, records.mutationReceipts);
  for (const record of records.managedUsers) {
    database.run(
      "INSERT INTO managed_users (uid, username, home, status, registered_at, updated_at, revision, remove_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.uid,
        record.username,
        record.home,
        record.status,
        record.registeredAt,
        record.updatedAt,
        record.revision,
        record.removeAfter ?? null,
      ],
    );
  }
  for (const record of records.auditEvents) {
    database.run(
      "INSERT INTO admin_audit (id, request_id, actor, action, target_username, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.requestId,
        record.actor,
        record.action,
        record.targetUsername ?? null,
        record.result,
        record.createdAt,
      ],
    );
  }
}

function clearAdminState(database: Database): void {
  for (const table of ["admin_audit", "managed_users", "mutation_receipts"]) {
    database.run(`DELETE FROM ${table}`);
  }
  clearIdentity(database);
  database.run("DELETE FROM metadata");
}

function validateAdminInvariants(database: Database): void {
  if (
    queryRows(
      database,
      "SELECT 1 FROM metadata WHERE id = 1 AND kind = 'admin'",
    ).length !== 1
  ) {
    throw new Error("Admin state metadata invariant failed");
  }
  const duplicateUsers = queryRows(
    database,
    "SELECT username FROM managed_users GROUP BY username HAVING COUNT(*) > 1 LIMIT 1",
  );
  if (duplicateUsers.length > 0)
    throw new Error("Managed user uniqueness failed");
}
