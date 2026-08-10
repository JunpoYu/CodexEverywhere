import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { HostStateStore } from "./state-store.js";

export type PairingGrant = {
  pairingId: string;
  secret: string;
  expiresAt: string;
};

export type TrustedDevice = {
  id: string;
  name: string;
  publicKey: Uint8Array;
  createdAt: string;
  revokedAt?: string;
};

export class DeviceTrustError extends Error {
  readonly code: "NOT_TRUSTED" | "REVOKED" | "KEY_MISMATCH";

  constructor(
    code: "NOT_TRUSTED" | "REVOKED" | "KEY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "DeviceTrustError";
    this.code = code;
  }
}

/**
 * Coalesces repeated trust checks from an active authenticated Web session.
 * A fresh transport still performs an uncached database lookup in
 * DirectGateway, while high-frequency RPCs share a short success window so a
 * busy thread view does not reload the sql.js database for every request.
 */
export class CachedDeviceTrustVerifier {
  readonly #registry: Pick<DeviceRegistry, "verify">;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<
    string,
    { expiresAt: number; verification: Promise<TrustedDevice> }
  >();

  constructor(
    registry: Pick<DeviceRegistry, "verify">,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#registry = registry;
    this.#ttlMs = options.ttlMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0)
      throw new Error("Device trust cache lifetime must be positive");
  }

