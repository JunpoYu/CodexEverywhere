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
    expect(gatewayMethodNames).toContain("side/read");
    expect(gatewayMethodNames).toContain("side/start");
    expect(gatewayMethodNames).toContain("side/delete");
    expect(gatewayMethodNames).toContain("model/list");
    expect(gatewayMethodNames).toContain("interaction/respond");
    expect(gatewayMethodNames).toContain("mutation/status");
    expect(gatewayMethodNames).toContain("admin/user/recovery/start");
    expect(gatewayMethodNames).not.toContain("thread/fork" as never);
    expect(gatewayMethodNames).not.toContain("side/session/start" as never);
    expect(gatewayMethodNames).not.toContain(
      "setup/codex/auth/import" as never,
    );
  });

  it("requires explicit acknowledgement and a creation key to abandon an unknown side", () => {
    const schema = gatewayMethodDefinitions["side/abandon"].input;
    const input = {
      version: 1,
      parentThreadId: "parent",
      creationKey: "creation-key",
    };
    expect(schema.safeParse(input).success).toBe(false);
    expect(
      schema.safeParse({ ...input, acknowledgeOrphan: false }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...input, acknowledgeOrphan: true }).success,
    ).toBe(true);
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

  it("accepts bounded opt-in turn pagination and preserves legacy item inputs", () => {
    for (const method of ["thread/open", "thread/history"] as const) {
      const schema = gatewayMethodDefinitions[method].input;
      const input = { version: 1, threadId: "thread-1" };
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, historyTurnLimit: 3 }).success).toBe(
        true,
      );
      for (const historyTurnLimit of [0, 11, 1.5, "3"]) {
        expect(schema.safeParse({ ...input, historyTurnLimit }).success).toBe(
          false,
        );
      }
    }
  });

  it("validates the optional authoritative compaction count", () => {
    const definition = gatewayMethodDefinitions["thread/open"];
    expect(
      definition.input.safeParse({
        version: 1,
        threadId: "thread-1",
        historyLimit: 50,
        includeCompactionCount: true,
      }).success,
    ).toBe(true);
    expect(
      definition.input.safeParse({
        version: 1,
        threadId: "thread-1",
        historyLimit: 50,
        includeCompactionCount: false,
      }).success,
    ).toBe(false);

    const snapshot = {
      version: 1,
      thread: {
        version: 1,
        id: "thread-1",
        workspaceId: "workspace-1",
        title: "Task",
        state: "idle",
        archived: false,
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:00:00.000Z",
      },
      state: "idle",
      items: [],
      interactions: [],
      hasEarlierHistory: false,
      settings: { version: 1, revision: 0 },
      compactionCount: 2,
    };
    expect(definition.output.safeParse(snapshot).success).toBe(true);
    expect(
      definition.output.safeParse({ ...snapshot, compactionCount: -1 }).success,
    ).toBe(false);
  });

  it("derives precise inputs, outputs, and request options", () => {
    expectTypeOf<InputOf<"thread/start">>().toEqualTypeOf<{
      version: 2;
      workspaceId: string;
      prompt: string;
      expectedPreferencesRevision: number;
      settings?: {
        model?: string;
        effort?: string;
        sandbox?: "read-only" | "workspace-write" | "danger-full-access";
        approvalPolicy?: "untrusted" | "on-request" | "never";
      };
    }>();
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
    expectTypeOf<InputOf<"thread/open">>().toEqualTypeOf<{
      version: 1;
      threadId: string;
      historyCursor?: string;
      historyLimit: number;
      historyTurnLimit?: number;
      includeWorkingDirectory?: true;
      includeContextUsage?: true;
      includeCompactionCount?: true;
    }>();
    expectTypeOf<OutputOf<"thread/open">["workingDirectory"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<OutputOf<"thread/open">["contextUsage"]>().toEqualTypeOf<
      | {
          version: 1;
          turnId: string;
          currentTokens: number;
          cumulativeTokens: number;
          modelContextWindow: number | null;
        }
      | undefined
    >();
    expectTypeOf<OutputOf<"thread/open">["compactionCount"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<InputOf<"setup/codex/version">>().toEqualTypeOf<{
      version: 1;
      includeRuntimeSwitchState?: true;
    }>();
    expectTypeOf<
      OutputOf<"setup/codex/version">["runtimeSwitchState"]
    >().toEqualTypeOf<"none" | "installing" | "restart-required" | undefined>();
  });

  it("fails closed for cached thread/start payloads without the revision guard", () => {
    const schema = gatewayMethodDefinitions["thread/start"].input;

    expect(
      schema.safeParse({
        version: 1,
        workspaceId: "workspace-1",
        prompt: "stale cached client",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        version: 2,
        workspaceId: "workspace-1",
        prompt: "missing guard",
      }).success,
    ).toBe(false);
  });
});
