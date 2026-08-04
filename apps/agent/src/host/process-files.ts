import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";

export type ProcessRecord = { pid: number; startedAt: string };

export class ProcessLock {
  readonly #path: string;
  readonly #quarantinePath: string | undefined;
  #released = false;

  private constructor(path: string, quarantinePath?: string) {
    this.#path = path;
    this.#quarantinePath = quarantinePath;
  }

  static async acquire(path: string): Promise<ProcessLock> {
    try {
      await createExclusiveRecord(path);
      return new ProcessLock(path);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const owner = await readProcessRecord(path);
    if (owner && isProcessAlive(owner.pid)) {
      throw new Error(
        `CodexEverywhere agent is already running (PID ${owner.pid})`,
      );
    }

    const quarantinePath = `${path}.stale.${randomUUID()}`;
    try {
      await rename(path, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return ProcessLock.acquire(path);
      throw error;
    }
    try {
      await createExclusiveRecord(path);
      return new ProcessLock(path, quarantinePath);
    } catch (error) {
      await rm(quarantinePath, { force: true });
      if (isAlreadyExists(error)) return ProcessLock.acquire(path);
      throw error;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await rm(this.#path, { force: true });
    if (this.#quarantinePath) await rm(this.#quarantinePath, { force: true });
  }
}

export async function writeProcessRecord(
  path: string,
  pid = process.pid,
): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readProcessRecord(
  path: string,
): Promise<ProcessRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      value &&
      typeof value === "object" &&
      Number.isSafeInteger((value as ProcessRecord).pid) &&
      (value as ProcessRecord).pid > 0 &&
      typeof (value as ProcessRecord).startedAt === "string"
    ) {
      return value as ProcessRecord;
    }
    return undefined;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    );
  }
}

async function createExclusiveRecord(path: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isCode(error, "EEXIST");
}

function isMissing(error: unknown): boolean {
  return isCode(error, "ENOENT");
}

function isCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
