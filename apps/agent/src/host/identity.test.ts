import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreateHostIdentity } from "./identity.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("host identity", () => {
  it("creates a private stable Noise static identity", async () => {
    const keysDirectory = join(await temporaryDirectory(), "keys");
    const first = await loadOrCreateHostIdentity(keysDirectory);
    const second = await loadOrCreateHostIdentity(keysDirectory);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.keyPair.publicKey).toEqual(first.keyPair.publicKey);
    expect(second.keyPair.secretKey).toEqual(first.keyPair.secretKey);
    expect(
      (await stat(join(keysDirectory, "identity.json"))).mode & 0o777,
    ).toBe(0o600);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-identity-test-"));
  temporaryDirectories.push(path);
  return path;
}
