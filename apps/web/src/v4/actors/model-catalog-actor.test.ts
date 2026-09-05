import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayPort } from "../gateway/gateway-port.js";
import { createModelCatalogActor } from "./model-catalog-actor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
});

describe("model catalog actor", () => {
  it("loads all pages and de-duplicates models", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([model("gpt-a")], "next"))
      .mockResolvedValueOnce(page([model("gpt-a"), model("gpt-b")], undefined));
    const actor = createActor(request);

    actor.dispatch({ type: "LOAD" });
    await eventually(() => actor.getSnapshot().status === "ready");

    expect(actor.getSnapshot().models.map((item) => item.model)).toEqual([
      "gpt-a",
      "gpt-b",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous catalog when a refresh fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([model("gpt-a")], undefined))
      .mockRejectedValueOnce(new Error("offline"));
    const actor = createActor(request);
    actor.dispatch({ type: "LOAD" });
    await eventually(() => actor.getSnapshot().status === "ready");

    actor.dispatch({ type: "LOAD" });
    await eventually(() => actor.getSnapshot().status === "failed");

    expect(actor.getSnapshot()).toMatchObject({
      status: "failed",
      models: [{ model: "gpt-a" }],
      error: "offline",
    });
  });

  it("supersedes an in-flight catalog read when a newer refresh is requested", async () => {
    let resolveFirst!: (value: ReturnType<typeof page>) => void;
    const first = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(page([model("gpt-6-astra")], undefined));
    const actor = createActor(request);

    actor.dispatch({ type: "LOAD" });
    await eventually(() => request.mock.calls.length === 1);
    actor.dispatch({ type: "LOAD" });
    await eventually(() => actor.getSnapshot().status === "ready");

    expect(actor.getSnapshot().models.map((item) => item.model)).toEqual([
      "gpt-6-astra",
    ]);
    resolveFirst(page([model("stale-model")], undefined));
    await Promise.resolve();
    expect(actor.getSnapshot().models.map((item) => item.model)).toEqual([
      "gpt-6-astra",
    ]);
  });
});

function createActor(request: ReturnType<typeof vi.fn>) {
  const scope = new Scope("model-catalog-actor-test");
  scopes.push(scope);
  const gateway = {
    request,
  } as unknown as GatewayPort;
  return createModelCatalogActor(scope, gateway);
}

function model(name: string) {
  return {
    version: 1 as const,
    id: name,
    model: name,
    displayName: name,
    description: "",
    isDefault: name === "gpt-a",
    defaultEffort: "medium",
    supportedEfforts: [{ effort: "medium", description: "" }],
  };
}

function page(
  models: ReturnType<typeof model>[],
  nextCursor: string | undefined,
) {
  return {
    version: 1 as const,
    models,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore: nextCursor !== undefined,
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met");
}
