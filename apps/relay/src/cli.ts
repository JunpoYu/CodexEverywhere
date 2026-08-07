#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Command } from "commander";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueRouteCapability,
  relayKeyFingerprint,
} from "./capability.js";
import { RelayServer } from "./relay-server.js";

const program = new Command();
const relayHome =
  process.env.CE_RELAY_HOME ?? join(homedir(), ".codex-everywhere-relay");
const signingKeyFile = join(relayHome, "signing.key");

program
  .name("ce-relay")
  .description("Stateless ciphertext relay for CodexEverywhere")
  .version(packageVersion());

function packageVersion(): string {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    value &&
    typeof value === "object" &&
    "version" in value &&
    typeof value.version === "string"
  )
    return value.version;
  throw new Error("Relay package version is missing");
}

program
  .command("init")
  .description("Create the Relay signing key")
  .action(async () => {
    const key = await loadOrCreateSigningKey();
    process.stdout.write(
      `Relay initialized\nFingerprint: ${relayKeyFingerprint(key)}\nState: ${relayHome}\n`,
    );
  });

program
  .command("issue-provisioner")
  .requiredOption(
    "--installation-id <id>",
    "Stable ID of the authorized CodexEverywhere host installation",
  )
  .requiredOption(
    "--expires-days <days>",
    "Host provisioner lifetime in days",
    parsePositiveNumber,
  )
  .description("Issue one root-only credential for Unix-user self-service")
  .action(async (options: { installationId: string; expiresDays: number }) => {
    const credential = issueHostProvisionerCredential(await loadSigningKey(), {
      installationId: options.installationId,
      expiresAt: new Date(Date.now() + options.expiresDays * 86_400_000),
    });
    process.stdout.write(`${JSON.stringify(credential, null, 2)}\n`);
  });

program
  .command("issue-route")
  .option(
    "--expires-days <days>",
    "Capability lifetime in days",
    parsePositiveNumber,
  )
  .option(
    "--login-name <name>",
    "Existing HPC SSH/Unix username used to find this Agent, for example alice",
  )
  .option(
    "--route-id <route-id>",
    "Reissue a capability for an existing route ID",
  )
  .description("Issue a self-contained Agent route capability")
  .action(
    async (options: {
      expiresDays?: number;
      loginName?: string;
      routeId?: string;
    }) => {
      const key = await loadSigningKey();
      const expiresAt = options.expiresDays
        ? new Date(Date.now() + options.expiresDays * 86_400_000)
        : undefined;
      const issued = issueRouteCapability(key, {
        ...(expiresAt ? { expiresAt } : {}),
        ...(options.loginName ? { loginName: options.loginName } : {}),
        ...(options.routeId ? { routeId: options.routeId } : {}),
      });
      process.stdout.write(
        `${JSON.stringify({ ...issued.payload, capability: issued.capability }, null, 2)}\n`,
      );
    },
  );

program
  .command("inspect-key")
  .description("Print the Relay key fingerprint")
  .action(async () => {
    process.stdout.write(`${relayKeyFingerprint(await loadSigningKey())}\n`);
  });

program
  .command("serve")
  .option("--host <host>", "Bind address", "127.0.0.1")
  .option("--port <port>", "Bind port", parsePort, 7346)
  .description("Run the in-memory Relay")
  .action(async (options: { host: string; port: number }) => {
    const relay = await RelayServer.start({
      host: options.host,
      port: options.port,
      signingKey: await loadSigningKey(),
    });
    process.stdout.write(
      `Relay listening on ws://${options.host}:${relay.port}\n`,
    );
    await waitForShutdownSignal();
    await relay.close();
  });

await program.parseAsync();

async function loadOrCreateSigningKey(): Promise<Uint8Array> {
  try {
    return await loadSigningKey();
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const key = generateRelaySigningKey();
  await writePrivateFile(
    signingKeyFile,
    `${Buffer.from(key).toString("base64url")}\n`,
  );
  return key;
}

async function loadSigningKey(): Promise<Uint8Array> {
  const value = Buffer.from(
    (await readFile(signingKeyFile, "utf8")).trim(),
    "base64url",
  );
  if (value.byteLength !== 32)
    throw new Error(`Invalid Relay signing key: ${signingKeyFile}`);
  return value;
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Invalid port: ${value}`);
  return port;
}

function parsePositiveNumber(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`Invalid positive number: ${value}`);
  return number;
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGTERM", finish);
      process.off("SIGINT", finish);
      resolve();
    };
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
  });
}
