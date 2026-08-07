#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function sha256File(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

export async function writeReleaseManifest({
  outputDirectory,
  version,
  commit,
  protocolVersion,
  artifactPaths,
}) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`Invalid release commit: ${commit}`);
  }
  const artifacts = {};
  for (const [component, artifactPath] of Object.entries(artifactPaths)) {
    const metadata = await stat(artifactPath);
    artifacts[component] = {
      file: basename(artifactPath),
      sha256: await sha256File(artifactPath),
      bytes: metadata.size,
    };
  }
  const manifest = {
    schemaVersion: 1,
    project: "CodexEverywhere",
    version,
    commit,
    protocolVersion,
    node: ">=20.20.0",
    artifacts,
  };
  const manifestPath = join(outputDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });

  const checksumPaths = [...Object.values(artifactPaths), manifestPath];
  const checksumLines = [];
  for (const path of checksumPaths) {
    checksumLines.push(`${await sha256File(path)}  ${basename(path)}`);
  }
  await writeFile(
    join(outputDirectory, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
    { mode: 0o644 },
  );
  return manifest;
}

async function main(argv) {
  const [outputDirectory, version, commit, protocolVersion, ...artifacts] =
    argv;
  if (
    !outputDirectory ||
    !version ||
    !commit ||
    !protocolVersion ||
    artifacts.length === 0
  ) {
    throw new Error(
      "Usage: write-manifest.mjs <output> <version> <commit> <protocol-version> <component=path>...",
    );
  }
  const artifactPaths = Object.fromEntries(
    artifacts.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid artifact mapping: ${entry}`);
      return [entry.slice(0, separator), resolve(entry.slice(separator + 1))];
    }),
  );
  await writeReleaseManifest({
    outputDirectory: resolve(outputDirectory),
    version,
    commit,
    protocolVersion: Number(protocolVersion),
    artifactPaths,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
