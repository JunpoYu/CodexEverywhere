import { createHash } from "node:crypto";

import type { ProtocolError } from "@codex-everywhere/protocol";

import type { HostStateStore } from "./state-store.js";

export type IdempotentResult =
  { ok: true; result: unknown } | { ok: false; error: ProtocolError };

const RESULT_TTL_MS = 24 * 60 * 60_000;
const inFlight = new Map<string, Promise<IdempotentResult>>();

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
