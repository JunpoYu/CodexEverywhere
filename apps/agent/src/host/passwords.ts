import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { ready, server } from "@serenity-kit/opaque";

import type { HostStateStore } from "./state-store.js";

export type OpaqueIdentifiers = {
  client: string;
  server: string;
};

export class PasswordRegistry {
  readonly #state: HostStateStore;
  readonly #serverSetup: string;
  readonly #userIdentifier: string;

  constructor(
    state: HostStateStore,
    options: { serverSetup: string; userIdentifier: string },
  ) {
    this.#state = state;
    this.#serverSetup = options.serverSetup;
    this.#userIdentifier = options.userIdentifier;
  }

  hasPassword(): Promise<boolean> {
    return this.#state.read((database) => {
      const result = database.exec("SELECT COUNT(*) FROM web_password");
      return Number(result[0]?.values[0]?.[0] ?? 0) > 0;
    });
  }

  async createRegistrationResponse(
    registrationRequest: string,
  ): Promise<string> {
    await ready;
    return server.createRegistrationResponse({
      serverSetup: this.#serverSetup,
      userIdentifier: this.#userIdentifier,
      registrationRequest,
    }).registrationResponse;
  }

  saveRegistrationRecord(registrationRecord: string): Promise<void> {
    if (registrationRecord.length < 1 || registrationRecord.length > 16_384)
      throw new Error("Invalid password registration record");
    return this.#state.transaction((database) => {
      database.run("DELETE FROM web_password");
      database.run(
        "INSERT INTO web_password (id, registration_record, updated_at) VALUES (1, ?, ?)",
        [registrationRecord, new Date().toISOString()],
      );
    });
  }

  async startLogin(
    startLoginRequest: string,
    identifiers: OpaqueIdentifiers,
  ): Promise<{ serverLoginState: string; loginResponse: string }> {
    await ready;
    const registrationRecord = await this.#registrationRecord();
    return server.startLogin({
      serverSetup: this.#serverSetup,
      userIdentifier: this.#userIdentifier,
      registrationRecord,
      startLoginRequest,
      identifiers,
    });
  }

  async finishLogin(
    serverLoginState: string,
    finishLoginRequest: string,
    identifiers: OpaqueIdentifiers,
  ): Promise<string> {
    await ready;
    return server.finishLogin({
      serverLoginState,
      finishLoginRequest,
      identifiers,
    }).sessionKey;
  }

  async #registrationRecord(): Promise<string | null> {
    return this.#state.read((database) => {
      const statement = database.prepare(
        "SELECT registration_record FROM web_password WHERE id = 1",
      );
      try {
        if (!statement.step()) return null;
        const value = statement.get()[0];
        return typeof value === "string" ? value : null;
      } finally {
        statement.free();
      }
    });
  }
}

export async function loadOrCreateOpaqueServerSetup(
  keysDirectory: string,
): Promise<string> {
  await ready;
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  await chmod(keysDirectory, 0o700);
  const path = join(keysDirectory, "opaque-server-setup");
  try {
    return validateSetup((await readFile(path, "utf8")).trim());
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  const setup = server.createSetup();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${setup}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    if (isCode(error, "EEXIST"))
      return validateSetup((await readFile(path, "utf8")).trim());
    throw error;
  }
  return setup;
}

function validateSetup(value: string): string {
  if (value.length < 100 || value.length > 512)
    throw new Error("Invalid OPAQUE server setup");
  server.getPublicKey(value);
  return value;
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
