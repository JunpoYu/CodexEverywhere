#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const INVENTORY_SCHEMA_VERSION = 1;
const INVENTORY_FILE = "release-inventory.json";

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function regularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return metadata;
}

async function readJson(path, label) {
  await regularFile(path, label);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function validateVerifiedMetadata(root, releaseId) {
  const manifestPath = join(root, "release-manifest.json");
  const buildInfoPath = join(root, "build-info.json");
  const manifest = await readJson(manifestPath, "Release manifest");
  const build = await readJson(buildInfoPath, "Agent build metadata");
  const agent =
    record(manifest) && record(manifest.artifacts)
      ? manifest.artifacts.agent
      : undefined;
  if (
    !record(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.project !== "CodexEverywhere" ||
    manifest.version !== releaseId ||
    !/^[0-9a-f]{40}$/.test(manifest.commit) ||
    manifest.protocolVersion !== 1 ||
    manifest.node !== ">=20.20.0" ||
    !record(agent) ||
    agent.file !== `codex-everywhere-agent-${releaseId}.tar.gz` ||
    !/^[0-9a-f]{64}$/.test(agent.sha256) ||
    !Number.isSafeInteger(agent.bytes) ||
    agent.bytes <= 0
  ) {
    throw new Error("Release manifest does not describe a verified Agent");
  }
  if (
    !record(build) ||
    build.schemaVersion !== 1 ||
    build.version !== manifest.version ||
    build.commit !== manifest.commit ||
    build.protocolVersion !== manifest.protocolVersion
  ) {
    throw new Error("Agent build metadata does not match release manifest");
  }
  return {
    manifestSha256: await sha256File(manifestPath),
    buildInfoSha256: await sha256File(buildInfoPath),
  };
}

async function optionalFileHash(path, label) {
  try {
    await regularFile(path, label);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} is missing`)
      return null;
    throw error;
  }
  return sha256File(path);
}

async function collectEntries(root) {
  const entries = [];
  async function walk(parts) {
    const directory = join(root, ...parts);
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const relativeParts = [...parts, name];
      const relativePath = relativeParts.join("/");
      if (relativePath === INVENTORY_FILE) continue;
      const path = join(root, ...relativeParts);
      const metadata = await lstat(path);
      const mode = metadata.mode & 0o7777;
      if (metadata.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode });
        await walk(relativeParts);
      } else if (metadata.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          mode,
          bytes: metadata.size,
          sha256: await sha256File(path),
        });
      } else if (metadata.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: "symlink",
          target: await readlink(path),
        });
      } else {
        throw new Error(`Unsupported release entry: ${relativePath}`);
      }
    }
  }
  await walk([]);
  return entries;
}

function portableEntries(entries) {
  return entries.map((entry) => {
    if (!record(entry) || entry.type !== "symlink") return entry;
    // Symlink mode bits are not meaningful on Linux and differ between
    // filesystems (for example, Parastor may report 0755 while XFS reports
    // 0777 for the same link). Older inventories recorded that value, so
    // ignore it during verification while continuing to compare the link
    // path and target exactly.
    const { mode: _ignoredMode, ...portableEntry } = entry;
    return portableEntry;
  });
}

async function validateReleaseId(root, releaseId) {
  const path = join(root, "release-id");
  await regularFile(path, "Release ID");
  if ((await readFile(path, "utf8")) !== `${releaseId}\n`) {
    throw new Error("Release ID does not match its directory");
  }
}

async function createInventory(root, releaseId, releaseKind, outputPath) {
  if (releaseKind !== "verified" && releaseKind !== "development") {
    throw new Error("Release kind must be verified or development");
  }
  await validateReleaseId(root, releaseId);
  let metadata;
  if (releaseKind === "verified") {
    metadata = await validateVerifiedMetadata(root, releaseId);
  } else {
    metadata = {
      manifestSha256: await optionalFileHash(
        join(root, "release-manifest.json"),
        "Release manifest",
      ),
      buildInfoSha256: await optionalFileHash(
        join(root, "build-info.json"),
        "Agent build metadata",
      ),
    };
  }
  const inventory = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    releaseId,
    releaseKind,
    rootMode: (await lstat(root)).mode & 0o7777,
    ...metadata,
    entries: await collectEntries(root),
  };
  // File creation modes are filtered through the caller's umask. Staging and
  // migration workflows intentionally use umask 077, while this inventory is
  // non-secret release metadata whose verifier requires an exact 0644 mode.
  // Publish it privately first, then normalize through the same open handle so
  // a path replacement cannot redirect chmod between creation and publication.
  const output = await open(outputPath, "wx", 0o600);
  try {
    await output.writeFile(`${JSON.stringify(inventory, null, 2)}\n`);
    await output.chmod(0o644);
  } finally {
    await output.close();
  }
}

async function verifyInventory(root, releaseId, requiredKind) {
  if (requiredKind !== "verified" && requiredKind !== "any") {
    throw new Error("Required release kind must be verified or any");
  }
  await validateReleaseId(root, releaseId);
  const inventoryPath = join(root, INVENTORY_FILE);
  const inventoryMetadata = await regularFile(
    inventoryPath,
    "Release inventory",
  );
  if ((inventoryMetadata.mode & 0o7777) !== 0o644) {
    throw new Error("Release inventory permissions are invalid");
  }
  const inventory = await readJson(inventoryPath, "Release inventory");
  const rootMode = (await lstat(root)).mode & 0o7777;
  if (
    !record(inventory) ||
    inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION ||
    inventory.releaseId !== releaseId ||
    inventory.rootMode !== rootMode ||
    (inventory.releaseKind !== "verified" &&
      inventory.releaseKind !== "development") ||
    !Array.isArray(inventory.entries) ||
    (requiredKind === "verified" && inventory.releaseKind !== "verified")
  ) {
    throw new Error("Release inventory identity or kind is invalid");
  }

  let metadata;
  if (inventory.releaseKind === "verified") {
    metadata = await validateVerifiedMetadata(root, releaseId);
  } else {
    metadata = {
      manifestSha256: await optionalFileHash(
        join(root, "release-manifest.json"),
        "Release manifest",
      ),
      buildInfoSha256: await optionalFileHash(
        join(root, "build-info.json"),
        "Agent build metadata",
      ),
    };
  }
  if (
    inventory.manifestSha256 !== metadata.manifestSha256 ||
    inventory.buildInfoSha256 !== metadata.buildInfoSha256
  ) {
    throw new Error("Release metadata digest does not match inventory");
  }
  const actualEntries = await collectEntries(root);
  if (
    JSON.stringify(portableEntries(inventory.entries)) !==
    JSON.stringify(portableEntries(actualEntries))
  ) {
    throw new Error("Installed release content does not match inventory");
  }
}

async function main() {
  const [command, root, releaseId, kind, outputPath] = process.argv.slice(2);
  if (!root || !releaseId || !kind) {
    throw new Error(
      "Usage: verify-rootless-release.mjs create <root> <release-id> <kind> <output> | verify <root> <release-id> <required-kind>",
    );
  }
  if (command === "create" && outputPath) {
    await createInventory(root, releaseId, kind, outputPath);
    return;
  }
  if (command === "verify" && outputPath === undefined) {
    await verifyInventory(root, releaseId, kind);
    return;
  }
  throw new Error("Invalid release inventory command");
}

main().catch((error) => {
  process.stderr.write(
    `Release inventory error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