  async verify(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<TrustedDevice> {
    const key = `${deviceId}\0${Buffer.from(publicKey).toString("base64url")}`;
    const now = this.#now();
    const current = this.#entries.get(key);
    if (current && now < current.expiresAt) return current.verification;
    const verification = this.#registry.verify(deviceId, publicKey);
    const entry = { expiresAt: now + this.#ttlMs, verification };
    this.#entries.set(key, entry);
    try {
      return await verification;
    } catch (error) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw error;
    }
  }
}

export class DeviceRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  issuePairing(ttlMs = 10 * 60_000): Promise<PairingGrant> {
    const pairingId = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return this.#state.transaction((database) => {
      database.run("DELETE FROM pairing_sessions WHERE expires_at <= ?", [
        createdAt,
      ]);
      database.run("INSERT INTO pairing_sessions VALUES (?, ?, ?, ?)", [
        pairingId,
        hashSecret(secret),
        expiresAt,
        createdAt,
      ]);
      return { pairingId, secret, expiresAt };
    });
  }

  consumePairing(input: {
    pairingId: string;
    secret: string;
    deviceId: string;
    deviceName: string;
    publicKey: Uint8Array;
  }): Promise<TrustedDevice> {
    validateDeviceInput(input.deviceId, input.deviceName, input.publicKey);
    return this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT secret_hash, expires_at FROM pairing_sessions WHERE id = ?",
      );
      let row: unknown[] | undefined;
      try {
        statement.bind([input.pairingId]);
        if (statement.step()) row = statement.get();
      } finally {
        statement.free();
      }
      if (!row) throw new Error("Pairing grant is invalid or already used");
      const expected = toBytes(row[0]);
      const actual = hashSecret(input.secret);
      if (
        expected.byteLength !== actual.byteLength ||
        !timingSafeEqual(expected, actual)
      ) {
        throw new Error("Pairing grant is invalid or already used");
      }
      if (Date.parse(String(row[1])) <= Date.now()) {
        database.run("DELETE FROM pairing_sessions WHERE id = ?", [
          input.pairingId,
        ]);
        throw new Error("Pairing grant has expired");
      }

      const createdAt = new Date().toISOString();
      database.run(
        "INSERT INTO trusted_devices(id, name, public_key, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
        [input.deviceId, input.deviceName, input.publicKey, createdAt],
      );
      database.run("DELETE FROM pairing_sessions WHERE id = ?", [
        input.pairingId,
      ]);
      return {
        id: input.deviceId,
        name: input.deviceName,
        publicKey: input.publicKey,
        createdAt,
      };
    });
  }

  async verify(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<TrustedDevice> {
    const device = await this.match(deviceId, publicKey);
    if (!device)
      throw new DeviceTrustError("NOT_TRUSTED", "Device is not trusted");
    if (device.revokedAt)
      throw new DeviceTrustError("REVOKED", "Device was revoked");
    return device;
  }

  async match(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<TrustedDevice | undefined> {
    const device = await this.get(deviceId);
    if (!device) return undefined;
    const expected = Buffer.from(device.publicKey);
    const actual = Buffer.from(publicKey);
    if (
      expected.byteLength !== actual.byteLength ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new DeviceTrustError(
        "KEY_MISMATCH",
        "Device key does not match trusted device",
      );
    }
    return device;
  }

  enrollAuthenticated(input: {
    deviceId: string;
    deviceName: string;
    publicKey: Uint8Array;
  }): Promise<TrustedDevice> {
    validateDeviceInput(input.deviceId, input.deviceName, input.publicKey);
    return this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT id FROM trusted_devices WHERE id = ?",
      );
      try {
        statement.bind([input.deviceId]);
        if (statement.step())
          throw new Error("Device ID is already registered");
      } finally {
        statement.free();
      }
      const createdAt = new Date().toISOString();
      database.run(
        "INSERT INTO trusted_devices(id, name, public_key, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
        [input.deviceId, input.deviceName, input.publicKey, createdAt],
      );
      return {
        id: input.deviceId,
        name: input.deviceName,
        publicKey: input.publicKey,
        createdAt,
      };
    });
  }

  async rememberAuthenticated(input: {
    deviceId: string;
    deviceName: string;
    publicKey: Uint8Array;
  }): Promise<{
    device: TrustedDevice;
    rollback?: () => Promise<void>;
  }> {
    validateDeviceInput(input.deviceId, input.deviceName, input.publicKey);
    const remembered = await this.#state.transaction((database) => {
      const statement = database.prepare(
        "SELECT public_key, created_at, revoked_at FROM trusted_devices WHERE id = ?",
      );
      let existing: unknown[] | undefined;
      try {
        statement.bind([input.deviceId]);
        if (statement.step()) existing = statement.get();
      } finally {
        statement.free();
      }
      if (existing) {
        const expected = Buffer.from(toBytes(existing[0]));
        const actual = Buffer.from(input.publicKey);
        if (
          expected.byteLength !== actual.byteLength ||
          !timingSafeEqual(expected, actual)
        ) {
          throw new DeviceTrustError(
            "KEY_MISMATCH",
            "Device key does not match trusted device",
          );
        }
        const changed = existing[2] != null;
        if (changed) {
          database.run(
            "UPDATE trusted_devices SET name = ?, revoked_at = NULL WHERE id = ? AND revoked_at IS NOT NULL",
            [input.deviceName, input.deviceId],
          );
          if (database.getRowsModified() !== 1)
            throw new Error("Device trust changed during authentication");
        }
        return {
          changed,
          device: {
            id: input.deviceId,
            name: input.deviceName,
            publicKey: input.publicKey,
            createdAt: String(existing[1]),
          },
        };
      }
      const createdAt = new Date().toISOString();
      database.run(
        "INSERT INTO trusted_devices(id, name, public_key, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)",
        [input.deviceId, input.deviceName, input.publicKey, createdAt],
      );
      return {
        changed: true,
        device: {
          id: input.deviceId,
          name: input.deviceName,
          publicKey: input.publicKey,
          createdAt,
        },
      };
    });
    return {
      device: remembered.device,
      ...(remembered.changed
        ? {
            rollback: async () => {
              await this.revoke(input.deviceId);
            },
          }
        : {}),
    };
  }

  get(deviceId: string): Promise<TrustedDevice | undefined> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT id, name, public_key, created_at, revoked_at FROM trusted_devices WHERE id = ?",
      );
      try {
        statement.bind([deviceId]);
        if (!statement.step()) return undefined;
        return rowToDevice(statement.get());
      } finally {
        statement.free();
      }
    });
  }

  list(): Promise<TrustedDevice[]> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT id, name, public_key, created_at, revoked_at FROM trusted_devices ORDER BY created_at",
      );
      const devices: TrustedDevice[] = [];
      try {
        while (statement.step()) devices.push(rowToDevice(statement.get()));
        return devices;
      } finally {
        statement.free();
      }
    });
  }

  revoke(deviceId: string): Promise<boolean> {
    return this.#state.transaction((database) => {
      database.run(
        "UPDATE trusted_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        [new Date().toISOString(), deviceId],
      );
      return database.getRowsModified() > 0;
    });
  }
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function validateDeviceInput(
  id: string,
  name: string,
  publicKey: Uint8Array,
): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid device ID");
  if (name.length < 1 || name.length > 128)
    throw new Error("Invalid device name");
  if (publicKey.byteLength !== 32) throw new Error("Invalid device public key");
}

function rowToDevice(row: unknown[]): TrustedDevice {
  const revokedAt = row[4] == null ? undefined : String(row[4]);
  return {
    id: String(row[0]),
    name: String(row[1]),
    publicKey: toBytes(row[2]),
    createdAt: String(row[3]),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function toBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new Error("Invalid binary value in host state");
  return value;
}
