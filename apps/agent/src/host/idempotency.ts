import { createHash } from "node:crypto";

import {
  IDEMPOTENCY_OUTCOME_INDETERMINATE,
  type ProtocolError,
  type RequestEnvelope,
} from "@codex-everywhere/protocol";

import type { HostStateStore } from "./state-store.js";

export type IdempotentResult =
  { ok: true; result: unknown } | { ok: false; error: ProtocolError };

export type DurableMutationMethod = "thread/start" | "turn/start" | "queue/add";

type DurableMutationClaim = Pick<RequestEnvelope, "payload"> & {
  method: DurableMutationMethod;
};

type DurableMutationIdentity = {
  method: DurableMutationMethod;
  threadId: string | null;
  clientUserMessageId: string | null;
};

const RESULT_TTL_MS = 24 * 60 * 60_000;
const PERMANENT_IDEMPOTENCY_EXPIRY = "9999-12-31T23:59:59.999Z";
const LEGACY_THREAD_START_CLAIM_FINGERPRINT = "legacy-thread-start-claim-v1";
type InFlightEntry = {
  fingerprint?: string;
  promise: Promise<IdempotentResult>;
};
const inFlightByState = new WeakMap<
  HostStateStore,
  Map<string, InFlightEntry>
>();
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

export function usesDurableMutationClaim(
  method: string,
): method is DurableMutationMethod {
  return (
    method === "thread/start" ||
    method === "turn/start" ||
    method === "queue/add"
  );
}

export class IdempotencyRegistry {
  readonly #state: HostStateStore;
  readonly #inFlight: Map<string, InFlightEntry>;

  constructor(state: HostStateStore) {
    this.#state = state;
    this.#inFlight = inFlightFor(state);
  }

