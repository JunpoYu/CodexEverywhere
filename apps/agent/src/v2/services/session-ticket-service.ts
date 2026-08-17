import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";

export interface SessionTicketBinding {
  readonly deviceId: string;
  readonly devicePublicKey: Uint8Array;
  readonly principalId: string;
  readonly temporary: boolean;
}

type TicketRecord = SessionTicketBinding & {
  readonly hash: Uint8Array;
  readonly generation: number;
  readonly expiresAt: number;
};

/** In-memory, device-bound reconnect tickets. No ticket is written to disk. */
export class SessionTicketService {
  readonly #scope: Scope;
  readonly #ttlMs: number;
  readonly #tickets = new Map<string, TicketRecord>();
  #generation = 0;

  constructor(options: { readonly scope: Scope; readonly ttlMs?: number }) {
    this.#scope = options.scope.fork("session-tickets");
    this.#ttlMs = options.ttlMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new Error("Session ticket lifetime must be positive");
    }
    this.#scope.defer(() => this.#tickets.clear());
  }

  issue(binding: SessionTicketBinding): string {
    this.#scope.throwIfClosed();
    validateBinding(binding);
    const token = randomBytes(32).toString("base64url");
    const hash = tokenHash(token);
    const key = Buffer.from(hash).toString("base64url");
    const record: TicketRecord = {
      ...binding,
      devicePublicKey: Uint8Array.from(binding.devicePublicKey),
      hash,
      generation: this.#generation,
      expiresAt: Date.now() + this.#ttlMs,
    };
    this.#tickets.set(key, record);
    this.#scope.setTimeout(() => {
      if (this.#tickets.get(key) === record) this.#tickets.delete(key);
    }, this.#ttlMs);
    return token;
  }

  verify(
    token: string,
    device: { readonly id: string; readonly publicKey: Uint8Array },
  ): SessionTicketBinding | undefined {
    this.#scope.throwIfClosed();
    if (token.length < 32 || token.length > 2_048) return undefined;
    const hash = tokenHash(token);
    const record = this.#tickets.get(Buffer.from(hash).toString("base64url"));
    if (
      record === undefined ||
      record.generation !== this.#generation ||
      record.expiresAt <= Date.now() ||
      record.deviceId !== device.id ||
      !sameBytes(record.hash, hash) ||
      !sameBytes(record.devicePublicKey, device.publicKey)
    ) {
      return undefined;
    }
    return {
      deviceId: record.deviceId,
      devicePublicKey: Uint8Array.from(record.devicePublicKey),
      principalId: record.principalId,
      temporary: record.temporary,
    };
  }

  revokeAll(): void {
    this.#generation += 1;
    this.#tickets.clear();
  }

  revokeDevice(deviceId: string): void {
    for (const [key, record] of this.#tickets) {
      if (record.deviceId === deviceId) this.#tickets.delete(key);
    }
  }
}

function tokenHash(token: string): Uint8Array {
  return createHash("sha256")
    .update("ce-session-ticket-v1\0", "utf8")
    .update(token, "utf8")
    .digest();
}

function validateBinding(binding: SessionTicketBinding): void {
  if (binding.deviceId.length === 0 || binding.principalId.length === 0) {
    throw new Error("Session ticket binding is incomplete");
  }
  if (binding.devicePublicKey.byteLength !== 32) {
    throw new Error("Session ticket device key is invalid");
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    timingSafeEqual(Buffer.from(left), Buffer.from(right))
  );
}
