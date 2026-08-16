import type { Database, SqlValue } from "sql.js";

import type {
  AdminIdentityStateRecords,
  MutationReceiptStateRecord,
  PairingStateRecord,
  PasskeyStateRecord,
  PasswordStateRecord,
  RecoveryCodeStateRecord,
  TrustedDeviceStateRecord,
} from "./state-snapshot.js";

export type SqlRow = Record<string, SqlValue>;

export function queryRows(
  database: Database,
  sql: string,
  parameters: readonly SqlValue[] = [],
): SqlRow[] {
  const statement = database.prepare(sql);
  try {
    statement.bind([...parameters]);
    const rows: SqlRow[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

export function readIdentity(database: Database): AdminIdentityStateRecords {
  const trustedDevices: TrustedDeviceStateRecord[] = queryRows(
    database,
    "SELECT id, name, public_key, created_at, revoked_at FROM trusted_devices ORDER BY id",
  ).map((row) => ({
    id: text(row.id, "trusted device id"),
    name: text(row.name, "trusted device name"),
    publicKey: blob(row.public_key, "trusted device public key"),
    createdAt: text(row.created_at, "trusted device created_at"),
    ...(nullableText(row.revoked_at, "trusted device revoked_at") === undefined
      ? {}
      : {
          revokedAt: nullableText(row.revoked_at, "trusted device revoked_at")!,
        }),
  }));
  const pairingSessions: PairingStateRecord[] = queryRows(
    database,
    "SELECT id, secret_hash, expires_at, created_at FROM pairing_sessions ORDER BY id",
  ).map((row) => ({
    id: text(row.id, "pairing id"),
    secretHash: blob(row.secret_hash, "pairing secret hash"),
    expiresAt: text(row.expires_at, "pairing expires_at"),
    createdAt: text(row.created_at, "pairing created_at"),
  }));
  const passkeys: PasskeyStateRecord[] = queryRows(
    database,
    "SELECT credential_id, public_key, sign_count, created_at FROM passkeys ORDER BY created_at, hex(credential_id)",
  ).map((row) => ({
    credentialId: blob(row.credential_id, "passkey credential id"),
    publicKey: blob(row.public_key, "passkey public key"),
    signCount: integer(row.sign_count, "passkey sign count"),
    createdAt: text(row.created_at, "passkey created_at"),
  }));
  const recoveryCodes: RecoveryCodeStateRecord[] = queryRows(
    database,
    "SELECT hash, created_at, used_at FROM recovery_codes ORDER BY created_at, hex(hash)",
  ).map((row) => ({
    hash: blob(row.hash, "recovery code hash"),
    createdAt: text(row.created_at, "recovery code created_at"),
    ...(nullableText(row.used_at, "recovery code used_at") === undefined
      ? {}
      : { usedAt: nullableText(row.used_at, "recovery code used_at")! }),
  }));
  const passwordRow = queryRows(
    database,
    "SELECT registration_record, updated_at FROM web_password WHERE id = 1",
  )[0];
  const password: PasswordStateRecord | undefined = passwordRow
    ? {
        registrationRecord: text(
          passwordRow.registration_record,
          "password registration record",
        ),
        updatedAt: text(passwordRow.updated_at, "password updated_at"),
      }
    : undefined;
  return {
    trustedDevices,
    pairingSessions,
    passkeys,
    recoveryCodes,
    ...(password === undefined ? {} : { password }),
  };
}

export function insertIdentity(
  database: Database,
  identity: AdminIdentityStateRecords,
): void {
  for (const record of identity.trustedDevices) {
    database.run(
      "INSERT INTO trusted_devices (id, name, public_key, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)",
      [
        record.id,
        record.name,
        record.publicKey,
        record.createdAt,
        record.revokedAt ?? null,
      ],
    );
  }
  for (const record of identity.pairingSessions) {
    database.run(
      "INSERT INTO pairing_sessions (id, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
      [record.id, record.secretHash, record.expiresAt, record.createdAt],
    );
  }
  for (const record of identity.passkeys) {
    database.run(
      "INSERT INTO passkeys (credential_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?)",
      [
        record.credentialId,
        record.publicKey,
        record.signCount,
        record.createdAt,
      ],
    );
  }
  for (const record of identity.recoveryCodes) {
    database.run(
      "INSERT INTO recovery_codes (hash, created_at, used_at) VALUES (?, ?, ?)",
      [record.hash, record.createdAt, record.usedAt ?? null],
    );
  }
  if (identity.password !== undefined) {
    database.run(
      "INSERT INTO web_password (id, registration_record, updated_at) VALUES (1, ?, ?)",
      [identity.password.registrationRecord, identity.password.updatedAt],
    );
  }
}

export function readMutationReceipts(
  database: Database,
): MutationReceiptStateRecord[] {
  return queryRows(
    database,
    "SELECT operation_key, method, request_fingerprint, status, result_json, created_at, updated_at, expires_at FROM mutation_receipts ORDER BY created_at, operation_key",
  ).map((row) => ({
    operationKey: text(row.operation_key, "mutation operation key"),
    method: text(row.method, "mutation method"),
    ...(nullableText(row.request_fingerprint, "mutation fingerprint") ===
    undefined
      ? {}
      : {
          requestFingerprint: nullableText(
            row.request_fingerprint,
            "mutation fingerprint",
          )!,
        }),
    status: mutationStatus(row.status),
    ...(nullableText(row.result_json, "mutation result") === undefined
      ? {}
      : { resultJson: nullableText(row.result_json, "mutation result")! }),
    createdAt: text(row.created_at, "mutation created_at"),
    updatedAt: text(row.updated_at, "mutation updated_at"),
    ...(nullableText(row.expires_at, "mutation expires_at") === undefined
      ? {}
      : { expiresAt: nullableText(row.expires_at, "mutation expires_at")! }),
  }));
}

export function insertMutationReceipts(
  database: Database,
  receipts: readonly MutationReceiptStateRecord[],
): void {
  for (const record of receipts) {
    database.run(
      "INSERT INTO mutation_receipts (operation_key, method, request_fingerprint, status, result_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.operationKey,
        record.method,
        record.requestFingerprint ?? null,
        record.status,
        record.resultJson ?? null,
        record.createdAt,
        record.updatedAt,
        record.expiresAt ?? null,
      ],
    );
  }
}

export function clearIdentity(database: Database): void {
  for (const table of [
    "web_password",
    "recovery_codes",
    "passkeys",
    "pairing_sessions",
    "trusted_devices",
  ]) {
    database.run(`DELETE FROM ${table}`);
  }
}

export function text(value: SqlValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}`);
  return value;
}

export function nullableText(
  value: SqlValue | undefined,
  field: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value, field);
}

export function integer(value: SqlValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function blob(value: SqlValue | undefined, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`Invalid ${field}`);
  return value.slice();
}

function mutationStatus(value: SqlValue | undefined) {
  if (
    value === "pending" ||
    value === "completed" ||
    value === "indeterminate"
  ) {
    return value;
  }
  throw new Error("Invalid mutation receipt status");
}
