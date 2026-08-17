import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { Database } from "sql.js";

import {
  blob,
  integer,
  nullableText,
  queryRows,
  text,
} from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export interface PasskeyCredentialRecord {
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
}

export interface TrustedDeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly publicKey: Uint8Array;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface IdentityStatusRecord {
  readonly passkeys: number;
  readonly password: boolean;
  readonly trustedDevices: number;
  readonly unusedRecoveryCodes: number;
}

export interface PairingGrantRecord {
  readonly pairingId: string;
  readonly secret: string;
  readonly expiresAt: string;
}

export class DeviceBindingConflictError extends Error {
  constructor(readonly deviceId: string) {
    super("Device key does not match the trusted device");
    this.name = "DeviceBindingConflictError";
  }
}

export class DeviceTrustRepositoryError extends Error {
  constructor(
    readonly code: "NOT_TRUSTED" | "REVOKED" | "KEY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "DeviceTrustRepositoryError";
  }
}

export class IdentityRepository {
  readonly #file: SqliteStateFile;
  readonly #recoveryHandoffs: boolean;
  readonly #securityAudit: boolean;

  constructor(
    file: SqliteStateFile,
    options: {
      readonly recoveryHandoffs?: boolean;
      readonly securityAudit?: boolean;
    } = {},
  ) {
    this.#file = file;
    this.#recoveryHandoffs = options.recoveryHandoffs ?? true;
    this.#securityAudit = options.securityAudit ?? true;
  }

