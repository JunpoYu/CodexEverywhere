import {
  mkdtemp,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProcessLock,
  processRecordMatches,
  processRecordUsesCurrentHostIdentity,
  readProcessRecord,
  signalRecordedProcess,
  writeProcessRecord,
} from "./process-files.js";

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
    await utimes(lockPath, new Date(0), new Date(0));
    const lock = await ProcessLock.acquire(lockPath);
    await lock.release();
  });

  it("does not let an old owner release a successor's public lock", async () => {
    const lockPath = join(await temporaryDirectory(), "agent.lock");
    const first = await ProcessLock.acquire(lockPath);
    await rename(lockPath, `${lockPath}.detached-first-owner`);
    const successor = await ProcessLock.acquire(lockPath);

    await first.release();

    await expect(ProcessLock.acquire(lockPath)).rejects.toThrow(
      "already running",
    );
    await successor.release();
  });

  it("binds Linux records to the process start time instead of the PID alone", async () => {
    const recordPath = join(await temporaryDirectory(), "agent.pid");
    await writeProcessRecord(recordPath);
    const record = await readProcessRecord(recordPath);
    expect(record).toBeDefined();
    expect(record?.host).toBe(hostname());
    await expect(processRecordMatches(record!)).resolves.toBe(true);
    await expect(processRecordUsesCurrentHostIdentity(record!)).resolves.toBe(
      true,
    );
    await expect(
      processRecordMatches({ ...record!, host: "foreign-login-node" }),
    ).resolves.toBe(false);
    await expect(
      processRecordUsesCurrentHostIdentity({
        ...record!,
        bootId: "foreign-boot",
      }),
    ).resolves.toBe(false);
    if (process.platform === "linux") {
      expect(record).toMatchObject({
        uid: process.getuid?.(),
        procStartTime: expect.any(String),
        bootId: expect.any(String),
        cmdline: expect.any(Array),
      });
      await expect(
        processRecordMatches({ ...record!, procStartTime: "recycled" }),
      ).resolves.toBe(false);
      await expect(
        signalRecordedProcess(
          { ...record!, procStartTime: "recycled" },
          "SIGTERM",
        ),
      ).rejects.toThrow("Refusing to signal");
      await expect(
        signalRecordedProcess(
          { pid: record!.pid, startedAt: record!.startedAt },
          "SIGTERM",
        ),
      ).rejects.toThrow("Refusing to signal");
    }
  });

  it("keeps the previous complete record when publication is interrupted", async () => {
    const directory = await temporaryDirectory();
    const recordPath = join(directory, "agent.pid");
    const previous = await writeProcessRecord(recordPath);

    await expect(
      writeProcessRecord(recordPath, process.pid, {
        beforePublish: async (temporaryPath) => {
          // Simulate a writer dying after its private temp file was truncated.
          await writeFile(temporaryPath, "{", "utf8");
          await expect(readProcessRecord(recordPath)).resolves.toEqual(
            previous,
          );
          throw new Error("injected publication failure");
        },
      }),
    ).rejects.toThrow("injected publication failure");

    await expect(readProcessRecord(recordPath)).resolves.toEqual(previous);
    expect(
      (await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
    ).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ce-lock-test-"));
  temporaryDirectories.push(path);
  return path;
}
