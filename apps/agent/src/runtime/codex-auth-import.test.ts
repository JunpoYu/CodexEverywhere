import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  importCodexAuthFile,
  MAX_CODEX_AUTH_BYTES,
  normalizeCodexAuth,
} from "./codex-auth-import.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("importCodexAuthFile", () => {
  it("atomically writes a private auth.json inside the current user home", async () => {
    const home = await temporaryDirectory();
    const result = await importCodexAuthFile({
      userHome: home,
      content: '{"tokens":{"access_token":"secret"}}',
    });

    const authPath = join(home, ".codex", "auth.json");
    expect(result).toEqual({ replacedExisting: false });
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      tokens: { access_token: "secret" },
    });
    expect((await stat(join(home, ".codex"))).mode & 0o777).toBe(0o700);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(home, ".codex"))).isSymbolicLink()).toBe(false);
  });

  it("reports replacement without leaving plaintext temporary files", async () => {
    const home = await temporaryDirectory();
    await mkdir(join(home, ".codex"));
    await writeFile(join(home, ".codex", "auth.json"), '{"old":true}');

    await expect(
      importCodexAuthFile({ userHome: home, content: '{"new":true}' }),
    ).resolves.toEqual({ replacedExisting: true });
    expect(await readFile(join(home, ".codex", "auth.json"), "utf8")).toBe(
      '{\n  "new": true\n}\n',
    );
  });

  it("rejects invalid, oversized, and symlinked auth destinations", async () => {
    expect(() => normalizeCodexAuth("[]")).toThrow("JSON object");
    expect(() => normalizeCodexAuth("{")).toThrow("valid JSON");
    expect(() =>
      normalizeCodexAuth("x".repeat(MAX_CODEX_AUTH_BYTES + 1)),
    ).toThrow("256 KiB");

    const base = await temporaryDirectory();
    const home = join(base, "home");
    const outside = join(base, "outside");
    await mkdir(home);
    await mkdir(outside);
    await symlink(outside, join(home, ".codex"));
    await expect(
      importCodexAuthFile({ userHome: home, content: '{"tokens":{}}' }),
    ).rejects.toThrow("regular directory");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-auth-import-"));
  directories.push(path);
  return path;
}
