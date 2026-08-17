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

import type { GatewayPort } from "../gateway/gateway-port.js";
import { createComposerActor } from "./composer-actor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
});

describe("v0.4 composer actor", () => {
  it("reconciles an unknown mutation through mutation/status", async () => {
    const gateway = new UnknownThenCompletedGateway();
    const scope = new Scope("composer-test");
    scopes.push(scope);
    const actor = createComposerActor(scope, gateway);

    actor.dispatch({ type: "DRAFT", value: "do the work" });
    actor.dispatch({ type: "SUBMIT", threadId: "thread-1" });

    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("idle"));
    expect(gateway.methods).toEqual(["turn/start", "mutation/status"]);
    expect(gateway.operationKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("restores the draft after a definitive receipt error", async () => {
    const gateway = new UnknownThenCompletedGateway("error");
    const scope = new Scope("composer-error-test");
    scopes.push(scope);
    const actor = createComposerActor(scope, gateway);

    actor.dispatch({ type: "DRAFT", value: "keep this prompt" });
    actor.dispatch({ type: "SUBMIT", threadId: "thread-1" });

    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("idle"));
    expect(actor.getSnapshot()).toMatchObject({
      draft: "keep this prompt",
      error: "Task is not idle",
    });
  });

  it("requires explicit acknowledgement before restoring an unknown draft", async () => {
    const gateway = new UnknownThenCompletedGateway("indeterminate");
    const scope = new Scope("composer-review-test");
    scopes.push(scope);
    const actor = createComposerActor(scope, gateway);

    actor.dispatch({ type: "DRAFT", value: "review this prompt" });
    actor.dispatch({ type: "SUBMIT", threadId: "thread-1" });
    await vi.waitFor(() =>
      expect(actor.getSnapshot().status).toBe("manual-review"),
    );
    expect(actor.getSnapshot().draft).toBe("");

    actor.dispatch({ type: "ACKNOWLEDGE_MANUAL" });
    expect(actor.getSnapshot()).toMatchObject({
      status: "idle",
      draft: "review this prompt",
    });
  });

  it("does not cancel an in-flight send when the next draft is edited", async () => {
    const gateway = new DelayedSuccessGateway();
    const scope = new Scope("composer-draft-test");
    scopes.push(scope);
    const actor = createComposerActor(scope, gateway);

    actor.dispatch({ type: "DRAFT", value: "send this" });
    actor.dispatch({ type: "SUBMIT", threadId: "thread-1" });
    actor.dispatch({ type: "DRAFT", value: "prepare this next" });

    expect(gateway.signal?.aborted).toBe(false);
    gateway.resolve();
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("idle"));
    expect(actor.getSnapshot().draft).toBe("prepare this next");
  });

  it("clears a draft only after Queue accepts it", async () => {
    const gateway = new ImmediateQueueGateway();
    const scope = new Scope("composer-queue-test");
    scopes.push(scope);
    const actor = createComposerActor(scope, gateway);

    actor.dispatch({ type: "DRAFT", value: "follow-up work" });
    actor.dispatch({ type: "QUEUE", threadId: "thread-1" });

    expect(actor.getSnapshot().status).toBe("submitting");
    await vi.waitFor(() => expect(actor.getSnapshot().status).toBe("idle"));
    expect(actor.getSnapshot().draft).toBe("");
    expect(gateway.queued).toEqual({
      version: 1,
      threadId: "thread-1",
      text: "follow-up work",
    });
  });
});

class ImmediateQueueGateway implements GatewayPort {
  queued: InputOf<"queue/add"> | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    input: InputOf<Method>,
    _options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "queue/add") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.queued = input as InputOf<"queue/add">;
    return Promise.resolve({
      version: 1,
      item: {
        version: 1,
        id: "queue-1",
        threadId: "thread-1",
        text: "follow-up work",
        status: "pending",
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
        revision: 1,
      },
    }) as Promise<OutputOf<Method>>;
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

class DelayedSuccessGateway implements GatewayPort {
  signal: AbortSignal | undefined;
  #resolve: (() => void) | undefined;

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "turn/start") {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.signal = options.signal;
    return new Promise<void>((resolve) => {
      this.#resolve = resolve;
    }).then(
      () =>
        ({
          version: 1,
          threadId: "thread-1",
          turnId: "turn-1",
        }) as OutputOf<Method>,
    );
  }

  resolve(): void {
    this.#resolve?.();
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

class UnknownThenCompletedGateway implements GatewayPort {
  readonly methods: string[] = [];
  operationKey = "";

  constructor(
    private readonly outcome: "success" | "error" | "indeterminate" = "success",
  ) {}

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    this.methods.push(method);
    if (method === "turn/start") {
      const operationKey = (options as RequestOptionsOf<"turn/start">)
        .operationKey;
      this.operationKey = operationKey;
      return Promise.reject(
        new MutationOutcomeUnknownError(method, operationKey),
      );
    }
    if (method === "mutation/status") {
      if (this.outcome === "indeterminate") {
        return Promise.resolve({
          version: 1,
          status: "indeterminate",
          method: "turn/start",
          updatedAt: "2026-08-16T00:00:00.000Z",
        }) as Promise<OutputOf<Method>>;
      }
      return Promise.resolve({
        version: 1,
        status: "completed",
        method: "turn/start",
        completedAt: "2026-08-16T00:00:00.000Z",
        outcome: {
          version: 1,
          ...(this.outcome === "success"
            ? {
                kind: "success" as const,
                result: {
                  version: 1,
                  threadId: "thread-1",
                  turnId: "turn-1",
                },
              }
            : {
                kind: "error" as const,
                error: {
                  code: "THREAD_NOT_IDLE",
                  message: "Task is not idle",
                },
              }),
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
