import type { Database } from "sql.js";

import {
  jsonValueSchema,
  type GatewayErrorPayload,
  type JsonValue,
  type MutationStatus,
} from "@codex-everywhere/protocol/v2";
import { nullableText, queryRows, text } from "./snapshot-sql.js";
import type { SqliteStateFile } from "./sqlite-state-file.js";

export type StoredMutationOutcome =
  | {
      readonly version: 1;
      readonly kind: "success";
      readonly result: JsonValue;
    }
  | {
      readonly version: 1;
      readonly kind: "error";
      readonly error: GatewayErrorPayload;
    };

export type MutationClaim =
  | { readonly kind: "execute" }
  | { readonly kind: "pending"; readonly startedAt: string }
  | { readonly kind: "completed"; readonly outcome: StoredMutationOutcome }
  | { readonly kind: "indeterminate"; readonly updatedAt: string };

export interface MutationClaimInput {
  readonly operationKey: string;
  readonly method: string;
  readonly requestFingerprint: string;
  readonly now: string;
}

export class MutationReceiptConflictError extends Error {
  constructor(readonly operationKey: string) {
    super("Operation key was reused for a different mutation");
    this.name = "MutationReceiptConflictError";
  }
}

/** Atomic, durable claim/result storage shared by user and admin databases. */
export class MutationReceiptRepository {
  readonly #file: SqliteStateFile;

  constructor(file: SqliteStateFile) {
    this.#file = file;
  }

  claim(input: MutationClaimInput): Promise<MutationClaim> {
    return this.#file.transaction((database) => {
      pruneExpired(database, input.now);
      const row = readReceipt(database, input.operationKey);
      if (row !== undefined) {
        if (
          row.method !== input.method ||
          row.requestFingerprint !== input.requestFingerprint
        ) {
          throw new MutationReceiptConflictError(input.operationKey);
        }
        if (row.status === "pending") {
          return { kind: "pending", startedAt: row.createdAt };
        }
        if (row.status === "indeterminate") {
          return { kind: "indeterminate", updatedAt: row.updatedAt };
        }
        if (row.resultJson === undefined) {
          throw new Error("Completed mutation receipt has no result");
        }
        return {
          kind: "completed",
          outcome: parseStoredMutationOutcome(row.resultJson),
        };
      }

      database.run(
        "INSERT INTO mutation_receipts (operation_key, method, request_fingerprint, status, result_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)",
        [
          input.operationKey,
          input.method,
          input.requestFingerprint,
          input.now,
          input.now,
        ],
      );
      return { kind: "execute" };
    });
  }

  complete(input: {
    readonly operationKey: string;
    readonly method: string;
    readonly requestFingerprint: string;
    readonly outcome: StoredMutationOutcome;
    readonly now: string;
    readonly expiresAt: string;
  }): Promise<void> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE mutation_receipts SET status = 'completed', result_json = ?, updated_at = ?, expires_at = ? WHERE operation_key = ? AND method = ? AND request_fingerprint = ? AND status = 'pending'",
        [
          JSON.stringify(input.outcome),
          input.now,
          input.expiresAt,
          input.operationKey,
          input.method,
          input.requestFingerprint,
        ],
      );
      if (database.getRowsModified() !== 1) {
        throw new Error("Mutation receipt changed before completion");
      }
    });
  }

  markIndeterminate(input: {
    readonly operationKey: string;
    readonly method: string;
    readonly requestFingerprint: string;
    readonly now: string;
  }): Promise<void> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE mutation_receipts SET status = 'indeterminate', result_json = NULL, updated_at = ?, expires_at = NULL WHERE operation_key = ? AND method = ? AND request_fingerprint = ? AND status = 'pending'",
        [input.now, input.operationKey, input.method, input.requestFingerprint],
      );
      if (database.getRowsModified() > 1) {
        throw new Error("Mutation receipt uniqueness invariant failed");
      }
    });
  }

  /** Converts crash-left claims before accepting any new Gateway traffic. */
  recoverPending(now = new Date().toISOString()): Promise<number> {
    return this.#file.transaction((database) => {
      database.run(
        "UPDATE mutation_receipts SET status = 'indeterminate', updated_at = ?, expires_at = NULL WHERE status = 'pending'",
        [now],
      );
      return database.getRowsModified();
    });
  }

  status(
    operationKey: string,
    now = new Date().toISOString(),
  ): Promise<MutationStatus> {
    return this.#file.transaction((database) => {
      pruneExpired(database, now);
      const row = readReceipt(database, operationKey);
      if (row === undefined) return { version: 1, status: "missing" };
      if (row.status === "pending") {
        return {
          version: 1,
          status: "pending",
          method: row.method,
          startedAt: row.createdAt,
        };
      }
      if (row.status === "indeterminate") {
        return {
          version: 1,
          status: "indeterminate",
          method: row.method,
          updatedAt: row.updatedAt,
          reason: "The Agent cannot prove whether the mutation completed",
        };
      }
      if (row.resultJson === undefined) {
        throw new Error("Completed mutation receipt has no result");
      }
      const outcome = parseStoredMutationOutcome(row.resultJson);
      return {
        version: 1,
        status: "completed",
        method: row.method,
        completedAt: row.updatedAt,
        outcome,
      };
    });
  }
}

interface ReceiptRow {
  readonly method: string;
  readonly requestFingerprint?: string;
  readonly status: "pending" | "completed" | "indeterminate";
  readonly resultJson?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function readReceipt(
  database: Database,
  operationKey: string,
): ReceiptRow | undefined {
  const row = queryRows(
    database,
    "SELECT method, request_fingerprint, status, result_json, created_at, updated_at FROM mutation_receipts WHERE operation_key = ?",
    [operationKey],
  )[0];
  if (row === undefined) return undefined;
  const status = text(row.status, "mutation status");
  if (
    status !== "pending" &&
    status !== "completed" &&
    status !== "indeterminate"
  ) {
    throw new Error("Invalid mutation receipt status");
  }
  const requestFingerprint = nullableText(
    row.request_fingerprint,
    "mutation fingerprint",
  );
  const resultJson = nullableText(row.result_json, "mutation result");
  return {
    method: text(row.method, "mutation method"),
    ...(requestFingerprint === undefined ? {} : { requestFingerprint }),
    status,
    ...(resultJson === undefined ? {} : { resultJson }),
    createdAt: text(row.created_at, "mutation created_at"),
    updatedAt: text(row.updated_at, "mutation updated_at"),
  };
}

function pruneExpired(database: Database, now: string): void {
  database.run(
    "DELETE FROM mutation_receipts WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at <= ?",
    [now],
  );
}

function parseStoredMutationOutcome(value: string): StoredMutationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Mutation receipt result is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error("Mutation receipt result has an unsupported version");
  }
  if (parsed.kind === "success" && isJsonValue(parsed.result)) {
    return { version: 1, kind: "success", result: parsed.result };
  }
  if (parsed.kind === "error" && isGatewayError(parsed.error)) {
    return { version: 1, kind: "error", error: parsed.error };
  }
  throw new Error("Mutation receipt result has an invalid shape");
}

function isGatewayError(value: unknown): value is GatewayErrorPayload {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.retryable === undefined || typeof value.retryable === "boolean") &&
    (value.details === undefined || isRecord(value.details))
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
