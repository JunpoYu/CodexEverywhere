import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateStaticKeyPair } from "@codex-everywhere/crypto";

import { DeviceRegistry } from "./devices.js";
import { HostStateStore } from "./state-store.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("DeviceRegistry", () => {
  it("consumes a pairing grant exactly once and verifies the static key", async () => {
    const store = await stateStore();
    const registry = new DeviceRegistry(store);
    const grant = await registry.issuePairing();
    const keyPair = generateStaticKeyPair();
    const input = {
      pairingId: grant.pairingId,
      secret: grant.secret,
      deviceId: "phone-1",
      deviceName: "Alice phone",
      publicKey: keyPair.publicKey,
    };

    await registry.consumePairing(input);
    await expect(registry.consumePairing(input)).rejects.toThrow(
      "already used",
    );
    await expect(
      registry.verify(input.deviceId, input.publicKey),
    ).resolves.toMatchObject({
      id: input.deviceId,
    });
    await expect(
      registry.verify(input.deviceId, generateStaticKeyPair().publicKey),
    ).rejects.toThrow("does not match");
    await store.close();
  });

  it("rejects an expired grant and a revoked device", async () => {
    const store = await stateStore();
    const registry = new DeviceRegistry(store);
    const grant = await registry.issuePairing(-1);
    const publicKey = generateStaticKeyPair().publicKey;
    await expect(
      registry.consumePairing({
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceId: "browser-1",
        deviceName: "Browser",
        publicKey,
      }),
    ).rejects.toThrow("expired");

    const valid = await registry.issuePairing();
    await registry.consumePairing({
      pairingId: valid.pairingId,
      secret: valid.secret,
      deviceId: "browser-1",
      deviceName: "Browser",
      publicKey,
    });
    expect(await registry.revoke("browser-1")).toBe(true);
    await expect(registry.verify("browser-1", publicKey)).rejects.toThrow(
      "not trusted",
    );
    await store.close();
  });

  it("enrolls a device only after external authentication", async () => {
    const store = await stateStore();
    const registry = new DeviceRegistry(store);
    const publicKey = generateStaticKeyPair().publicKey;
    await expect(
      registry.enrollAuthenticated({
        deviceId: "temporary-1",
        deviceName: "New browser",
        publicKey,
      }),
    ).resolves.toMatchObject({ id: "temporary-1", name: "New browser" });
    await expect(
      registry.verify("temporary-1", publicKey),
    ).resolves.toMatchObject({ id: "temporary-1" });
    await expect(
      registry.enrollAuthenticated({
        deviceId: "temporary-1",
        deviceName: "Duplicate",
        publicKey,
      }),
    ).rejects.toThrow("already registered");
    await store.close();
  });
});

async function stateStore(): Promise<HostStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "ce-device-test-"));
  temporaryDirectories.push(directory);
  return HostStateStore.open(join(directory, "state.sqlite"));
}
