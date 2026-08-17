import { createHash } from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayV2Error,
  gatewayMethodDefinitions,
  jsonValueSchema,
  type GatewayMutationMiddleware,
  type MutationInvocation,
  type MutationStatus,
} from "@codex-everywhere/protocol/v2";

import {
  MutationReceiptConflictError,
  type MutationReceiptRepository,
  type StoredMutationOutcome,
} from "../repositories/mutation-receipt-repository.js";

const DURABLE_RESULT_TTL_MS = 24 * 60 * 60_000;
const EPHEMERAL_RESULT_TTL_MS = 5 * 60_000;
const DEFAULT_EPHEMERAL_LIMIT = 128;

export type MutationReceiptResolver = (
  principalId: string,
) => MutationReceiptRepository;

interface InFlightEntry {
  readonly fingerprint: string;
  readonly promise: Promise<unknown>;
}

interface EphemeralEntry {
  readonly fingerprint: string;
  readonly promise: Promise<StoredMutationOutcome>;
  expiresAt?: number;
}

/** One mutation boundary for every v2 handler, including crash reconciliation. */
export class AgentMutationMiddleware implements GatewayMutationMiddleware {
  readonly #scope: Scope;
  readonly #resolveRepository: MutationReceiptResolver;
  readonly #inFlight = new Map<string, InFlightEntry>();
  readonly #ephemeral = new Map<string, EphemeralEntry>();
  readonly #ephemeralLimit: number;

  constructor(input: {
    readonly scope: Scope;
    readonly resolveRepository: MutationReceiptResolver;
    readonly ephemeralLimit?: number;
  }) {
    this.#scope = input.scope.fork("mutation-middleware");
    this.#resolveRepository = input.resolveRepository;
    this.#ephemeralLimit = input.ephemeralLimit ?? DEFAULT_EPHEMERAL_LIMIT;
    if (
      !Number.isSafeInteger(this.#ephemeralLimit) ||
      this.#ephemeralLimit < 1
    ) {
      throw new Error("Ephemeral mutation limit must be positive");
    }
    this.#scope.defer(() => {
      this.#ephemeral.clear();
      this.#inFlight.clear();
    });
  }

  run<Result>(
    invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    this.#scope.throwIfClosed();
    if (
      gatewayMethodDefinitions[invocation.method].idempotency !==
      invocation.idempotency
    ) {
      return Promise.reject(
        new GatewayV2Error(
          "INTERNAL_PROTOCOL_ERROR",
          "Mutation idempotency metadata does not match the method registry",
        ),
      );
    }
    return invocation.idempotency === "ephemeral"
      ? this.#runEphemeral(invocation, execute)
      : this.#runDurable(invocation, execute);
  }

  status(principalId: string, operationKey: string): Promise<MutationStatus> {
    return this.#resolveRepository(principalId).status(operationKey);
  }

  async recoverPending(principalIds: readonly string[]): Promise<number> {
    let recovered = 0;
    for (const principalId of new Set(principalIds)) {
      recovered += await this.#resolveRepository(principalId).recoverPending();
    }
    return recovered;
  }

  async #runEphemeral<Result>(
    invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    // One Agent root belongs to one Unix user (or the isolated admin domain),
    // so a UUID operation key can safely bridge physical pre-auth sessions.
    // This is required to recover a secret-bearing final authentication
    // response without writing that response to SQLite.
    const key = `ephemeral\0${invocation.operationKey}`;
    const fingerprint = ephemeralFingerprint(invocation);
    const now = Date.now();
    let existing = this.#ephemeral.get(key);
    if (existing?.expiresAt !== undefined && existing.expiresAt <= now) {
      this.#ephemeral.delete(key);
      existing = undefined;
    }
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw keyReuseError();
      this.#touchEphemeral(key, existing);
      return unwrapOutcome<Result>(await existing.promise);
    }

    while (this.#ephemeral.size >= this.#ephemeralLimit) {
      const oldest = this.#ephemeral.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#ephemeral.delete(oldest);
    }
    const entry: EphemeralEntry = {
      fingerprint,
      promise: captureOutcome(execute),
    };
    this.#ephemeral.set(key, entry);
    const outcome = await entry.promise;
    if (this.#ephemeral.get(key) === entry) {
      entry.expiresAt = Date.now() + EPHEMERAL_RESULT_TTL_MS;
      this.#touchEphemeral(key, entry);
    }
    return unwrapOutcome<Result>(outcome);
  }

  #runDurable<Result>(
    invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const key = durableInvocationIdentity(invocation);
    const fingerprint = durableFingerprint(invocation);
    const existing = this.#inFlight.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(keyReuseError());
      }
      return existing.promise as Promise<Result>;
    }

    const promise = this.#executeDurable(
      invocation,
      fingerprint,
      execute,
    ).finally(() => {
      if (this.#inFlight.get(key)?.promise === promise) {
        this.#inFlight.delete(key);
      }
    });
    this.#inFlight.set(key, { fingerprint, promise });
    return promise;
  }

  async #executeDurable<Result>(
    invocation: MutationInvocation,
    fingerprint: string,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const repository = this.#resolveRepository(invocation.principalId);
    let claim;
    try {
      claim = await repository.claim({
        operationKey: invocation.operationKey,
        method: invocation.method,
        requestFingerprint: fingerprint,
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof MutationReceiptConflictError) throw keyReuseError();
      throw error;
    }

    if (claim.kind === "completed") {
      return unwrapOutcome<Result>(claim.outcome);
    }
    if (claim.kind === "pending") {
      throw new GatewayV2Error(
        "MUTATION_PENDING",
        "The mutation is still pending; query mutation/status",
        { retryable: true },
      );
    }
    if (claim.kind === "indeterminate") throw outcomeUnknownError();

    let outcome: StoredMutationOutcome;
    try {
      outcome = await captureOutcome(execute);
    } catch {
      // captureOutcome is deliberately total; this is a defensive fail-close.
      await bestEffortIndeterminate(repository, invocation, fingerprint);
      throw outcomeUnknownError();
    }

    if (outcome.kind === "error" && outcome.error.code === "INTERNAL_ERROR") {
      await bestEffortIndeterminate(repository, invocation, fingerprint);
      throw outcomeUnknownError();
    }

    const now = new Date();
    try {
      await repository.complete({
        operationKey: invocation.operationKey,
        method: invocation.method,
        requestFingerprint: fingerprint,
        outcome,
        now: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + DURABLE_RESULT_TTL_MS,
        ).toISOString(),
      });
    } catch {
      await bestEffortIndeterminate(repository, invocation, fingerprint);
      throw outcomeUnknownError();
    }
    return unwrapOutcome<Result>(outcome);
  }

  #touchEphemeral(key: string, entry: EphemeralEntry): void {
    this.#ephemeral.delete(key);
    this.#ephemeral.set(key, entry);
  }
}

