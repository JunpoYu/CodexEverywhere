import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJson } from "./controller-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("administrator Controller configuration publication", () => {
  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP"])(
    "accepts a complete publication when directory fsync returns %s",
    async (code) => {
      const directory = await temporaryDirectory();
      const path = join(directory, "config.json");
      await mockNextDirectorySyncFailure(directory, code);

      await expect(
        writeJson(path, { generation: 2 }, currentOwnerOptions()),
      ).resolves.toBeUndefined();
      await expect(readJson(path)).resolves.toEqual({ generation: 2 });
    },
  );

  it("reports directory fsync EIO after publishing the complete replacement", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.json");
    await writeFile(path, '{"generation":1}\n', "utf8");
    await mockNextDirectorySyncFailure(directory, "EIO");

    await expect(
      writeJson(path, { generation: 2 }, currentOwnerOptions()),
    ).rejects.toMatchObject({ code: "EIO" });

    await expect(readJson(path)).resolves.toEqual({ generation: 2 });
    expect(await temporaryFiles(directory)).toEqual([]);
  });

  it("keeps the previous complete target when the temporary file cannot sync", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "config.json");
    await writeFile(path, '{"generation":1}\n', "utf8");
    await mockNextFileSyncFailure(directory, "EIO");

    await expect(
      writeJson(path, { generation: 2 }, currentOwnerOptions()),
    ).rejects.toMatchObject({ code: "EIO" });

    await expect(readJson(path)).resolves.toEqual({ generation: 1 });
    expect(await temporaryFiles(directory)).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-controller-config-test-"));
  temporaryDirectories.push(path);
  return path;
}

function currentOwnerOptions(): { uid: number; gid: number; mode: number } {
  return {
    uid: process.getuid?.() ?? 501,
    gid: process.getgid?.() ?? 20,
    mode: 0o600,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function temporaryFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.endsWith(".tmp"));
}

async function mockNextDirectorySyncFailure(
  directory: string,
  code: string,
): Promise<void> {
  const prototype = await fileHandlePrototype(directory);
  vi.spyOn(prototype, "sync")
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(errno(code));
}

async function mockNextFileSyncFailure(
  directory: string,
  code: string,
): Promise<void> {
  const prototype = await fileHandlePrototype(directory);
  vi.spyOn(prototype, "sync").mockRejectedValueOnce(errno(code));
}

async function fileHandlePrototype(directory: string): Promise<{
  sync(): Promise<void>;
}> {
  const sample = await open(directory, "r");
  const prototype = Object.getPrototypeOf(sample) as {
    sync(): Promise<void>;
  };
  await sample.close();
  return prototype;
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}
