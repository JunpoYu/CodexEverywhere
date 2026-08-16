import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayRemoteError,
  MutationOutcomeUnknownError,
  gatewayMethodDefinitions,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";

import {
  mutationOptions,
  queryOptions,
  type GatewayPort,
} from "./gateway-port.js";

type DurableMethodName = {
  [
    Method in GatewayMethodName
  ]: (typeof gatewayMethodDefinitions)[Method]["idempotency"] extends "durable"
    ? Method
    : never;
}[GatewayMethodName];

export class MutationNeedsReviewError extends Error {
  constructor(
    readonly operationKey: string,
    message: string,
  ) {
    super(message);
    this.name = "MutationNeedsReviewError";
  }
}

/** Executes one durable mutation and resolves its authoritative receipt after transport loss. */
export async function durableMutation<Method extends DurableMethodName>(input: {
  readonly owner: Scope;
  readonly gateway: GatewayPort;
  readonly method: Method;
  readonly payload: InputOf<Method>;
  readonly operationKey?: string;
  readonly onOutcomeUnknown?: (operationKey: string) => void;
}): Promise<OutputOf<Method>> {
  const operationKey = input.operationKey ?? crypto.randomUUID();
  const scope = input.owner.fork(`mutation-${input.method}-${operationKey}`);
  try {
    try {
      return await input.gateway.request(
        input.method,
        input.payload,
        mutationOptions(operationKey, scope.signal) as RequestOptionsOf<Method>,
      );
    } catch (error) {
      if (!(error instanceof MutationOutcomeUnknownError)) throw error;
      input.onOutcomeUnknown?.(operationKey);
    }

    let transientFailures = 0;
    for (;;) {
      scope.throwIfClosed();
      try {
        const status = await input.gateway.request(
          "mutation/status",
          { version: 1, operationKey },
          queryOptions(scope.signal),
        );
        transientFailures = 0;
        if (status.status === "completed") {
          if (status.outcome.kind === "error") {
            throw new GatewayRemoteError(status.outcome.error);
          }
          const parsed = gatewayMethodDefinitions[
            input.method
          ].output.safeParse(status.outcome.result);
          if (!parsed.success) {
            throw new MutationNeedsReviewError(
              operationKey,
              "宿主机已完成操作，但返回的对账结果无效，请人工检查。",
            );
          }
          return parsed.data as OutputOf<Method>;
        }
        if (status.status === "missing" || status.status === "indeterminate") {
          throw new MutationNeedsReviewError(
            operationKey,
            status.status === "indeterminate"
              ? "宿主机无法确认操作是否完成，请人工检查后再继续。"
              : "宿主机没有找到操作记录，请人工检查后再继续。",
          );
        }
      } catch (error) {
        if (
          error instanceof MutationNeedsReviewError ||
          error instanceof GatewayRemoteError
        ) {
          throw error;
        }
        if (scope.signal.aborted) throw error;
        transientFailures += 1;
        if (transientFailures >= 120) {
          throw new MutationNeedsReviewError(
            operationKey,
            "重连后仍无法读取操作状态，请人工检查后再继续。",
          );
        }
      }
      await scopedDelay(scope, 1_000);
    }
  } finally {
    await scope.close("durable-mutation-finished");
  }
}

function scopedDelay(scope: Scope, delayMs: number): Promise<void> {
  const delayScope = scope.fork("reconcile-delay");
  return new Promise((resolve, reject) => {
    const aborted = () => {
      reject(scope.signal.reason ?? new DOMException("Aborted", "AbortError"));
      void delayScope.close("mutation-delay-aborted");
    };
    scope.signal.addEventListener("abort", aborted, { once: true });
    delayScope.defer(() => scope.signal.removeEventListener("abort", aborted));
    delayScope.setTimeout(() => {
      resolve();
      void delayScope.close("mutation-delay-complete");
    }, delayMs);
  });
}
