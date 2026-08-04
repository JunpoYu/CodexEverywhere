import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import type { Database } from "sql.js";

import type { HostStateStore } from "./state-store.js";

export type WebAuthnIdentity = {
  origin: string;
  rpId: string;
  userName: string;
  userDisplayName?: string;
  nodeId: string;
  userHandle?: Uint8Array;
};

export class PasskeyRegistry {
  readonly #state: HostStateStore;
  readonly #identity: WebAuthnIdentity;

  constructor(state: HostStateStore, identity: WebAuthnIdentity) {
    this.#state = state;
    this.#identity = identity;
  }

  async count(): Promise<number> {
    return this.#state.read((database) => {
      const result = database.exec("SELECT COUNT(*) FROM passkeys");
      return Number(result[0]?.values[0]?.[0] ?? 0);
    });
  }

  async registrationOptions(): Promise<
    Awaited<ReturnType<typeof generateRegistrationOptions>>
  > {
    const credentials = await this.#credentials();
    return generateRegistrationOptions({
      rpName: "CodexEverywhere",
      rpID: this.#identity.rpId,
      userName: this.#identity.userName,
      userDisplayName:
        this.#identity.userDisplayName ?? this.#identity.userName,
      userID:
        this.#identity.userHandle !== undefined
          ? Uint8Array.from(this.#identity.userHandle)
          : createHash("sha256")
              .update(`ce-passkey-user-v1\0${this.#identity.nodeId}`)
              .digest(),
      attestationType: "none",
      excludeCredentials: credentials.map((credential) => ({
        id: credential.id,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });
  }

  async verifyRegistration(
    response: RegistrationResponseJSON,
    challenge: string,
    options: {
      replaceExisting?: boolean;
      issueRecoveryCodes?: boolean;
      recoveryCode?: string;
    } = {},
  ): Promise<{ recoveryCodes: string[] }> {
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.#identity.origin,
      expectedRPID: this.#identity.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error("Passkey registration failed");
    const credential = verification.registrationInfo.credential;
    const recoveryCodes = options.issueRecoveryCodes
      ? createRecoveryCodes()
      : [];
    await this.#state.transaction((database) => {
      const createdAt = new Date().toISOString();
      if (options.replaceExisting) {
        if (!options.recoveryCode)
          throw new Error("Recovery code authorization is missing");
        const recoveryHash = findRecoveryHash(
          database,
          normalizeRecoveryCode(options.recoveryCode),
        );
        if (!recoveryHash)
          throw new Error("Recovery code is invalid or already used");
        database.run(
          "UPDATE recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL",
          [createdAt, recoveryHash],
        );
        if (database.getRowsModified() !== 1)
          throw new Error("Recovery code is invalid or already used");
        database.run("DELETE FROM passkeys");
        database.run("DELETE FROM recovery_codes");
        database.run("DELETE FROM web_password");
        database.run("DELETE FROM pairing_sessions");
        database.run("DELETE FROM push_subscriptions");
        database.run(
          "UPDATE trusted_devices SET revoked_at = ? WHERE revoked_at IS NULL",
          [createdAt],
        );
        database.run(
          "INSERT INTO audit_events (kind, subject_id, created_at) VALUES (?, ?, ?)",
          ["web_credentials_recovered", "user", createdAt],
        );
      }
      database.run(
        "INSERT INTO passkeys (credential_id, public_key, sign_count, created_at) VALUES (?, ?, ?, ?)",
        [credential.id, credential.publicKey, credential.counter, createdAt],
      );
      for (const code of recoveryCodes) {
        database.run(
          "INSERT INTO recovery_codes (hash, created_at) VALUES (?, ?)",
          [hashRecoveryCode(code), createdAt],
        );
      }
    });
    return { recoveryCodes };
  }

  async consumeRecoveryCode(code: string): Promise<void> {
    const normalized = normalizeRecoveryCode(code);
    const match = await this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT hash FROM recovery_codes WHERE used_at IS NULL",
      );
      try {
        while (statement.step()) {
          const row = statement.getAsObject() as Record<string, unknown>;
          if (
            row.hash instanceof Uint8Array &&
            verifyRecoveryCode(normalized, row.hash)
          )
            return row.hash;
        }
        return undefined;
      } finally {
        statement.free();
      }
    });
    if (!match) throw new Error("Recovery code is invalid or already used");
    await this.#state.transaction((database) => {
      database.run(
        "UPDATE recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL",
        [new Date().toISOString(), match],
      );
      if (database.getRowsModified() !== 1)
        throw new Error("Recovery code is invalid or already used");
    });
  }

  async verifyRecoveryCode(code: string): Promise<void> {
    const normalized = normalizeRecoveryCode(code);
    const match = await this.#state.read((database) =>
      findRecoveryHash(database, normalized),
    );
    if (!match) throw new Error("Recovery code is invalid or already used");
  }

  rotateRecoveryCodes(subject = "user"): Promise<string[]> {
    const recoveryCodes = createRecoveryCodes();
    const createdAt = new Date().toISOString();
    return this.#state.transaction((database) => {
      database.run("DELETE FROM recovery_codes");
      for (const code of recoveryCodes) {
        database.run(
          "INSERT INTO recovery_codes (hash, created_at) VALUES (?, ?)",
          [hashRecoveryCode(code), createdAt],
        );
      }
      database.run(
        "INSERT INTO audit_events (kind, subject_id, created_at) VALUES (?, ?, ?)",
        ["recovery_codes_rotated", subject, createdAt],
      );
      return recoveryCodes;
    });
  }

  async authenticationOptions(
    discoverable = false,
  ): Promise<Awaited<ReturnType<typeof generateAuthenticationOptions>>> {
    const credentials = await this.#credentials();
    if (credentials.length === 0) throw new Error("No Passkey is registered");
    return generateAuthenticationOptions({
      rpID: this.#identity.rpId,
      ...(discoverable
        ? {}
        : {
            allowCredentials: credentials.map((credential) => ({
              id: credential.id,
            })),
          }),
      userVerification: "required",
    });
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    challenge: string,
  ): Promise<void> {
    const credential = await this.#credential(response.id);
    if (!credential) throw new Error("Unknown Passkey");
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.#identity.origin,
      expectedRPID: this.#identity.rpId,
      credential,
      requireUserVerification: true,
    });
    if (!verification.verified)
      throw new Error("Passkey authentication failed");
    await this.#state.transaction((database) => {
      database.run(
        "UPDATE passkeys SET sign_count = ? WHERE credential_id = ?",
        [verification.authenticationInfo.newCounter, credential.id],
      );
    });
  }

  #credentials(): Promise<WebAuthnCredential[]> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT credential_id, public_key, sign_count FROM passkeys",
      );
      const credentials: WebAuthnCredential[] = [];
      try {
        while (statement.step()) {
          const row = statement.getAsObject() as Record<string, unknown>;
          if (
            typeof row.credential_id !== "string" ||
            !(row.public_key instanceof Uint8Array)
          )
            continue;
          credentials.push({
            id: row.credential_id,
            publicKey: Uint8Array.from(row.public_key),
            counter: Number(row.sign_count),
          });
        }
      } finally {
        statement.free();
      }
      return credentials;
    });
  }

  async #credential(id: string): Promise<WebAuthnCredential | undefined> {
    return (await this.#credentials()).find(
      (credential) => credential.id === id,
    );
  }
}

function createRecoveryCodes(): string[] {
  const raw = randomBytes(10).toString("hex").toUpperCase();
  return [
    `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15)}`,
  ];
}

function hashRecoveryCode(code: string): Uint8Array {
  const salt = randomBytes(16);
  return Buffer.concat([salt, scryptSync(code, salt, 32)]);
}

function verifyRecoveryCode(code: string, stored: Uint8Array): boolean {
  if (stored.byteLength !== 48) return false;
  const salt = stored.slice(0, 16);
  const expected = stored.slice(16);
  return timingSafeEqual(scryptSync(code, salt, 32), expected);
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase();
}

function findRecoveryHash(
  database: Database,
  normalizedCode: string,
): Uint8Array | undefined {
  const statement = database.prepare(
    "SELECT hash FROM recovery_codes WHERE used_at IS NULL",
  );
  try {
    while (statement.step()) {
      const row = statement.getAsObject() as Record<string, unknown>;
      if (
        row.hash instanceof Uint8Array &&
        verifyRecoveryCode(normalizedCode, row.hash)
      ) {
        return row.hash;
      }
    }
    return undefined;
  } finally {
    statement.free();
  }
}