  execute(
    deviceId: string,
    idempotencyKey: string,
    operation: () => Promise<unknown>,
    options: {
      durableClaim?: Pick<RequestEnvelope, "method" | "payload">;
    } = {},
  ): Promise<IdempotentResult> {
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200)
      throw new Error("Invalid idempotency key");
    const key = digestKey(deviceId, idempotencyKey);
    const durableClaim = options.durableClaim;
    const durableMethod =
      durableClaim && usesDurableMutationClaim(durableClaim.method)
        ? durableClaim.method
        : undefined;
    if (durableClaim && !durableMethod) {
      throw new Error(`Unsupported durable mutation: ${durableClaim.method}`);
    }
    const durableIdentity =
      durableClaim && durableMethod
        ? durableMutationIdentity({
            method: durableMethod,
            payload: durableClaim.payload,
          })
        : undefined;
    const fingerprint = durableIdentity
      ? durableMutationFingerprint(durableIdentity)
      : undefined;
    const existing = this.#inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(
          requestFailure(
            "Idempotency key was reused for a different request",
            "IDEMPOTENCY_KEY_REUSED",
          ),
        );
      }
      return existing.promise;
    }
    const execution =
      durableIdentity && fingerprint
        ? this.#executeDurableMutation(
            key,
            durableIdentity,
            fingerprint,
            operation,
          )
        : this.#executeExpiring(key, operation);
    const tracked = execution.finally(() => {
      if (this.#inFlight.get(key)?.promise === tracked)
        this.#inFlight.delete(key);
    });
    this.#inFlight.set(
      key,
      fingerprint ? { fingerprint, promise: tracked } : { promise: tracked },
    );
    return tracked;
  }

  async #executeExpiring(
    key: string,
    operation: () => Promise<unknown>,
  ): Promise<IdempotentResult> {
    const cached = await this.#read(key);
    if (cached) return cached;
    return this.#runAndStore(key, operation);
  }

  async #executeDurableMutation(
    key: string,
    identity: DurableMutationIdentity,
    fingerprint: string,
    operation: () => Promise<unknown>,
  ): Promise<IdempotentResult> {
    const { method } = identity;
    const claim = await this.#state.transaction((database) => {
      const now = new Date().toISOString();
      const statement = database.prepare(
        "SELECT method, request_fingerprint, result_json FROM durable_mutation_claims WHERE key = ?",
      );
      try {
        statement.bind([key]);
        if (statement.step()) {
          const row = statement.getAsObject() as {
            method?: unknown;
            request_fingerprint?: unknown;
            result_json?: unknown;
          };
          const legacyThreadStartClaim =
            method === "thread/start" &&
            row.method === method &&
            row.request_fingerprint === LEGACY_THREAD_START_CLAIM_FINGERPRINT;
          if (
            row.method !== method ||
            (row.request_fingerprint !== fingerprint && !legacyThreadStartClaim)
          ) {
            return {
              kind: "result" as const,
              value: requestFailure(
                "Idempotency key was reused for a different request",
                "IDEMPOTENCY_KEY_REUSED",
              ),
            };
          }
          if (legacyThreadStartClaim) {
            database.run(
              "UPDATE durable_mutation_claims SET request_fingerprint = ? WHERE key = ?",
              [fingerprint, key],
            );
          }
          if (typeof row.result_json !== "string") {
            const value = indeterminateMutationResult(
              `A previous ${method} reached an indeterminate outcome; automatic replay is disabled`,
            );
            writeLegacyIdempotencyMirror(database, key, value);
            return {
              kind: "result" as const,
              value,
            };
          }
          try {
            const parsed = parseDurableMutationResult(
              identity,
              JSON.parse(row.result_json),
            );
            if (!parsed) throw new Error("Invalid durable result shape");
            const value = durableReplayResult(method, parsed);
            if (value !== parsed) {
              database.run(
                "UPDATE durable_mutation_claims SET result_json = ?, completed_at = ? WHERE key = ?",
                [JSON.stringify(value), now, key],
              );
            }
            writeLegacyIdempotencyMirror(database, key, value);
            return {
              kind: "result" as const,
              value,
            };
          } catch {
            const value = indeterminateMutationResult(
              `The durable ${method} result is unreadable; automatic replay is disabled`,
            );
            database.run(
              "UPDATE durable_mutation_claims SET result_json = ?, completed_at = ? WHERE key = ?",
              [JSON.stringify(value), now, key],
            );
            writeLegacyIdempotencyMirror(database, key, value);
            return {
              kind: "result" as const,
              value,
            };
          }
        }
      } finally {
        statement.free();
      }

      const legacy = database.prepare(
        "SELECT result_json FROM idempotency_keys WHERE key = ? AND expires_at > ?",
      );
      try {
        legacy.bind([key, now]);
        if (legacy.step()) {
          const row = legacy.getAsObject() as { result_json?: unknown };
          let value: IdempotentResult;
          try {
            if (typeof row.result_json !== "string")
              throw new Error("Missing legacy result");
            const parsed = parseDurableMutationResult(
              identity,
              JSON.parse(row.result_json),
            );
            if (!parsed) throw new Error("Invalid legacy result shape");
            value = durableReplayResult(method, parsed);
          } catch {
            value = indeterminateMutationResult(
              `A legacy idempotency result conflicts with ${method}; automatic replay is disabled`,
            );
          }
          database.run(
            "INSERT INTO durable_mutation_claims (key, method, request_fingerprint, result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
            [key, method, fingerprint, JSON.stringify(value), now, now],
          );
          writeLegacyIdempotencyMirror(database, key, value);
          return { kind: "result" as const, value };
        }
      } finally {
        legacy.free();
      }
      database.run(
        "INSERT INTO durable_mutation_claims (key, method, request_fingerprint, result_json, created_at, completed_at) VALUES (?, ?, ?, NULL, ?, NULL)",
        [key, method, fingerprint, now],
      );
      writeLegacyIdempotencyMirror(
        database,
        key,
        indeterminateMutationResult(
          `A ${method} operation is in progress or reached an indeterminate outcome; automatic replay is disabled`,
        ),
      );
      return { kind: "execute" as const };
    });
    if (claim.kind === "result") return claim.value;

    const claimExists = await this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT 1 FROM durable_mutation_claims WHERE key = ? AND method = ? AND request_fingerprint = ? AND result_json IS NULL",
      );
      try {
        statement.bind([key, method, fingerprint]);
        return statement.step();
      } finally {
        statement.free();
      }
    });
    if (!claimExists) {
      throw new Error(
        `Durable ${method} claim was not published before execution`,
      );
    }
    const captured = await captureDurableMutationResult(identity, operation);
    try {
      await this.#state.transaction((database) => {
        database.run(
          "UPDATE durable_mutation_claims SET result_json = ?, completed_at = ? WHERE key = ? AND method = ? AND request_fingerprint = ? AND result_json IS NULL",
          [
            JSON.stringify(captured.persisted),
            new Date().toISOString(),
            key,
            method,
            fingerprint,
          ],
        );
        if (database.getRowsModified() !== 1) {
          throw new Error(`Durable ${method} claim changed while saving`);
        }
        writeLegacyIdempotencyMirror(database, key, captured.persisted);
      });
      return captured.returned;
    } catch {
      // The operation has already run, so even failure to commit a verified
      // response cannot be reported as a definitive request failure.
      const indeterminate = indeterminateMutationResult(
        `The claimed ${method} result could not be committed durably; automatic replay is disabled`,
      );
      try {
        await this.#state.transaction((database) => {
          database.run(
            "UPDATE durable_mutation_claims SET result_json = ?, completed_at = ? WHERE key = ? AND method = ? AND request_fingerprint = ?",
            [
              JSON.stringify(indeterminate),
              new Date().toISOString(),
              key,
              method,
              fingerprint,
            ],
          );
          writeLegacyIdempotencyMirror(database, key, indeterminate);
        });
      } catch {
        // Best effort only: the NULL claim and permanent legacy mirror were
        // already published before execution. If even this repair cannot be
        // committed, both still prevent every automatic replay.
      }
      return indeterminate;
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

