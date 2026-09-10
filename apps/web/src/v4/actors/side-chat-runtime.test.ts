import { Scope } from "@codex-everywhere/kernel";
import {
  MutationOutcomeUnknownError,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioGateway } from "../gateway/scenario-gateway.js";
import { composerDraftFor } from "./composer-actor.js";
import { SideChatRuntime } from "./side-chat-runtime.js";
const scopes: Scope[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await scope.close("test-complete");
});

function setup(gateway = new ScenarioGateway()) {
  const scope = new Scope("side-runtime-test");
  scopes.push(scope);
  scope.defer(() => gateway.close());
  return { runtime: new SideChatRuntime(scope, gateway), gateway, scope };
}

describe("side chat lifecycle", () => {
  it("keeps a hidden side and its draft, appends another question, and reopens from authoritative metadata", async () => {
    const { runtime, gateway, scope } = setup();
    runtime.select("thread-welcome");
    await vi.waitFor(() =>
      expect(runtime.actor.getSnapshot().status).toBe("idle"),
    );
    runtime.show("Explain the context");
    await vi.waitFor(() =>
      expect(
        runtime.thread
          .getSnapshot()
          .snapshot?.items.some((item) => item.data.role === "assistant"),
      ).toBe(true),
    );
    const id = runtime.actor.getSnapshot().side!.threadId!;
    runtime.composer.dispatch({
      type: "DRAFT",
      threadId: id,
      value: "keep this draft",
    });
    runtime.actor.dispatch({ type: "HIDE" });
    expect(runtime.actor.getSnapshot().side?.threadId).toBe(id);
    runtime.show("another question");
    expect(composerDraftFor(runtime.composer.getSnapshot(), id)).toBe(
      "keep this draft\n\nanother question",
    );
    await runtime.scope.close("device-disconnected");
    const second = new SideChatRuntime(scope, gateway);
    second.select("thread-welcome");
    await vi.waitFor(() =>
      expect(second.actor.getSnapshot().side?.threadId).toBe(id),
    );
    expect(second.actor.getSnapshot().visible).toBe(false);
    second.show();
    await vi.waitFor(() =>
      expect(
        second.thread
          .getSnapshot()
          .snapshot?.items.some((item) => item.data.role === "assistant"),
      ).toBe(true),
    );
    second.actor.dispatch({ type: "DELETE" });
    await vi.waitFor(() => expect(second.actor.getSnapshot().side).toBeNull());
    expect(second.thread.getSnapshot().threadId).toBeUndefined();
  });

  it("keeps tracking a lost create response while hidden and reconciles the same operation once", async () => {
    const gateway = new LostCreateGateway();
    const { runtime } = setup(gateway);
    runtime.select("thread-welcome");
    await vi.waitFor(() =>
      expect(runtime.actor.getSnapshot().status).toBe("idle"),
    );
    runtime.show();
    runtime.actor.dispatch({ type: "HIDE" });
    runtime.actor.dispatch({ type: "RELOAD" });
    runtime.select("another-parent");
    expect(runtime.actor.getSnapshot().parentThreadId).toBe("thread-welcome");
    await vi.waitFor(() =>
      expect(runtime.actor.getSnapshot().side?.status).toBe("ready"),
    );
    expect(runtime.actor.getSnapshot().visible).toBe(false);
    expect(gateway.starts).toBe(1);
  });
});

class LostCreateGateway extends ScenarioGateway {
  starts = 0;
  override async request<M extends GatewayMethodName>(
    method: M,
    input: InputOf<M>,
    options: RequestOptionsOf<M>,
  ): Promise<OutputOf<M>> {
    const result = await super.request(method, input, options);
    if (method === "side/start") {
      this.starts += 1;
      throw new MutationOutcomeUnknownError(
        "side/start",
        "operationKey" in options ? String(options.operationKey) : "missing",
      );
    }
    return result;
  }
}
