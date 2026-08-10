import { createHash } from "node:crypto";

import type { ProtocolError } from "@codex-everywhere/protocol";
import type { RequestEnvelope } from "@codex-everywhere/protocol";

import type { HostStateStore } from "./state-store.js";

export type IdempotentResult =
  { ok: true; result: unknown } | { ok: false; error: ProtocolError };

const RESULT_TTL_MS = 24 * 60 * 60_000;
const inFlight = new Map<string, Promise<IdempotentResult>>();
const EPHEMERAL_RESULT_LIMIT = 128;
const EPHEMERAL_RESULT_TTL_MS = 5 * 60_000;

type EphemeralEntry = {
  fingerprint: string;
  pending?: Promise<IdempotentResult>;
  result?: IdempotentResult;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

/**
 * Authentication and login exchanges must never reach the persistent 24-hour
 * replay table. Request payloads are retained only as fingerprints; raw
 * responses remain in this bounded per-transport memory cache for at most five
 * minutes so an open page can resolve an unknown network outcome. Closing the
 * transport clears them immediately.
 */
export class EphemeralIdempotencyRegistry {
  readonly #entries = new Map<string, EphemeralEntry>();
  readonly #maximumEntries: number;

  constructor(maximumEntries = EPHEMERAL_RESULT_LIMIT) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0)
      throw new Error("Ephemeral idempotency limit must be positive");
    this.#maximumEntries = maximumEntries;
  }

  async execute(
    request: RequestEnvelope,
    operation: () => Promise<unknown>,
  ): Promise<IdempotentResult> {
    const key = request.idempotencyKey;
    if (key.length < 8 || key.length > 200)
      throw new Error("Invalid idempotency key");
    const fingerprint = requestFingerprint(request);
    let existing = this.#entries.get(key);
    if (existing?.expiresAt !== undefined && existing.expiresAt <= Date.now()) {
      this.#delete(key);
      existing = undefined;
    }
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return requestFailure(
          "Idempotency key was reused for a different request",
        );
      }
      if (existing.pending) return existing.pending;
      if (existing.result) {
        this.#entries.delete(key);
        this.#entries.set(key, existing);
        return existing.result;
      }
    }
    while (this.#entries.size >= this.#maximumEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#delete(oldest);
    }
    const pending = captureResult(operation);
    const pendingEntry: EphemeralEntry = {
      fingerprint,
      pending,
    };
    this.#entries.set(key, pendingEntry);
    const result = await pending;
    // clear() or LRU eviction may remove an in-flight entry while its operation
    // completes. Never resurrect secret-bearing output after that boundary.
    if (this.#entries.get(key) !== pendingEntry) return result;
    const settledEntry: EphemeralEntry = {
      fingerprint,
      result,
      expiresAt: Date.now() + EPHEMERAL_RESULT_TTL_MS,
    };
    settledEntry.expiryTimer = setTimeout(() => {
      if (this.#entries.get(key) === settledEntry) this.#delete(key);
    }, EPHEMERAL_RESULT_TTL_MS);
    settledEntry.expiryTimer.unref?.();
    this.#entries.set(key, settledEntry);
    return result;
  }

  clear(): void {
    for (const entry of this.#entries.values()) {
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    }
    this.#entries.clear();
  }

  #delete(key: string): void {
    const entry = this.#entries.get(key);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    this.#entries.delete(key);
  }
}

export function usesEphemeralGatewayIdempotency(method: string): boolean {
  return (
    method.startsWith("auth/") ||
    method === "codex/account/login/start" ||
    method === "admin/recovery/start"
  );
}

export class IdempotencyRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  async execute(
    deviceId: string,
    idempotencyKey: string,
    operation: () => Promise<unknown>,
  ): Promise<IdempotentResult> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
      throw new Error("Invalid idempotency key");
    const key = digestKey(deviceId, idempotencyKey);
    const cached = await this.#read(key);
    if (cached) return cached;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = this.#runAndStore(key, operation);
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  }

  async #runAndStore(
    key: string,
    operation: () => Promise<unknown>,
  ): Promise<IdempotentResult> {
    let value: IdempotentResult;
    try {
      value = { ok: true, result: await operation() };
    } catch (error) {
      value = {
        ok: false,
        error: {
          code: "REQUEST_FAILED",
          message: error instanceof Error ? error.message : "Request failed",
        },
      };
    }
    await this.#state.transaction((database) => {
      database.run("DELETE FROM idempotency_keys WHERE expires_at <= ?", [
        new Date().toISOString(),
      ]);
      database.run(
        "INSERT OR REPLACE INTO idempotency_keys (key, result_json, expires_at) VALUES (?, ?, ?)",
        [
          key,
          JSON.stringify(value),
          new Date(Date.now() + RESULT_TTL_MS).toISOString(),
        ],
      );
    });
    return value;
  }

  #read(key: string): Promise<IdempotentResult | undefined> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT result_json FROM idempotency_keys WHERE key = ? AND expires_at > ?",
      );
      try {
        statement.bind([key, new Date().toISOString()]);
        if (!statement.step()) return undefined;
        const row = statement.getAsObject() as { result_json?: unknown };
        if (typeof row.result_json !== "string") return undefined;
        return JSON.parse(row.result_json) as IdempotentResult;
      } finally {
        statement.free();
      }
    });
  }
}

function digestKey(deviceId: string, key: string): string {
  return createHash("sha256")
    .update("ce-idempotency-v1\0")
    .update(deviceId)
    .update("\0")
    .update(key)
    .digest("base64url");
}

function requestFingerprint(request: RequestEnvelope): string {
  return createHash("sha256")
    .update("ce-ephemeral-idempotency-v1\0")
    .update(request.method)
    .update("\0")
    .update(JSON.stringify(request.payload))
    .digest("base64url");
}

function captureResult(
  operation: () => Promise<unknown>,
): Promise<IdempotentResult> {
  return Promise.resolve()
    .then(operation)
    .then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) =>
        requestFailure(
          error instanceof Error ? error.message : "Request failed",
        ),
    );
}

function requestFailure(message: string): IdempotentResult {
  return {
    ok: false,
    error: {
      code: "REQUEST_FAILED",
      message,
    },
  };
}