function inFlightFor(state: HostStateStore): Map<string, InFlightEntry> {
  const existing = inFlightByState.get(state);
  if (existing) return existing;
  const created = new Map<string, InFlightEntry>();
  inFlightByState.set(state, created);
  return created;
}

function digestKey(deviceId: string, key: string): string {
  return createHash("sha256")
    .update("ce-idempotency-v1\0")
    .update(deviceId)
    .update("\0")
    .update(key)
    .digest("base64url");
}

function requestFingerprint(
  request: Pick<RequestEnvelope, "method" | "payload">,
): string {
  return createHash("sha256")
    .update("ce-ephemeral-idempotency-v1\0")
    .update(request.method)
    .update("\0")
    .update(JSON.stringify(request.payload))
    .digest("base64url");
}

function durableMutationIdentity(
  claim: DurableMutationClaim,
): DurableMutationIdentity {
  const payload =
    claim.payload && typeof claim.payload === "object"
      ? (claim.payload as Record<string, unknown>)
      : undefined;
  return {
    method: claim.method,
    threadId:
      claim.method === "thread/start"
        ? null
        : safeIdentityString(payload?.threadId),
    clientUserMessageId:
      claim.method === "thread/start"
        ? null
        : safeIdentityString(payload?.clientUserMessageId),
  };
}

function durableMutationFingerprint(identity: DurableMutationIdentity): string {
  // Never fingerprint message input or file content. Durable fingerprints are
  // permanent, so hashing arbitrary payloads would create an offline oracle
  // for low-entropy prompts. The random per-device idempotency key is the
  // primary identity; these non-content fields only detect obvious key reuse.
  return createHash("sha256")
    .update("ce-durable-idempotency-v2\0")
    .update(JSON.stringify(identity))
    .digest("base64url");
}

function safeIdentityString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
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

type CapturedDurableMutationResult = {
  returned: IdempotentResult;
  persisted: IdempotentResult;
};