  status(): Promise<IdentityStatusRecord> {
    return this.#file.read((database) => ({
      passkeys: count(database, "passkeys"),
      password: count(database, "web_password") > 0,
      trustedDevices:
        queryRows(
          database,
          "SELECT COUNT(*) AS count FROM trusted_devices WHERE revoked_at IS NULL",
        ).map((row) => integer(row.count, "trusted device count"))[0] ?? 0,
      unusedRecoveryCodes:
        queryRows(
          database,
          "SELECT COUNT(*) AS count FROM recovery_codes WHERE used_at IS NULL",
        ).map((row) => integer(row.count, "recovery code count"))[0] ?? 0,
    }));
  }

  passkeys(): Promise<PasskeyCredentialRecord[]> {
    return this.#file.read((database) =>
      queryRows(
        database,
        "SELECT credential_id, public_key, sign_count FROM passkeys ORDER BY created_at",
      ).map((row) => ({
        id: decodeCredentialId(blob(row.credential_id, "credential id")),
        publicKey: blob(row.public_key, "credential public key"),
        counter: integer(row.sign_count, "credential sign count"),
      })),
    );
  }

  addPasskey(input: {
    readonly id: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly requireUninitialized: boolean;
    readonly recoveryHashes?: readonly Uint8Array[];
    readonly now?: string;
  }): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      if (input.requireUninitialized && identityInitialized(database)) {
        throw new Error("Web identity is already initialized");
      }
      database.run(
        "INSERT INTO passkeys (credential_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?)",
        [encodeCredentialId(input.id), input.publicKey, input.counter, now],
      );
      for (const hash of input.recoveryHashes ?? []) {
        database.run(
          "INSERT INTO recovery_codes (hash, created_at, used_at) VALUES (?, ?, NULL)",
          [hash, now],
        );
      }
      this.#audit(database, "passkey/registered", undefined, now);
    });
  }

  updatePasskeyCounter(id: string, counter: number): Promise<void> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE passkeys SET sign_count = ? WHERE credential_id = ?",
        [counter, encodeCredentialId(id)],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("Passkey disappeared during authentication");
      }
    });
  }

  passwordRecord(): Promise<string | undefined> {
    return this.#file.read((database) => {
      const row = queryRows(
        database,
        "SELECT registration_record FROM web_password WHERE id = 1",
      )[0];
      return row === undefined
        ? undefined
        : text(row.registration_record, "password record");
    });
  }

  savePassword(input: {
    readonly registrationRecord: string;
    readonly requireUninitialized: boolean;
    readonly now?: string;
  }): Promise<void> {
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      if (input.requireUninitialized && identityInitialized(database)) {
        throw new Error("Web identity is already initialized");
      }
      database.run(
        "INSERT OR REPLACE INTO web_password (id, registration_record, updated_at) VALUES (1, ?, ?)",
        [input.registrationRecord, now],
      );
      this.#audit(database, "password/registered", undefined, now);
    });
  }

  rememberDevice(input: {
    readonly id: string;
    readonly name: string;
    readonly publicKey: Uint8Array;
    readonly now?: string;
  }): Promise<TrustedDeviceRecord> {
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      const existing = readDevice(database, input.id);
      if (
        existing !== undefined &&
        !sameBytes(existing.publicKey, input.publicKey)
      ) {
        throw new DeviceBindingConflictError(input.id);
      }
      if (existing === undefined) {
        database.run(
          "INSERT INTO trusted_devices (id, name, public_key, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
          [input.id, input.name, input.publicKey, now],
        );
      } else {
        database.run(
          "UPDATE trusted_devices SET name = ?, revoked_at = NULL WHERE id = ?",
          [input.name, input.id],
        );
      }
      this.#audit(database, "device/remembered", input.id, now);
      return readDevice(database, input.id)!;
    });
  }

  issuePairing(ttlMs = 10 * 60_000): Promise<PairingGrantRecord> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Pairing lifetime must be positive");
    }
    const pairingId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    return this.#file.transaction((database) => {
      database.run("DELETE FROM pairing_sessions WHERE expires_at <= ?", [
        createdAt,
      ]);
      database.run(
        "INSERT INTO pairing_sessions (id, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
        [pairingId, hashPairingSecret(secret), expiresAt, createdAt],
      );
      return { pairingId, secret, expiresAt };
    });
  }

  consumePairing(input: {
    readonly pairingId: string;
    readonly secret: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly publicKey: Uint8Array;
    readonly now?: string;
  }): Promise<TrustedDeviceRecord> {
    validateDevice(input.deviceId, input.deviceName, input.publicKey);
    const now = input.now ?? new Date().toISOString();
    return this.#file.transaction((database) => {
      const pairing = queryRows(
        database,
        "SELECT secret_hash, expires_at FROM pairing_sessions WHERE id = ?",
        [input.pairingId],
      )[0];
      if (pairing === undefined) throw invalidPairing();
      const expected = blob(pairing.secret_hash, "pairing secret hash");
      const actual = hashPairingSecret(input.secret);
      if (!sameBytes(expected, actual)) throw invalidPairing();
      if (
        Date.parse(text(pairing.expires_at, "pairing expiry")) <=
        Date.parse(now)
      ) {
        database.run("DELETE FROM pairing_sessions WHERE id = ?", [
          input.pairingId,
        ]);
        throw new Error("Pairing grant has expired");
      }
      if (readDevice(database, input.deviceId) !== undefined) {
        throw new Error("Device ID is already registered");
      }
      database.run(
        "INSERT INTO trusted_devices (id, name, public_key, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
        [input.deviceId, input.deviceName, input.publicKey, now],
      );
      database.run("DELETE FROM pairing_sessions WHERE id = ?", [
        input.pairingId,
      ]);
      this.#audit(database, "device/paired", input.deviceId, now);
      return readDevice(database, input.deviceId)!;
    });
  }

  device(id: string): Promise<TrustedDeviceRecord | undefined> {
    return this.#file.read((database) => readDevice(database, id));
  }

  devices(): Promise<TrustedDeviceRecord[]> {
    return this.#file.read((database) =>
      queryRows(
        database,
        "SELECT id FROM trusted_devices ORDER BY created_at, id",
      ).map((row) => readDevice(database, text(row.id, "device id"))!),
    );
  }

  async matchDevice(
    id: string,
    publicKey: Uint8Array,
  ): Promise<TrustedDeviceRecord | undefined> {
    const device = await this.device(id);
    if (device === undefined) return undefined;
    if (!sameBytes(device.publicKey, publicKey)) {
      throw new DeviceTrustRepositoryError(
        "KEY_MISMATCH",
        "Device key does not match trusted device",
      );
    }
    return device;
  }

  verifyDevice(
    id: string,
    publicKey: Uint8Array,
  ): Promise<TrustedDeviceRecord> {
    return this.matchDevice(id, publicKey).then((device) => {
      if (device === undefined) {
        throw new DeviceTrustRepositoryError(
          "NOT_TRUSTED",
          "Device is not trusted",
        );
      }
      if (device.revokedAt !== undefined) {
        throw new DeviceTrustRepositoryError("REVOKED", "Device was revoked");
      }
      return device;
    });
  }

  revokeDevice(id: string, now = new Date().toISOString()): Promise<boolean> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE trusted_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        [now, id],
      );
      const changed = database.getRowsModified() === 1;
      if (changed) this.#audit(database, "device/revoked", id, now);
      return changed;
    });
  }

  recoveryHashes(): Promise<Uint8Array[]> {
    return this.#file.read((database) => {
      const hashes = queryRows(
        database,
        "SELECT hash FROM recovery_codes WHERE used_at IS NULL ORDER BY created_at",
      ).map((row) => blob(row.hash, "recovery hash"));
      if (!this.#recoveryHandoffs) return hashes;
      return [
        ...hashes,
        ...queryRows(
          database,
          "SELECT hash FROM recovery_handoffs WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at",
          [new Date().toISOString()],
        ).map((row) => blob(row.hash, "recovery handoff hash")),
      ];
    });
  }

  consumeRecoveryHash(
    hash: Uint8Array,
    now = new Date().toISOString(),
  ): Promise<void> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL",
        [now, hash],
      );
      if (database.getRowsModified() === 0 && this.#recoveryHandoffs) {
        database.run(
          "UPDATE recovery_handoffs SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
          [now, hash, now],
        );
      }
      if (database.getRowsModified() !== 1) {
        throw new Error("Recovery authorization is invalid or already used");
      }
      this.#audit(database, "identity/recovered", undefined, now);
    });
  }

  /** Consumes recovery authorization and rotates every code in one commit. */
  consumeRecoveryAndReplace(
    hash: Uint8Array,
    replacementHashes: readonly Uint8Array[],
    now = new Date().toISOString(),
  ): Promise<void> {
    if (replacementHashes.length === 0) {
      return Promise.reject(new Error("Recovery replacement cannot be empty"));
    }
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL",
        [now, hash],
      );
      let consumed = database.getRowsModified();
      if (consumed === 0 && this.#recoveryHandoffs) {
        database.run(
          "UPDATE recovery_handoffs SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?",
          [now, hash, now],
        );
        consumed = database.getRowsModified();
      }
      if (consumed !== 1) {
        throw new Error("Recovery authorization is invalid or already used");
      }

      database.run("DELETE FROM recovery_codes");
      for (const replacementHash of replacementHashes) {
        database.run(
          "INSERT INTO recovery_codes (hash, created_at, used_at) VALUES (?, ?, NULL)",
          [replacementHash, now],
        );
      }
      this.#audit(database, "identity/recovered", undefined, now);
      this.#audit(database, "recovery/rotated", undefined, now);
    });
  }

  replaceRecoveryCodes(
    hashes: readonly Uint8Array[],
    now = new Date().toISOString(),
  ): Promise<void> {
    return this.#file.transaction((database) => {
      database.run("DELETE FROM recovery_codes");
      for (const hash of hashes) {
        database.run(
          "INSERT INTO recovery_codes (hash, created_at, used_at) VALUES (?, ?, NULL)",
          [hash, now],
        );
      }
      this.#audit(database, "recovery/rotated", undefined, now);
    });
  }

  issueRecoveryHandoff(
    hash: Uint8Array,
    ttlMs = 15 * 60_000,
  ): Promise<{ readonly expiresAt: string }> {
    if (!this.#recoveryHandoffs) {
      return Promise.reject(
        new Error("Recovery handoffs are unavailable for this identity"),
      );
    }
    if (hash.byteLength === 0 || hash.byteLength > 4_096) {
      return Promise.reject(new Error("Recovery handoff hash is invalid"));
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      return Promise.reject(new Error("Recovery handoff lifetime is invalid"));
    }
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    return this.#file.transaction((database) => {
      database.run(
        "DELETE FROM recovery_handoffs WHERE expires_at <= ? OR used_at IS NOT NULL",
        [createdAt],
      );
      database.run(
        "INSERT INTO recovery_handoffs (hash, expires_at, created_at, used_at) VALUES (?, ?, ?, NULL)",
        [hash, expiresAt, createdAt],
      );
      this.#audit(database, "recovery/handoff-issued", undefined, createdAt);
      return { expiresAt };
    });
  }

  #audit(
    database: Database,
    kind: string,
    subjectId: string | undefined,
    now: string,
  ): void {
    if (this.#securityAudit) audit(database, kind, subjectId, now);
  }
}

