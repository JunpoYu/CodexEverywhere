import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Scope } from "@codex-everywhere/kernel";
import {
  GatewayV2Error,
  type MutationInvocation,
} from "@codex-everywhere/protocol/v2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UserStateDatabase } from "../repositories/user-state-database.js";
import { AgentMutationMiddleware } from "./mutation-middleware.js";

const directories: string[] = [];
const scopes: Scope[] = [];
const databases: UserStateDatabase[] = [];

afterEach(async () => {
  await Promise.allSettled(scopes.splice(0).map((scope) => scope.close()));
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
  vi.restoreAllMocks();
});

describe("AgentMutationMiddleware", () => {
  it("publishes a durable claim before executing and replays the result", async () => {
    const { middleware, database } = await fixture();
    const execute = vi.fn(async () => ({ version: 1, removed: true }) as const);

    const first = await middleware.run(invocation(), execute);
    const second = await middleware.run(invocation(), execute);

    expect(first).toEqual({ version: 1, removed: true });
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledOnce();
    await expect(
      database.mutationReceipts.status(OPERATION_KEY),
    ).resolves.toMatchObject({
      version: 1,
      status: "completed",
      method: "queue/remove",
      outcome: { version: 1, kind: "success", result: first },
    });
  });

  it("coalesces concurrent duplicate mutations", async () => {
    const { middleware } = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await blocked;
      return { version: 1, removed: true } as const;
    });

    const first = middleware.run(invocation(), execute);
    const second = middleware.run(invocation(), execute);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { version: 1, removed: true },
      { version: 1, removed: true },
    ]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed when an operation key is reused for another identity", async () => {
    const { middleware } = await fixture();
    await middleware.run(invocation(), async () => ({
      version: 1,
      removed: true,
    }));

    await expect(
      middleware.run(
        invocation({ input: { version: 1, itemId: "queue-2" } }),
        async () => ({ version: 1, removed: true }),
      ),
    ).rejects.toMatchObject({ code: "OPERATION_KEY_REUSED" });
  });

  it("binds a durable key to the complete request without storing its content", async () => {
    const { middleware, database } = await fixture();
    const first = invocation({
      method: "turn/start",
      input: {
        version: 1,
        threadId: "thread-1",
        prompt: "private first prompt",
      },
    });
    await middleware.run(first, async () => ({
      version: 1,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    await expect(
      middleware.run(
        {
          ...first,
          input: {
            version: 1,
            threadId: "thread-1",
            prompt: "different prompt",
          },
        },
        async () => ({
          version: 1,
          threadId: "thread-1",
          turnId: "turn-2",
        }),
      ),
    ).rejects.toMatchObject({ code: "OPERATION_KEY_REUSED" });

    const snapshot = await database.exportSnapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("private first prompt");
    expect(serialized).not.toContain("different prompt");
  });

  it("rejects invocation metadata that disagrees with the protocol registry", async () => {
    const { middleware } = await fixture();

    await expect(
      middleware.run(
        invocation({
          method: "auth/recovery/rotate",
          idempotency: "durable",
          input: { version: 1 },
        }),
        async () => ({ version: 1, recoveryCodes: ["one-time-secret"] }),
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_PROTOCOL_ERROR" });
  });

  it("turns an unclassified handler failure into an indeterminate outcome", async () => {
    const { middleware, database } = await fixture();

    await expect(
      middleware.run(invocation(), async () => {
        throw new Error("synthetic internal detail");
      }),
    ).rejects.toMatchObject({ code: "MUTATION_OUTCOME_UNKNOWN" });
    const status = await database.mutationReceipts.status(OPERATION_KEY);
    expect(status).toMatchObject({
      version: 1,
      status: "indeterminate",
      method: "queue/remove",
    });
    expect(JSON.stringify(status)).not.toContain("synthetic internal detail");
  });

  it("persists and replays definitive Gateway errors", async () => {
    const { middleware } = await fixture();
    const execute = vi.fn(async () => {
      throw new GatewayV2Error("REVISION_CONFLICT", "Revision changed");
    });

    await expect(middleware.run(invocation(), execute)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    await expect(middleware.run(invocation(), execute)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("marks crash-left pending claims indeterminate before traffic", async () => {
    const { middleware, database } = await fixture();
    await database.mutationReceipts.claim({
      operationKey: OPERATION_KEY,
      method: "queue/remove",
      requestFingerprint: durableFingerprintForTest(),
      now: "2026-08-16T00:00:00.000Z",
    });

    await expect(middleware.recoverPending([PRINCIPAL_ID])).resolves.toBe(1);
    await expect(
      database.mutationReceipts.status(OPERATION_KEY),
    ).resolves.toMatchObject({ status: "indeterminate" });
  });

  it("keeps ephemeral authentication results out of SQLite", async () => {
    const { middleware, database } = await fixture();
    const ephemeral = invocation({
      method: "auth/login/options",
      idempotency: "ephemeral",
      input: { version: 1, deviceName: "Phone" },
    });
    const execute = vi.fn(async () => ({
      version: 1,
      challengeId: "challenge-1",
      options: {},
      expiresAt: "2026-08-16T01:00:00.000Z",
    }));

    await middleware.run(ephemeral, execute);
    await middleware.run(ephemeral, execute);

    expect(execute).toHaveBeenCalledOnce();
    await expect(
      database.mutationReceipts.status(OPERATION_KEY),
    ).resolves.toEqual({ version: 1, status: "missing" });
  });

  it("replays an ephemeral authentication result across physical sessions", async () => {
    const { middleware } = await fixture();
    const first = invocation({
      method: "auth/recover",
      idempotency: "ephemeral",
      principalId: "pre-auth:session-1",
      input: {
        version: 1,
        recoveryCode: "recovery-code",
        deviceName: "Phone",
        rememberDevice: false,
      },
    });
    const execute = vi.fn(async () => ({
      version: 1,
      authenticated: true,
      principal: "user" as const,
      loginName: "alice",
      resumeToken: "secret-resume-token",
      rememberedDevice: false,
      recoveryCodes: ["new-recovery-code"],
    }));

    const initial = await middleware.run(first, execute);
    const replayed = await middleware.run(
      { ...first, principalId: "pre-auth:session-2" },
      execute,
    );

    expect(replayed).toEqual(initial);
    expect(execute).toHaveBeenCalledOnce();
  });
});

const OPERATION_KEY = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "user:test";

function invocation(
  patch: Partial<MutationInvocation> = {},
): MutationInvocation {
  return {
    method: "queue/remove",
    operationKey: OPERATION_KEY,
    idempotency: "durable",
    principalId: PRINCIPAL_ID,
    requestId: "11111111-1111-4111-8111-111111111111",
    input: { version: 1, itemId: "queue-1" },
    ...patch,
  };
}

async function fixture(): Promise<{
  database: UserStateDatabase;
  middleware: AgentMutationMiddleware;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-mutation-test-"));
  directories.push(directory);
  const database = await UserStateDatabase.open(
    join(directory, "state.sqlite"),
    { create: true },
  );
  databases.push(database);
  const scope = new Scope("test");
  scopes.push(scope);
  return {
    database,
    middleware: new AgentMutationMiddleware({
      scope,
      resolveRepository: () => database.mutationReceipts,
    }),
  };
}

function durableFingerprintForTest(): string {
  // Recovery only needs an existing durable claim; it does not compare input.
  return "synthetic-fingerprint";
}
