import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EphemeralIdempotencyRegistry,
  IdempotencyRegistry,
  usesEphemeralGatewayIdempotency,
} from "./idempotency.js";
import { HostStateStore } from "./state-store.js";

describe("IdempotencyRegistry", () => {
  let directory: string | undefined;
  let state: HostStateStore | undefined;

  afterEach(async () => {
    await state?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("runs concurrent and later retries only once per device", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    let calls = 0;
    const operation = async () => ({ call: ++calls });
    const [first, concurrent] = await Promise.all([
      registry.execute("device-a", "request-key", operation),
      registry.execute("device-a", "request-key", operation),
    ]);
    const later = await registry.execute("device-a", "request-key", operation);
    const otherDevice = await registry.execute(
      "device-b",
      "request-key",
      operation,
    );
    expect(first).toEqual(concurrent);
    expect(later).toEqual(first);
    expect(otherDevice).not.toEqual(first);
    expect(calls).toBe(2);
  });

  it("fails closed after a durable thread/start claim survives an Agent restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    const firstRegistry = new IdempotencyRegistry(state);

    await expect(
      firstRegistry.execute(
        "device-a",
        "thread-start-key",
        async () => {
          await expect(
            state!.read(
              (database) =>
                database.exec(
                  "SELECT count(*) FROM durable_mutation_claims WHERE result_json IS NULL",
                )[0]?.values[0]?.[0],
            ),
          ).resolves.toBe(1);
          await expect(
            state!.read(
              (database) =>
                database.exec("SELECT result_json FROM idempotency_keys")[0]
                  ?.values[0]?.[0],
            ),
          ).resolves.toContain("IDEMPOTENCY_OUTCOME_INDETERMINATE");
          await state!.close();
          state = undefined;
          return { thread: { id: "created-before-crash" } };
        },
        {
          durableClaim: {
            method: "thread/start",
            payload: { cwd: "/work", approvalPolicy: "never" },
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });

    state = await HostStateStore.open(statePath);
    await state.transaction((database) =>
      database.run(
        "UPDATE durable_mutation_claims SET created_at = ? WHERE key IS NOT NULL",
        ["2000-01-01T00:00:00.000Z"],
      ),
    );
    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));
    const legacyReplay = vi.fn(async () => ({ thread: { id: "duplicate" } }));
    await expect(
      new IdempotencyRegistry(state).execute(
        "device-a",
        "thread-start-key",
        legacyReplay,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
    });
    expect(legacyReplay).not.toHaveBeenCalled();
    await expect(
      new IdempotencyRegistry(state).execute(
        "device-a",
        "thread-start-key",
        replay,
        {
          durableClaim: {
            method: "thread/start",
            payload: { cwd: "/work", approvalPolicy: "never" },
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
    });
    expect(replay).not.toHaveBeenCalled();
  });

  it("does not replay a durable thread/start key when content fields change", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    const first = await registry.execute(
      "device-a",
      "thread-start-key",
      async () => ({ thread: { id: "thread-1" } }),
      {
        durableClaim: {
          method: "thread/start",
          payload: { cwd: "/work/one" },
        },
      },
    );
    expect(first).toMatchObject({ ok: true });

    const mismatched = vi.fn(async () => ({ thread: { id: "duplicate" } }));
    await expect(
      registry.execute("device-a", "thread-start-key", mismatched, {
        durableClaim: {
          method: "thread/start",
          payload: { cwd: "/work/two" },
        },
      }),
    ).resolves.toEqual(first);
    expect(mismatched).not.toHaveBeenCalled();
  });

  it("shares one in-flight durable thread/start execution", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await blocked;
      return { thread: { id: "thread-1" } };
    });
    const options = {
      durableClaim: {
        method: "thread/start",
        payload: { cwd: "/work" },
      },
    };
    const first = registry.execute(
      "device-a",
      "thread-start-key",
      operation,
      options,
    );
    const concurrent = registry.execute(
      "device-a",
      "thread-start-key",
      operation,
      options,
    );
    release!();

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { ok: true, result: { thread: { id: "thread-1" } } },
      { ok: true, result: { thread: { id: "thread-1" } } },
    ]);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("permanently fails closed when a claimed thread/start operation rejects", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    const operation = vi.fn(async () => {
      throw new Error("app-server disconnected after accepting thread/start");
    });
    const options = {
      durableClaim: {
        method: "thread/start",
        payload: { cwd: "/work" },
      },
    };

    const first = await registry.execute(
      "device-a",
      "thread-start-key",
      operation,
      options,
    );
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    expect(operation).toHaveBeenCalledOnce();

    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT durable_mutation_claims.result_json, idempotency_keys.result_json, idempotency_keys.expires_at FROM durable_mutation_claims JOIN idempotency_keys USING (key)",
          )[0]?.values[0],
      ),
    ).resolves.toEqual([
      JSON.stringify(first),
      JSON.stringify(first),
      "9999-12-31T23:59:59.999Z",
    ]);

    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));
    await expect(
      registry.execute("device-a", "thread-start-key", replay, options),
    ).resolves.toEqual(first);
    expect(replay).not.toHaveBeenCalled();

    const downgradeReplay = vi.fn(async () => ({
      thread: { id: "duplicate-after-downgrade" },
    }));
    await expect(
      registry.execute("device-a", "thread-start-key", downgradeReplay),
    ).resolves.toEqual(first);
    expect(downgradeReplay).not.toHaveBeenCalled();
  });

  it("upgrades a legacy thread/start rejection to a permanent indeterminate result", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    await registry.execute("device-a", "thread-start-key", async () => {
      throw new Error("legacy app-server disconnect");
    });
    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));

    const upgraded = await registry.execute(
      "device-a",
      "thread-start-key",
      replay,
      {
        durableClaim: {
          method: "thread/start",
          payload: { cwd: "/work" },
        },
      },
    );
    expect(upgraded).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    expect(replay).not.toHaveBeenCalled();
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT durable_mutation_claims.result_json, idempotency_keys.result_json, idempotency_keys.expires_at FROM durable_mutation_claims JOIN idempotency_keys USING (key)",
          )[0]?.values[0],
      ),
    ).resolves.toEqual([
      JSON.stringify(upgraded),
      JSON.stringify(upgraded),
      "9999-12-31T23:59:59.999Z",
    ]);
  });

  it("fails a claimed thread/start with an unverifiable response closed", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);

    await expect(
      registry.execute(
        "device-a",
        "thread-start-key",
        async () => ({ thread: { id: "" } }),
        {
          durableClaim: {
            method: "thread/start",
            payload: { cwd: "/work" },
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
  });

  it("returns indeterminate when committing a successful thread/start result fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const originalTransaction = state.transaction.bind(state);
    let transactions = 0;
    vi.spyOn(state, "transaction").mockImplementation(async (operation) => {
      const transaction = ++transactions;
      const result = await originalTransaction(operation);
      if (transaction === 2) {
        throw new Error("injected durable result commit failure");
      }
      return result;
    });
    const registry = new IdempotencyRegistry(state);
    const operation = vi.fn(async () => ({
      thread: { id: "created-before-commit-failure" },
    }));
    const options = {
      durableClaim: {
        method: "thread/start",
        payload: { cwd: "/work" },
      },
    };

    const first = await registry.execute(
      "device-a",
      "thread-start-key",
      operation,
      options,
    );
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    await expect(
      registry.execute("device-a", "thread-start-key", operation),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    await expect(
      registry.execute("device-a", "thread-start-key", operation, options),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    expect(operation).toHaveBeenCalledOnce();
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT durable_mutation_claims.result_json, idempotency_keys.result_json, idempotency_keys.expires_at FROM durable_mutation_claims JOIN idempotency_keys USING (key)",
          )[0]?.values[0],
      ),
    ).resolves.toEqual([
      JSON.stringify(first),
      JSON.stringify(first),
      "9999-12-31T23:59:59.999Z",
    ]);
  });

  it("never expires a completed durable thread/start tombstone", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    const statePath = join(directory, "state.sqlite");
    state = await HostStateStore.open(statePath);
    const options = {
      durableClaim: {
        method: "thread/start",
        payload: { cwd: "/work" },
      },
    };
    await new IdempotencyRegistry(state).execute(
      "device-a",
      "thread-start-key",
      async () => ({ thread: { id: "thread-1" } }),
      options,
    );
    await state.transaction((database) =>
      database.run(
        "UPDATE durable_mutation_claims SET created_at = ?, completed_at = ?",
        ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:01.000Z"],
      ),
    );
    await state.close();
    state = await HostStateStore.open(statePath);
    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));

    await expect(
      new IdempotencyRegistry(state).execute(
        "device-a",
        "thread-start-key",
        replay,
        options,
      ),
    ).resolves.toEqual({
      ok: true,
      result: { thread: { id: "thread-1" } },
    });
    expect(replay).not.toHaveBeenCalled();

    const downgradeReplay = vi.fn(async () => ({
      thread: { id: "duplicate-after-downgrade" },
    }));
    await expect(
      new IdempotencyRegistry(state).execute(
        "device-a",
        "thread-start-key",
        downgradeReplay,
      ),
    ).resolves.toEqual({
      ok: true,
      result: { thread: { id: "thread-1" } },
    });
    expect(downgradeReplay).not.toHaveBeenCalled();
  });

  it("migrates a still-valid legacy thread/start result without replaying", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    await registry.execute("device-a", "thread-start-key", async () => ({
      thread: { id: "legacy-thread" },
    }));
    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));

    await expect(
      registry.execute("device-a", "thread-start-key", replay, {
        durableClaim: {
          method: "thread/start",
          payload: { cwd: "/work" },
        },
      }),
    ).resolves.toEqual({
      ok: true,
      result: { thread: { id: "legacy-thread" } },
    });
    expect(replay).not.toHaveBeenCalled();
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT count(*), min(expires_at) FROM durable_mutation_claims JOIN idempotency_keys USING (key)",
          )[0]?.values[0],
      ),
    ).resolves.toEqual([1, "9999-12-31T23:59:59.999Z"]);
  });

  it("fails closed when a legacy key contains a non-thread result", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    await registry.execute("device-a", "thread-start-key", async () => ({
      unrelated: true,
    }));
    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));

    await expect(
      registry.execute("device-a", "thread-start-key", replay, {
        durableClaim: {
          method: "thread/start",
          payload: { cwd: "/work" },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
    });
    expect(replay).not.toHaveBeenCalled();
  });

  it("fails closed when a durable result has an invalid runtime shape", async () => {
    directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
    state = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new IdempotencyRegistry(state);
    const options = {
      durableClaim: {
        method: "thread/start",
        payload: { cwd: "/work" },
      },
    };
    await registry.execute(
      "device-a",
      "thread-start-key",
      async () => ({ thread: { id: "thread-1" } }),
      options,
    );
    await state.transaction((database) =>
      database.run(
        "UPDATE durable_mutation_claims SET result_json = ? WHERE key IS NOT NULL",
        [JSON.stringify({ ok: true })],
      ),
    );
    const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));

    await expect(
      registry.execute("device-a", "thread-start-key", replay, options),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
    });
    expect(replay).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: "turn/start",
      payload: {
        threadId: "thread-1",
        clientUserMessageId: "operation-turn-1",
        input: [{ type: "text", text: "PRIVATE TURN PROMPT" }],
      },
      changedPayload: {
        threadId: "thread-1",
        clientUserMessageId: "operation-turn-1",
        input: [{ type: "text", text: "DIFFERENT PRIVATE TURN PROMPT" }],
      },
      result: {
        turn: {
          id: "turn-1",
          status: "inProgress",
          items: [{ text: "PRIVATE TURN PROMPT" }],
        },
      },
      privateText: "PRIVATE TURN PROMPT",
    },
    {
      method: "queue/add",
      payload: {
        threadId: "thread-1",
        clientUserMessageId: "operation-queue-1",
        input: [{ type: "text", text: "PRIVATE QUEUE PROMPT" }],
      },
      changedPayload: {
        threadId: "thread-1",
        clientUserMessageId: "operation-queue-1",
        input: [{ type: "text", text: "DIFFERENT PRIVATE QUEUE PROMPT" }],
      },
      result: {
        id: "queue-1",
        threadId: "thread-1",
        status: "pending",
        turnPayload: {
          clientUserMessageId: "operation-queue-1",
          input: [{ type: "text", text: "PRIVATE QUEUE PROMPT" }],
        },
      },
      privateText: "PRIVATE QUEUE PROMPT",
    },
  ])(
    "returns the first $method success from memory but persists only a permanent tombstone",
    async ({ method, payload, changedPayload, result, privateText }) => {
      directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
      state = await HostStateStore.open(join(directory, "state.sqlite"));
      const registry = new IdempotencyRegistry(state);
      const operation = vi.fn(async () => result);
      const options = { durableClaim: { method, payload } };

      await expect(
        registry.execute(
          "device-a",
          `${method}-private-key`,
          operation,
          options,
        ),
      ).resolves.toEqual({ ok: true, result });
      const replay = await registry.execute(
        "device-a",
        `${method}-private-key`,
        operation,
        options,
      );
      expect(replay).toMatchObject({
        ok: false,
        error: {
          code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
          retryable: false,
        },
      });
      await expect(
        registry.execute("device-a", `${method}-private-key`, operation, {
          durableClaim: { method, payload: changedPayload },
        }),
      ).resolves.toEqual(replay);
      await expect(
        registry.execute("device-a", `${method}-private-key`, operation),
      ).resolves.toEqual(replay);
      expect(operation).toHaveBeenCalledOnce();

      const rows = await state.read(
        (database) =>
          database.exec(
            "SELECT durable_mutation_claims.method, durable_mutation_claims.request_fingerprint, durable_mutation_claims.result_json, idempotency_keys.result_json, idempotency_keys.expires_at FROM durable_mutation_claims JOIN idempotency_keys USING (key)",
          )[0]?.values[0],
      );
      expect(rows?.[0]).toBe(method);
      expect(rows?.[2]).toBe(JSON.stringify(replay));
      expect(rows?.[3]).toBe(JSON.stringify(replay));
      expect(rows?.[4]).toBe("9999-12-31T23:59:59.999Z");
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(privateText);
      expect(serialized).not.toContain("DIFFERENT PRIVATE");
      expect(serialized).not.toContain(
        legacyPayloadFingerprint(method, payload),
      );
    },
  );

  it.each(["turn/start", "queue/add"])(
    "permanently fails a rejected claimed %s closed",
    async (method) => {
      directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
      state = await HostStateStore.open(join(directory, "state.sqlite"));
      const registry = new IdempotencyRegistry(state);
      const payload = {
        threadId: "thread-1",
        clientUserMessageId: `operation-${method}`,
        input: [{ type: "text", text: "PRIVATE REJECTED PROMPT" }],
      };
      const operation = vi.fn(async () => {
        throw new Error(`app-server disconnected after accepting ${method}`);
      });
      const options = { durableClaim: { method, payload } };

      const first = await registry.execute(
        "device-a",
        `${method}-rejected-key`,
        operation,
        options,
      );
      expect(first).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
      });
      await expect(
        registry.execute(
          "device-a",
          `${method}-rejected-key`,
          operation,
          options,
        ),
      ).resolves.toEqual(first);
      expect(operation).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      method: "turn/start",
      result: { turn: { id: "" } },
    },
    {
      method: "queue/add",
      result: {
        id: "queue-1",
        threadId: "thread-1",
        status: "pending",
        turnPayload: { clientUserMessageId: "wrong-operation" },
      },
    },
  ])(
    "fails an unverifiable $method response closed",
    async ({ method, result }) => {
      directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
      state = await HostStateStore.open(join(directory, "state.sqlite"));
      const registry = new IdempotencyRegistry(state);

      await expect(
        registry.execute(
          "device-a",
          `${method}-invalid-key`,
          async () => result,
          {
            durableClaim: {
              method,
              payload: {
                threadId: "thread-1",
                clientUserMessageId: "operation-1",
              },
            },
          },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
      });
    },
  );

  it.each([
    {
      name: "completed",
      result: { ok: true, result: { thread: { id: "legacy-thread" } } },
    },
    {
      name: "pending",
      result: null,
    },
  ])(
    "migrates an unreleased $name thread/start claim without replay or payload hashes",
    async ({ result }) => {
      directory = await mkdtemp(join(tmpdir(), "ce-idempotency-"));
      const statePath = join(directory, "state.sqlite");
      state = await HostStateStore.open(statePath);
      const payload = { cwd: "/PRIVATE/LOW-ENTROPY/PATH" };
      const key = testDigestKey("device-a", "legacy-thread-start-key");
      const oldFingerprint = legacyPayloadFingerprint("thread/start", payload);
      const indeterminate = {
        ok: false,
        error: {
          code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
          message: "legacy claim is pending",
          retryable: false,
        },
      };
      const mirrored = result ?? indeterminate;
      await state.transaction((database) => {
        database.run("DROP TABLE durable_mutation_claims");
        database.run(`CREATE TABLE thread_start_claims (
          key TEXT PRIMARY KEY,
          request_fingerprint TEXT NOT NULL,
          result_json TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        )`);
        database.run("INSERT INTO thread_start_claims VALUES (?, ?, ?, ?, ?)", [
          key,
          oldFingerprint,
          result === null ? null : JSON.stringify(result),
          "2026-08-01T00:00:00.000Z",
          result === null ? null : "2026-08-01T00:00:01.000Z",
        ]);
        database.run(
          "INSERT OR REPLACE INTO idempotency_keys VALUES (?, ?, ?)",
          [key, JSON.stringify(mirrored), "9999-12-31T23:59:59.999Z"],
        );
      });
      await state.close();
      state = await HostStateStore.open(statePath);
      const replay = vi.fn(async () => ({ thread: { id: "duplicate" } }));

      const outcome = await new IdempotencyRegistry(state).execute(
        "device-a",
        "legacy-thread-start-key",
        replay,
        { durableClaim: { method: "thread/start", payload } },
      );
      if (result === null) {
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
        });
      } else {
        expect(outcome).toEqual(mirrored);
      }
      expect(replay).not.toHaveBeenCalled();
      await state.close();
      state = undefined;
      const bytes = await readFile(statePath);
      expect(bytes.includes(Buffer.from(oldFingerprint))).toBe(false);
      expect(bytes.includes(Buffer.from("/PRIVATE/LOW-ENTROPY/PATH"))).toBe(
        false,
      );
    },
  );

  it("keeps secret-bearing gateway exchanges out of persistent replay", async () => {
    expect(usesEphemeralGatewayIdempotency("auth/login/verify")).toBe(true);
    expect(usesEphemeralGatewayIdempotency("codex/account/login/start")).toBe(
      true,
    );
    expect(usesEphemeralGatewayIdempotency("admin/recovery/start")).toBe(true);
    expect(usesEphemeralGatewayIdempotency("workspace/add")).toBe(false);

    const registry = new EphemeralIdempotencyRegistry();
    const request = {
      version: 1 as const,
      requestId: "request-1",
      idempotencyKey: "secret-request-key",
      method: "auth/login/verify",
      payload: { assertion: "hashed-not-retained" },
    };
    await expect(
      registry.execute(request, async () => ({
        authenticated: true,
        resumeToken: "RESUME-TOKEN-PLAINTEXT",
      })),
    ).resolves.toEqual({
      ok: true,
      result: {
        authenticated: true,
        resumeToken: "RESUME-TOKEN-PLAINTEXT",
      },
    });
    await expect(
      registry.execute(request, async () => ({ authenticated: true })),
    ).resolves.toEqual({
      ok: true,
      result: {
        authenticated: true,
        resumeToken: "RESUME-TOKEN-PLAINTEXT",
      },
    });
  });

  it("rejects an ephemeral idempotency key reused for another request", async () => {
    const registry = new EphemeralIdempotencyRegistry();
    const base = {
      version: 1 as const,
      requestId: "request-1",
      idempotencyKey: "shared-request-key",
      method: "auth/recover",
    };
    await registry.execute({ ...base, payload: { code: "one" } }, async () => ({
      registrationRequired: true,
    }));
    await expect(
      registry.execute({ ...base, payload: { code: "two" } }, async () => ({
        registrationRequired: true,
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("different request") },
    });
  });

  it("expires a secret result without requiring another request or transport close", async () => {
    vi.useFakeTimers();
    try {
      const registry = new EphemeralIdempotencyRegistry();
      const request = {
        version: 1 as const,
        requestId: "request-1",
        idempotencyKey: "expiring-secret-key",
        method: "auth/login/verify",
        payload: { response: "proof" },
      };
      let calls = 0;
      const operation = async () => ({ call: ++calls, resumeToken: "secret" });
      await registry.execute(request, operation);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
      await registry.execute(request, operation);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears expiry timers on LRU eviction and transport close", async () => {
    vi.useFakeTimers();
    try {
      const registry = new EphemeralIdempotencyRegistry(1);
      const request = (key: string) => ({
        version: 1 as const,
        requestId: key,
        idempotencyKey: key,
        method: "auth/login/verify",
        payload: {},
      });
      await registry.execute(request("first-secret-key"), async () => "one");
      expect(vi.getTimerCount()).toBe(1);
      await registry.execute(request("second-secret-key"), async () => "two");
      expect(vi.getTimerCount()).toBe(1);
      registry.clear();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function testDigestKey(deviceId: string, key: string): string {
  return createHash("sha256")
    .update("ce-idempotency-v1\0")
    .update(deviceId)
    .update("\0")
    .update(key)
    .digest("base64url");
}

function legacyPayloadFingerprint(method: string, payload: unknown): string {
  return createHash("sha256")
    .update("ce-ephemeral-idempotency-v1\0")
    .update(method)
    .update("\0")
    .update(JSON.stringify(payload))
    .digest("base64url");
}
