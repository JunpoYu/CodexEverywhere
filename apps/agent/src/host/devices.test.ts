import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStaticKeyPair } from "@codex-everywhere/crypto";

import {
  CachedDeviceTrustVerifier,
  DeviceRegistry,
  DeviceTrustError,
} from "./devices.js";
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
    await expect(registry.verify("browser-1", publicKey)).rejects.toMatchObject(
      { code: "REVOKED" },
    );
    await store.close();
  });

  it("classifies persistent trust failures without masking storage errors", async () => {
    const store = await stateStore();
    const registry = new DeviceRegistry(store);
    const publicKey = generateStaticKeyPair().publicKey;
    await expect(registry.verify("missing", publicKey)).rejects.toMatchObject({
      code: "NOT_TRUSTED",
    });
    expect(
      await registry
        .verify("missing", publicKey)
        .catch((error: unknown) => error instanceof DeviceTrustError),
    ).toBe(true);
    await store.close();
  });

  it("does not reload device trust state for every high-frequency RPC", async () => {
    const publicKey = generateStaticKeyPair().publicKey;
    const trusted = {
      id: "browser-1",
      name: "Browser",
      publicKey,
      createdAt: new Date().toISOString(),
    };
    let now = 1_000;
    const verify = vi.fn(async () => trusted);
    const verifier = new CachedDeviceTrustVerifier(
      { verify },
      { ttlMs: 10_000, now: () => now },
    );

    await Promise.all(
      Array.from({ length: 25 }, () => verifier.verify("browser-1", publicKey)),
    );
    expect(verify).toHaveBeenCalledOnce();
    now += 10_001;
    await verifier.verify("browser-1", publicKey);
    expect(verify).toHaveBeenCalledTimes(2);
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

  it("reactivates a revoked device only after explicit authenticated enrollment", async () => {
    const store = await stateStore();
    const registry = new DeviceRegistry(store);
    const publicKey = generateStaticKeyPair().publicKey;
    await registry.enrollAuthenticated({
      deviceId: "browser-1",
      deviceName: "Old name",
      publicKey,
    });
    await registry.revoke("browser-1");

    await expect(
      registry.enrollAuthenticated({
        deviceId: "browser-1",
        deviceName: "Still rejected",
        publicKey,
      }),
    ).rejects.toThrow("already registered");
    const remembered = await registry.rememberAuthenticated({
      deviceId: "browser-1",
      deviceName: "Trusted again",
      publicKey,
    });
    expect(remembered.device).toMatchObject({ name: "Trusted again" });
    expect(remembered.rollback).toBeTypeOf("function");
    await expect(
      registry.verify("browser-1", publicKey),
    ).resolves.toMatchObject({ name: "Trusted again" });
    await store.close();
  });
});

async function stateStore(): Promise<HostStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "ce-device-test-"));
  temporaryDirectories.push(directory);
  return HostStateStore.open(join(directory, "state.sqlite"));
}
