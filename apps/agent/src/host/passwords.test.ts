import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { client, ready } from "@serenity-kit/opaque";
import { afterEach, describe, expect, it } from "vitest";

import {
  PasswordRegistry,
  loadOrCreateOpaqueServerSetup,
} from "./passwords.js";
import { HostStateStore } from "./state-store.js";

const temporaryDirectories: string[] = [];
const identifiers = { client: "unix:1003", server: "host-public-key" };
const keyStretching = {
  "argon2id-custom": { iterations: 1, memory: 8192, parallelism: 1 },
} as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("PasswordRegistry", () => {
  it("registers and mutually authenticates without storing the password", async () => {
    await ready;
    const directory = await temporaryDirectory();
    const keysDirectory = join(directory, "keys");
    const setup = await loadOrCreateOpaqueServerSetup(keysDirectory);
    const store = await HostStateStore.open(join(directory, "state.sqlite"));
    const registry = new PasswordRegistry(store, {
      serverSetup: setup,
      userIdentifier: "node-1",
    });

    const registration = client.startRegistration({
      password: "test-password",
    });
    const registrationResponse = await registry.createRegistrationResponse(
      registration.registrationRequest,
    );
    const finishedRegistration = client.finishRegistration({
      password: "test-password",
      clientRegistrationState: registration.clientRegistrationState,
      registrationResponse,
      identifiers,
      keyStretching,
    });
    await registry.saveRegistrationRecord(
      finishedRegistration.registrationRecord,
    );
    await expect(registry.hasPassword()).resolves.toBe(true);

    const login = client.startLogin({ password: "test-password" });
    const serverLogin = await registry.startLogin(
      login.startLoginRequest,
      identifiers,
    );
    const clientLogin = client.finishLogin({
      password: "test-password",
      clientLoginState: login.clientLoginState,
      loginResponse: serverLogin.loginResponse,
      identifiers,
      keyStretching,
    });
    expect(clientLogin).toBeDefined();
    const serverSessionKey = await registry.finishLogin(
      serverLogin.serverLoginState,
      clientLogin!.finishLoginRequest,
      identifiers,
    );
    expect(serverSessionKey).toBe(clientLogin!.sessionKey);
    expect(
      (await stat(join(keysDirectory, "opaque-server-setup"))).mode & 0o777,
    ).toBe(0o600);
    await store.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-password-test-"));
  temporaryDirectories.push(path);
  return path;
}
