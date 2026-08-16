import { Scope } from "@codex-everywhere/kernel";
import {
  MutationOutcomeUnknownError,
  type GatewayEventEnvelopeV2,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  durableMutation,
  MutationNeedsReviewError,
} from "./durable-mutation.js";
import type { GatewayPort } from "./gateway-port.js";

const scopes: Scope[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
});

describe("durableMutation", () => {
  it("uses one operation key and returns a completed receipt after response loss", async () => {
    vi.useFakeTimers();
    const gateway = new ReceiptGateway(["pending", "completed"]);
    const scope = new Scope("durable-test");
    scopes.push(scope);
    const pending = durableMutation({
      owner: scope,
      gateway,
      method: "workspace/add",
      payload: { version: 1, path: "/public/project" },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({
      workspace: { path: "/public/project" },
    });
    expect(new Set(gateway.operationKeys).size).toBe(1);
    expect(gateway.statusCalls).toBe(2);
  });

  it("fails closed when the Agent cannot prove the outcome", async () => {
    const gateway = new ReceiptGateway(["indeterminate"]);
    const scope = new Scope("durable-review-test");
    scopes.push(scope);

    await expect(
      durableMutation({
        owner: scope,
        gateway,
        method: "workspace/add",
        payload: { version: 1, path: "/public/project" },
      }),
    ).rejects.toBeInstanceOf(MutationNeedsReviewError);
  });

  it("rethrows a definitive error stored in the completed receipt", async () => {
    const gateway = new ReceiptGateway(["failed"]);
    const scope = new Scope("durable-error-test");
    scopes.push(scope);

    await expect(
      durableMutation({
        owner: scope,
        gateway,
        method: "workspace/add",
        payload: { version: 1, path: "/public/project" },
      }),
    ).rejects.toMatchObject({
      name: "GatewayRemoteError",
      code: "REVISION_CONFLICT",
    });
  });
});

class ReceiptGateway implements GatewayPort {
  readonly operationKeys: string[] = [];
  statusCalls = 0;

  constructor(
    private readonly statuses: Array<
      "pending" | "completed" | "failed" | "indeterminate"
    >,
  ) {}

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method === "workspace/add") {
      const operationKey = (options as { operationKey: string }).operationKey;
      this.operationKeys.push(operationKey);
      return Promise.reject(
        new MutationOutcomeUnknownError(method, operationKey),
      );
    }
    if (method === "mutation/status") {
      this.statusCalls += 1;
      const status = this.statuses.shift() ?? "indeterminate";
      if (status === "pending") {
        return Promise.resolve({
          version: 1,
          status,
          method: "workspace/add",
          startedAt: "2026-01-01T00:00:00.000Z",
        }) as Promise<OutputOf<Method>>;
      }
      if (status === "indeterminate") {
        return Promise.resolve({
          version: 1,
          status,
          method: "workspace/add",
          updatedAt: "2026-01-01T00:00:01.000Z",
        }) as Promise<OutputOf<Method>>;
      }
      if (status === "failed") {
        return Promise.resolve({
          version: 1,
          status: "completed",
          method: "workspace/add",
          completedAt: "2026-01-01T00:00:01.000Z",
          outcome: {
            version: 1,
            kind: "error",
            error: {
              code: "REVISION_CONFLICT",
              message: "Workspace changed",
            },
          },
        }) as Promise<OutputOf<Method>>;
      }
      return Promise.resolve({
        version: 1,
        status,
        method: "workspace/add",
        completedAt: "2026-01-01T00:00:01.000Z",
        outcome: {
          version: 1,
          kind: "success",
          result: {
            version: 1,
            workspace: {
              version: 1,
              id: "workspace-1",
              path: "/public/project",
              label: "project",
              isDefault: true,
              revision: 1,
            },
          },
        },
      }) as Promise<OutputOf<Method>>;
    }
    return Promise.reject(new Error(`Unexpected method: ${method}`));
  }

  onEvent(_listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return () => undefined;
  }

  onConnectionLost(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {}
}
