import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const manager = resolve(
  import.meta.dirname,
  "../../../scripts/manage-v0.4-staging-receipt.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("v0.4 staging receipt", () => {
  it("initializes a private, non-passing receipt", async () => {
    const path = await initializeReceipt();
    const receipt = JSON.parse(await readFile(path, "utf8"));

    expect(receipt).toMatchObject({
      version: 1,
      kind: "codex-everywhere-v0.4-staging",
      status: "in-progress",
      environment: { testUserCount: 0, adminControlPlane: false },
      checks: { "environment.clock-synchronized": false },
    });
    expect(Object.values(receipt.checks)).not.toContain(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("accepts a complete receipt containing only hashes and bounded metadata", async () => {
    const path = await initializeReceipt();
    await writePassingReceipt(path);

    const { stdout } = await execFileAsync(process.execPath, [
      manager,
      "validate",
      path,
    ]);
    expect(stdout).toContain("Staging receipt passed");
  });

  it("rejects a receipt without a real staging user", async () => {
    const path = await initializeReceipt();
    await writePassingReceipt(path, { testUserCount: 0 });

    await expect(
      execFileAsync(process.execPath, [manager, "validate", path]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("at least one test user"),
    });
  });

  it("rejects an ambiguous admin control-plane flag", async () => {
    const path = await initializeReceipt();
    await writePassingReceipt(path, { adminControlPlane: "false" });

    await expect(
      execFileAsync(process.execPath, [manager, "validate", path]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("adminControlPlane must be a boolean"),
    });
  });

  it("rejects incomplete or extensible receipts", async () => {
    const path = await initializeReceipt();
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.unboundedNotes = "must not be accepted";
    await writeFile(path, `${JSON.stringify(receipt)}\n`);

    await expect(
      execFileAsync(process.execPath, [manager, "validate", path]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("missing or unknown fields"),
    });
  });

  it("rejects a receipt readable by other users", async () => {
    const path = await initializeReceipt();
    await chmod(path, 0o644);

    await expect(
      execFileAsync(process.execPath, [manager, "validate", path]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("mode 0600"),
    });
  });

  it("binds staging evidence to the current checkout commit", async () => {
    const path = await initializeReceipt();
    const receipt = JSON.parse(await readFile(path, "utf8"));
    receipt.releaseCommit = "0".repeat(40);
    await writeFile(path, `${JSON.stringify(receipt)}\n`);

    await expect(
      execFileAsync(process.execPath, [manager, "validate", path]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("does not match the current checkout"),
    });
  });
});

async function initializeReceipt(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ce-staging-receipt-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "receipt.json");
  await execFileAsync(process.execPath, [manager, "--", "init", path]);
  return path;
}

async function writePassingReceipt(
  path: string,
  environment: Record<string, unknown> = {},
): Promise<void> {
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.operatorAlias = "operator-a";
  receipt.completedAt = new Date(
    Date.parse(receipt.startedAt) + 1_000,
  ).toISOString();
  receipt.status = "passed";
  receipt.environment = {
    ...receipt.environment,
    testUserCount: 1,
    adminControlPlane: false,
    ...environment,
  };
  receipt.evidence = {
    manifestSha256: hash("1"),
    candidateReceiptSha256: hash("2"),
  };
  for (const check of Object.keys(receipt.checks)) receipt.checks[check] = true;
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  await chmod(path, 0o600);
}

function hash(character: string): string {
  return character.repeat(64);
}