function readDevice(
  database: Database,
  id: string,
): TrustedDeviceRecord | undefined {
  const row = queryRows(
    database,
    "SELECT id, name, public_key, created_at, revoked_at FROM trusted_devices WHERE id = ?",
    [id],
  )[0];
  if (row === undefined) return undefined;
  const revokedAt = nullableText(row.revoked_at, "device revoked_at");
  return {
    id: text(row.id, "device id"),
    name: text(row.name, "device name"),
    publicKey: blob(row.public_key, "device public key"),
    createdAt: text(row.created_at, "device created_at"),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function count(database: Database, table: "passkeys" | "web_password"): number {
  const row = queryRows(database, `SELECT COUNT(*) AS count FROM ${table}`)[0];
  if (row === undefined) throw new Error("Identity table is missing");
  return integer(row.count, `${table} count`);
}

function identityInitialized(database: Database): boolean {
  return count(database, "passkeys") > 0 || count(database, "web_password") > 0;
}

function encodeCredentialId(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeCredentialId(value: Uint8Array): string {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (decoded.length === 0) throw new Error("Credential ID is empty");
  return decoded;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}

function hashPairingSecret(secret: string): Uint8Array {
  return createHash("sha256").update(secret, "utf8").digest();
}

function validateDevice(id: string, name: string, key: Uint8Array): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("Invalid device ID");
  if (name.length < 1 || name.length > 128) {
    throw new Error("Invalid device name");
  }
  if (key.byteLength !== 32) throw new Error("Invalid device public key");
}

function invalidPairing(): Error {
  return new Error("Pairing grant is invalid or already used");
}

function audit(
  database: Database,
  kind: string,
  subjectId: string | undefined,
  now: string,
): void {
  database.run(
    "INSERT INTO audit_events (id, kind, subject_id, created_at) VALUES (?, ?, ?, ?)",
    [randomUUID(), kind, subjectId ?? null, now],
  );
}