async function captureDurableMutationResult(
  identity: DurableMutationIdentity,
  operation: () => Promise<unknown>,
): Promise<CapturedDurableMutationResult> {
  const { method } = identity;
  try {
    const parsed = parseDurableMutationResult(identity, {
      ok: true,
      result: await operation(),
    });
    if (!parsed) {
      const indeterminate = indeterminateMutationResult(
        `The claimed ${method} operation returned an unverifiable result; automatic replay is disabled`,
      );
      return { returned: indeterminate, persisted: indeterminate };
    }
    if (!parsed.ok) return { returned: parsed, persisted: parsed };
    return {
      returned: parsed,
      persisted:
        method === "thread/start"
          ? parsed
          : indeterminateMutationResult(
              `The claimed ${method} operation completed, but replay of its content-bearing response is disabled; reconcile by clientUserMessageId`,
            ),
    };
  } catch {
    // The handler boundary can include an app-server mutation followed by
    // local persistence. A rejection cannot prove that the side effect did
    // not already happen, so every post-claim rejection fails closed.
    const indeterminate = indeterminateMutationResult(
      `The claimed ${method} operation did not produce a verifiable success; automatic replay is disabled`,
    );
    return { returned: indeterminate, persisted: indeterminate };
  }
}

function requestFailure(
  message: string,
  code = "REQUEST_FAILED",
): IdempotentResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function indeterminateMutationResult(message: string): IdempotentResult {
  return {
    ok: false,
    error: {
      code: IDEMPOTENCY_OUTCOME_INDETERMINATE,
      message,
      retryable: false,
    },
  };
}

function writeLegacyIdempotencyMirror(
  database: import("sql.js").Database,
  key: string,
  value: IdempotentResult,
): void {
  database.run(
    "INSERT OR REPLACE INTO idempotency_keys (key, result_json, expires_at) VALUES (?, ?, ?)",
    [key, JSON.stringify(value), PERMANENT_IDEMPOTENCY_EXPIRY],
  );
}

function durableReplayResult(
  method: DurableMutationMethod,
  value: IdempotentResult,
): IdempotentResult {
  if (!value.ok || method === "thread/start") return value;
  return indeterminateMutationResult(
    `A previous ${method} completed, but replay of its content-bearing response is disabled; reconcile by clientUserMessageId`,
  );
}

function parseDurableMutationResult(
  identity: DurableMutationIdentity,
  value: unknown,
): IdempotentResult | undefined {
  const { method } = identity;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    if (!Object.hasOwn(record, "result")) return undefined;
    const result = record.result;
    if (!result || typeof result !== "object") return undefined;
    if (!isVerifiableMutationSuccess(identity, result)) return undefined;
    return { ok: true, result };
  }
  if (record.ok !== false || !record.error || typeof record.error !== "object")
    return undefined;
  const error = record.error as Record<string, unknown>;
  if (
    error.code !== IDEMPOTENCY_OUTCOME_INDETERMINATE ||
    typeof error.message !== "string" ||
    error.retryable !== false
  ) {
    return undefined;
  }
  return {
    ok: false,
    error: {
      code: IDEMPOTENCY_OUTCOME_INDETERMINATE,
      message: error.message,
      retryable: false,
    },
  };
}

function isVerifiableMutationSuccess(
  identity: DurableMutationIdentity,
  result: object,
): boolean {
  const { method } = identity;
  const record = result as Record<string, unknown>;
  if (method === "queue/add") {
    const turnPayload =
      record.turnPayload && typeof record.turnPayload === "object"
        ? (record.turnPayload as Record<string, unknown>)
        : undefined;
    return (
      identity.threadId !== null &&
      identity.clientUserMessageId !== null &&
      safeIdentityString(record.id) !== null &&
      record.threadId === identity.threadId &&
      turnPayload?.clientUserMessageId === identity.clientUserMessageId &&
      record.status === "pending"
    );
  }
  if (
    method === "turn/start" &&
    (identity.threadId === null || identity.clientUserMessageId === null)
  ) {
    return false;
  }
  const entity = record[method === "thread/start" ? "thread" : "turn"];
  return (
    entity !== null &&
    typeof entity === "object" &&
    safeIdentityString((entity as Record<string, unknown>).id) !== null
  );
}
