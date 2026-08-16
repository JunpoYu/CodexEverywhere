import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UserStateDatabase } from "./user-state-database.js";

const directories: string[] = [];
const databases: UserStateDatabase[] = [];

afterEach(async () => {
  await Promise.allSettled(
    databases.splice(0).map((database) => database.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("IdentityRepository device trust", () => {
  it("atomically consumes a pairing grant and preserves the device binding", async () => {
    const database = await fixture();
    const grant = await database.identity.issuePairing();
    const publicKey = new Uint8Array(32).fill(7);

    const device = await database.identity.consumePairing({
      pairingId: grant.pairingId,
      secret: grant.secret,
      deviceId: "browser-1",
      deviceName: "Phone",
      publicKey,
    });

    expect(device).toMatchObject({ id: "browser-1", name: "Phone" });
    await expect(
      database.identity.consumePairing({
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceId: "browser-2",
        deviceName: "Replay",
        publicKey: new Uint8Array(32).fill(8),
      }),
    ).rejects.toThrow("invalid or already used");
    await expect(
      database.identity.verifyDevice("browser-1", publicKey),
    ).resolves.toMatchObject({ id: "browser-1" });
  });

  it("distinguishes unknown, revoked, and key-mismatched devices", async () => {
    const database = await fixture();
    const key = new Uint8Array(32).fill(3);

    await expect(
      database.identity.verifyDevice("missing", key),
    ).rejects.toMatchObject({ code: "NOT_TRUSTED" });
    await database.identity.rememberDevice({
      id: "browser-1",
      name: "Desktop",
      publicKey: key,
    });
    await expect(
      database.identity.verifyDevice("browser-1", new Uint8Array(32).fill(4)),
    ).rejects.toMatchObject({ code: "KEY_MISMATCH" });
    expect(await database.identity.revokeDevice("browser-1")).toBe(true);
    await expect(
      database.identity.verifyDevice("browser-1", key),
    ).rejects.toMatchObject({ code: "REVOKED" });
  });

  it("atomically consumes recovery authorization and invalidates every old code", async () => {
    const database = await fixture();
    const oldOne = new Uint8Array([1, 2, 3]);
    const oldTwo = new Uint8Array([4, 5, 6]);
    const replacement = [
      new Uint8Array([7, 8, 9]),
      new Uint8Array([10, 11, 12]),
    ];
    await database.identity.replaceRecoveryCodes([oldOne, oldTwo]);

    await database.identity.consumeRecoveryAndReplace(oldOne, replacement);

    expect(await database.identity.recoveryHashes()).toEqual(replacement);
    await expect(
      database.identity.consumeRecoveryAndReplace(oldTwo, replacement),
    ).rejects.toThrow("invalid or already used");
    expect(await database.identity.recoveryHashes()).toEqual(replacement);
  });
});

async function fixture(): Promise<UserStateDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "ce-v4-identity-test-"));
  directories.push(directory);
  const database = await UserStateDatabase.open(
    join(directory, "state.sqlite"),
    { create: true },
  );
  databases.push(database);
  return database;
}
