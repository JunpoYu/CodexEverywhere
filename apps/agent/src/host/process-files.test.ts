import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessLock } from "./process-files.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("ProcessLock", () => {
  it("rejects a second live owner", async () => {
    const lockPath = join(await temporaryDirectory(), "agent.lock");
    const lock = await ProcessLock.acquire(lockPath);
    await expect(ProcessLock.acquire(lockPath)).rejects.toThrow(
      "already running",
    );
    await lock.release();
  });

  it("reclaims a stale or malformed lock", async () => {
    const lockPath = join(await temporaryDirectory(), "agent.lock");
    await writeFile(lockPath, "not-json", { mode: 0o600 });
    const lock = await ProcessLock.acquire(lockPath);
    await lock.release();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-lock-test-"));
  temporaryDirectories.push(path);
  return path;
}