async function captureOutcome<Result>(
  execute: () => Promise<Result>,
): Promise<StoredMutationOutcome> {
  try {
    const result = jsonValueSchema.parse(await execute());
    return { version: 1, kind: "success", result };
  } catch (error) {
    const gatewayError =
      error instanceof GatewayV2Error
        ? error
        : new GatewayV2Error(
            "INTERNAL_ERROR",
            "Gateway mutation could not be completed",
          );
    return { version: 1, kind: "error", error: gatewayError.toPayload() };
  }
}

function unwrapOutcome<Result>(outcome: StoredMutationOutcome): Result {
  if (outcome.kind === "success") return outcome.result as Result;
  throw new GatewayV2Error(outcome.error.code, outcome.error.message, {
    ...(outcome.error.retryable === undefined
      ? {}
      : { retryable: outcome.error.retryable }),
    ...(outcome.error.details === undefined
      ? {}
      : { details: outcome.error.details }),
  });
}

async function bestEffortIndeterminate(
  repository: MutationReceiptRepository,
  invocation: MutationInvocation,
  fingerprint: string,
): Promise<void> {
  try {
    await repository.markIndeterminate({
      operationKey: invocation.operationKey,
      method: invocation.method,
      requestFingerprint: fingerprint,
      now: new Date().toISOString(),
    });
  } catch {
    // The durable pending claim already prevents automatic replay.
  }
}

function keyReuseError(): GatewayV2Error {
  return new GatewayV2Error(
    "OPERATION_KEY_REUSED",
    "Operation key was reused for a different mutation",
    { closeConnection: true },
  );
}

function outcomeUnknownError(): GatewayV2Error {
  return new GatewayV2Error(
    "MUTATION_OUTCOME_UNKNOWN",
    "The mutation outcome is unknown; query mutation/status before retrying",
  );
}

function durableInvocationIdentity(invocation: MutationInvocation): string {
  return `${invocation.principalId}\0${invocation.operationKey}`;
}

function ephemeralFingerprint(invocation: MutationInvocation): string {
  return digest("ce-v4-ephemeral-mutation\0", {
    method: invocation.method,
    input: invocation.input,
  });
}

function durableFingerprint(invocation: MutationInvocation): string {
  return digest("ce-v4-durable-mutation\0", {
    method: invocation.method,
    // The input is already schema validated by GatewayV2Router. Hashing the
    // complete canonical value binds an operation key to its exact semantic
    // request without persisting prompts, paths, credentials, or Queue text.
    input: invocation.input,
  });
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update(canonicalJson(value))
    .digest("base64url");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
