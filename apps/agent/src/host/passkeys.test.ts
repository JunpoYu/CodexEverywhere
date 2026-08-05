import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { PasskeyRegistry } from "./passkeys.js";
import { HostStateStore } from "./state-store.js";

vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@simplewebauthn/server")>();
  return { ...original, verifyRegistrationResponse: vi.fn() };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("PasskeyRegistry recovery codes", () => {
  it("uses a recognizable Unix account and host display name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-passkey-label-"));
    temporaryDirectories.push(directory);
    const store = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new PasskeyRegistry(store, {
      origin: "https://codex.example",
      rpId: "codex.example",
      userName: "alice",
      userDisplayName: "alice · hpc-cluster-1",
      nodeId: "node-1",
    });

    const options = await registry.registrationOptions();

    expect(options.user.name).toBe("alice");
    expect(options.user.displayName).toBe("alice · hpc-cluster-1");
    await store.close();
  });

  it("shows one new code and invalidates the older code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-passkey-test-"));
    temporaryDirectories.push(directory);
    const store = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new PasskeyRegistry(store, {
      origin: "https://codex.example",
      rpId: "codex.example",
      userName: "unix:1003",
      nodeId: "node-1",
    });
    const first = await registry.rotateRecoveryCodes();
    expect(first).toHaveLength(1);

    const second = await registry.rotateRecoveryCodes("local-admin");
    expect(second).toHaveLength(1);
    await expect(registry.consumeRecoveryCode(first[0]!)).rejects.toThrow(
      "invalid or already used",
    );
    await expect(
      registry.verifyRecoveryCode(second[0]!),
    ).resolves.toBeUndefined();
    await expect(
      registry.consumeRecoveryCode(second[0]!),
    ).resolves.toBeUndefined();
    await store.close();
  });

  it("revokes every previous Web credential only after replacement registration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-passkey-recovery-"));
    temporaryDirectories.push(directory);
    const store = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new PasskeyRegistry(store, {
      origin: "https://codex.example",
      rpId: "codex.example",
      userName: "unix:1003",
      nodeId: "node-1",
    });
    await store.transaction((database) => {
      database.run(
        "INSERT INTO web_password VALUES (1, 'opaque-record', '2026-01-01T00:00:00.000Z')",
      );
      database.run(
        "INSERT INTO trusted_devices VALUES ('device-1', 'Old browser', ?, '2026-01-01T00:00:00.000Z', NULL)",
        [new Uint8Array(32)],
      );
    });
    const [code] = await registry.rotateRecoveryCodes();
    if (!code) throw new Error("Expected a recovery code");
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "new-passkey",
          publicKey: new Uint8Array(32),
          counter: 0,
          transports: [],
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        origin: "https://codex.example",
        rpID: "codex.example",
        aaguid: "00000000-0000-0000-0000-000000000000",
        userVerified: true,
        fmt: "none",
      },
    });

    await registry.verifyRegistration(
      {} as RegistrationResponseJSON,
      "challenge",
      {
        replaceExisting: true,
        issueRecoveryCodes: true,
        recoveryCode: code,
      },
    );

    const state = await store.read((database) => ({
      passwords: database.exec("SELECT COUNT(*) FROM web_password")[0]
        ?.values[0]?.[0],
      activeDevices: database.exec(
        "SELECT COUNT(*) FROM trusted_devices WHERE revoked_at IS NULL",
      )[0]?.values[0]?.[0],
      passkeys: database.exec("SELECT COUNT(*) FROM passkeys")[0]
        ?.values[0]?.[0],
      audits: database.exec(
        "SELECT COUNT(*) FROM audit_events WHERE kind = 'web_credentials_recovered'",
      )[0]?.values[0]?.[0],
    }));
    expect(state).toEqual({
      passwords: 0,
      activeDevices: 0,
      passkeys: 1,
      audits: 1,
    });
    await store.close();
  });

  it("exchanges a short-lived administrator handoff once and invalidates old recovery codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-admin-recovery-"));
    temporaryDirectories.push(directory);
    const store = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new PasskeyRegistry(store, {
      origin: "https://codex.example",
      rpId: "codex.example",
      userName: "alice",
      nodeId: "node-1",
    });
    const [oldCode] = await registry.rotateRecoveryCodes();
    const ticket = await registry.issueAdminRecoveryTicket("host-admin");
    await expect(registry.verifyRecoveryCode(oldCode!)).rejects.toThrow();
    const authorization = await registry.authorizeRecovery(ticket.handoffCode);
    expect(authorization.kind).toBe("admin-ticket");
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "recovered-passkey",
          publicKey: new Uint8Array(32),
          counter: 0,
          transports: [],
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        origin: "https://codex.example",
        rpID: "codex.example",
        aaguid: "00000000-0000-0000-0000-000000000000",
        userVerified: true,
        fmt: "none",
      },
    });
    await registry.verifyRegistration(
      {} as RegistrationResponseJSON,
      "challenge",
      {
        replaceExisting: true,
        issueRecoveryCodes: true,
        recoveryAuthorization: authorization,
      },
    );
    await expect(
      registry.authorizeRecovery(ticket.handoffCode),
    ).rejects.toThrow("invalid");
    await store.close();
  });
});
