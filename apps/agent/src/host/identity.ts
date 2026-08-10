import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  generateStaticKeyPair,
  type StaticKeyPair,
} from "@codex-everywhere/crypto";

import { syncDirectoryForDurability } from "./durable-file.js";

export type HostIdentity = {
  keyPair: StaticKeyPair;
  fingerprint: string;
};

export async function loadOrCreateHostIdentity(
  keysDirectory: string,
): Promise<HostIdentity> {
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  await chmod(keysDirectory, 0o700);
  const path = join(keysDirectory, "identity.json");
  try {
    return decodeIdentity(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const keyPair = generateStaticKeyPair();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({
        version: 1,
        publicKey: Buffer.from(keyPair.publicKey).toString("base64url"),
        secretKey: Buffer.from(keyPair.secretKey).toString("base64url"),
      })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await rm(temporary);
    await syncDirectoryForDurability(keysDirectory);
  } catch (error) {
    await rm(temporary, { force: true });
    if (isAlreadyExists(error))
      return decodeIdentity(await readFile(path, "utf8"));
    throw error;
  }
  return identityFromKeyPair(keyPair);
}

function decodeIdentity(raw: string): HostIdentity {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object")
    throw new Error("Invalid host identity file");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.publicKey !== "string" ||
    typeof record.secretKey !== "string"
  ) {
    throw new Error("Invalid host identity file");
  }
  const keyPair = {
    publicKey: Buffer.from(record.publicKey, "base64url"),
    secretKey: Buffer.from(record.secretKey, "base64url"),
  };
  if (
    keyPair.publicKey.byteLength !== 32 ||
    keyPair.secretKey.byteLength !== 32
  ) {
    throw new Error("Invalid host identity key length");
  }
  return identityFromKeyPair(keyPair);
}

function identityFromKeyPair(keyPair: StaticKeyPair): HostIdentity {
  const digest = createHash("sha256")
    .update(keyPair.publicKey)
    .digest("base64url");
  return { keyPair, fingerprint: `sha256:${digest}` };
}

function isMissing(error: unknown): boolean {
  return isCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isCode(error, "EEXIST");
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
