import { describe, expect, expectTypeOf, it } from "vitest";
import {
  gatewayMethodDefinitions,
  gatewayMethodNames,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "./methods.js";

describe("Gateway API v2 method registry", () => {
  it("contains the planned surface and permanently excludes removed methods", () => {
    expect(gatewayMethodNames).toContain("thread/open");
    expect(gatewayMethodNames).toContain("interaction/respond");
    expect(gatewayMethodNames).toContain("mutation/status");
    expect(gatewayMethodNames).toContain("admin/user/recovery/start");
    expect(gatewayMethodNames).not.toContain("thread/fork" as never);
    expect(gatewayMethodNames).not.toContain("side/session/start" as never);
    expect(gatewayMethodNames).not.toContain(
      "setup/codex/auth/import" as never,
    );
  });

  it("gives every method schemas and coherent metadata", () => {
    for (const method of gatewayMethodNames) {
      const definition = gatewayMethodDefinitions[method];
      expect(definition.input).toBeDefined();
      expect(definition.output).toBeDefined();
      if (definition.kind === "query") {
        expect(definition.idempotency, method).toBe("none");
      } else {
        expect(["ephemeral", "durable"], method).toContain(
          definition.idempotency,
        );
      }
      expect(definition.input.safeParse({}).success, method).toBe(false);
    }
  });

  it("never persists one-time Web identity secrets in durable receipts", () => {
    for (const method of [
      "auth/register/verify",
      "auth/password/register/finish",
      "auth/recover",
      "auth/recovery/rotate",
      "admin/user/recovery/start",
    ] as const) {
      expect(gatewayMethodDefinitions[method].idempotency, method).toBe(
        "ephemeral",
      );
    }
  });

  it("derives precise inputs, outputs, and request options", () => {
    expectTypeOf<InputOf<"turn/start">>().toEqualTypeOf<{
      version: 1;
      threadId: string;
      prompt: string;
    }>();
    expectTypeOf<OutputOf<"turn/interrupt">>().toEqualTypeOf<{
      version: 1;
      interrupted: true;
    }>();
    expectTypeOf<RequestOptionsOf<"turn/start">>().toEqualTypeOf<{
      readonly operationKey: string;
      readonly signal?: AbortSignal;
    }>();
    expectTypeOf<RequestOptionsOf<"thread/open">>().toEqualTypeOf<{
      readonly signal?: AbortSignal;
    }>();
  });
});
