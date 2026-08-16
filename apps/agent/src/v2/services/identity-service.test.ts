import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IdentityGatewayContext } from "../gateway/identity-gateway-context.js";
import { UserStateDatabase } from "../repositories/user-state-database.js";
import { hashRecoveryCode, IdentityService } from "./identity-service.js";
import { SessionTicketService } from "./session-ticket-service.js";

const resources: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map((close) => close()));
});

describe("IdentityService recovery", () => {
  it("atomically consumes a code, rotates the set, and keeps temporary devices off disk", async () => {
    const fixture = await createFixture();
    const oldCode = "AAAAA-BBBBB-CCCCC-DDDDD";
    await fixture.database.identity.replaceRecoveryCodes([
      hashRecoveryCode(oldCode),
    ]);
    const context = identityContext(false);

    const result = await fixture.service.handlers["auth/recover"](
      {
        version: 1,
        recoveryCode: oldCode,
        deviceName: "Temporary browser",
        rememberDevice: false,
      },
      context.value,
    );

    expect(result).toMatchObject({
      version: 1,
      authenticated: true,
      rememberedDevice: false,
      recoveryCodes: expect.any(Array),
    });
    expect(result.recoveryCodes).toHaveLength(8);
    expect(context.authenticate).toHaveBeenCalledWith({
      access: "user",
      principalId: "user:alice",
      temporary: true,
    });
    expect(
      await fixture.database.identity.device("temporary-device"),
    ).toBeUndefined();
    await expect(
      fixture.service.handlers["auth/recover"](
        {
          version: 1,
          recoveryCode: oldCode,
          deviceName: "Replay",
          rememberDevice: false,
        },
        identityContext(false).value,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    expect(await fixture.database.identity.recoveryHashes()).toHaveLength(8);
  });

  it("requires authentication for rotation and persists only an explicitly remembered device", async () => {
    const fixture = await createFixture();
    const oldCode = "11111-22222-33333-44444";
    await fixture.database.identity.replaceRecoveryCodes([
      hashRecoveryCode(oldCode),
    ]);
    const remembered = identityContext(true);
    await fixture.service.handlers["auth/recover"](
      {
        version: 1,
        recoveryCode: oldCode,
        deviceName: "Remembered browser",
        rememberDevice: true,
      },
      remembered.value,
    );
    expect(
      await fixture.database.identity.device("temporary-device"),
    ).toMatchObject({ name: "Remembered browser" });

    await expect(
      fixture.service.handlers["auth/recovery/rotate"](
        { version: 1 },
        identityContext(false).value,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

    const authenticated = identityContext(true, "user");
    const rotated = await fixture.service.handlers["auth/recovery/rotate"](
      { version: 1 },
      authenticated.value,
    );
    expect(rotated.recoveryCodes).toHaveLength(8);
  });
});

async function createFixture(): Promise<{
  readonly database: UserStateDatabase;
  readonly service: IdentityService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-identity-service-"));
  const database = await UserStateDatabase.open(
    join(directory, "state.sqlite"),
    { create: true },
  );
  const scope = new Scope("identity-service-test");
  const tickets = new SessionTicketService({ scope });
  const service = new IdentityService({
    scope,
    repository: database.identity,
    tickets,
    origin: "https://ce.example.test",
    rpId: "ce.example.test",
    nodeId: "node-test",
    loginName: "alice",
    opaqueServerSetup: "unused-in-recovery-test",
    opaqueIdentifiers: { client: "unix:1001", server: "host-test" },
  });
  resources.push(async () => {
    await scope.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { database, service };
}

function identityContext(
  remembered: boolean,
  access: IdentityGatewayContext["access"] = "pre-auth",
): {
  readonly value: IdentityGatewayContext;
  readonly authenticate: ReturnType<typeof vi.fn>;
} {
  const authenticate = vi.fn();
  return {
    authenticate,
    value: {
      access,
      principalId: access === "user" ? "user:alice" : "pre-auth:test",
      capabilities: new Set(),
      signal: new AbortController().signal,
      temporary: !remembered,
      session: {
        id: crypto.randomUUID(),
        device: {
          id: "temporary-device",
          name: "Browser",
          publicKey: new Uint8Array(32).fill(7),
        },
        authenticate,
      },
    },
  };
}
