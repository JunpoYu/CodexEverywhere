import type {
  GatewayMutationMiddleware,
  MutationInvocation,
} from "@codex-everywhere/protocol/v2";

import type { AdminRepository } from "../repositories/admin-repository.js";
import type { AgentMutationMiddleware } from "./mutation-middleware.js";

/** Adds one redacted audit record around each non-replayed admin mutation. */
export class AdminMutationMiddleware implements GatewayMutationMiddleware {
  readonly #inner: AgentMutationMiddleware;
  readonly #repository: AdminRepository;

  constructor(input: {
    readonly inner: AgentMutationMiddleware;
    readonly repository: AdminRepository;
  }) {
    this.#inner = input.inner;
    this.#repository = input.repository;
  }

  run<Result>(
    invocation: MutationInvocation,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    return this.#inner.run(invocation, async () => {
      if (!invocation.method.startsWith("admin/")) return execute();
      const targetUsername = safeTargetUsername(invocation.input);
      try {
        const result = await execute();
        await this.#repository.appendAudit({
          requestId: invocation.requestId,
          actor: invocation.principalId,
          action: invocation.method,
          ...(targetUsername === undefined ? {} : { targetUsername }),
          result: "succeeded",
        });
        return result;
      } catch (error) {
        await this.#repository.appendAudit({
          requestId: invocation.requestId,
          actor: invocation.principalId,
          action: invocation.method,
          ...(targetUsername === undefined ? {} : { targetUsername }),
          result: "failed",
        });
        throw error;
      }
    });
  }

  status(principalId: string, operationKey: string) {
    return this.#inner.status(principalId, operationKey);
  }
}

function safeTargetUsername(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const username = (input as Record<string, unknown>).username;
  return typeof username === "string" &&
    /^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/u.test(username)
    ? username
    : undefined;
}
