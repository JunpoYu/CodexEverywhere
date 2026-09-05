import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayPort } from "../gateway/gateway-port.js";
import { createOnboardingActor } from "./onboarding-actor.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
});

describe("onboarding actor", () => {
  it("clears a historic install failure after a successful manual restart", () => {
    const scope = new Scope("onboarding-restart-test");
    scopes.push(scope);
    const actor = createOnboardingActor(scope, {} as GatewayPort);
    actor.dispatch({
      type: "INSTALL_PROGRESS",
      progress: {
        version: 1,
        operationId: "install-1",
        phase: "failed",
      },
    });
    expect(actor.getSnapshot()).toMatchObject({
      installProgress: { phase: "failed" },
      error: expect.any(String),
    });

    actor.dispatch({ type: "RUNTIME_RESTARTED" });

    expect(actor.getSnapshot().installProgress).toBeUndefined();
    expect(actor.getSnapshot().error).toBeUndefined();
  });
});
