import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const installer = new URL(
  "../../../deploy/hpc/install-rootless-agent.sh",
  import.meta.url,
).pathname;
const activator = new URL(
  "../../../deploy/hpc/activate-rootless-release.sh",
  import.meta.url,
).pathname;
const releaseInstaller = new URL(
  "../../../deploy/hpc/install-release.sh",
  import.meta.url,
).pathname;
const inventoryVerifier = new URL(
  "../../../deploy/hpc/verify-rootless-release.mjs",
  import.meta.url,
).pathname;
const rootlessGlobalShim = new URL(
  "../../../deploy/hpc/install-rootless-global-shim.sh",
  import.meta.url,
).pathname;
const sharedInstaller = new URL(
  "../../../deploy/hpc/install-shared-agent.sh",
  import.meta.url,
).pathname;
const releaseAssetPreparer = new URL(
  "../../../deploy/release/prepare-release-assets.sh",
  import.meta.url,
).pathname;

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("rootless release activation", () => {
  it("ships bootstrap tools and separates root from deployment-account code", async () => {
    const [shim, shared, assets, rootlessRuntime, sharedRuntime] =
      await Promise.all([
        readFile(rootlessGlobalShim, "utf8"),
        readFile(sharedInstaller, "utf8"),
        readFile(releaseAssetPreparer, "utf8"),
        readFile(
          new URL(
            "../../../deploy/hpc/create-rootless-runtime.sh",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../../../deploy/hpc/create-shared-runtime.sh",
            import.meta.url,
          ),
          "utf8",
        ),
      ]);

    expect(shared).toContain('mv "$root_cli" "$install_root/bin/ce"');
    expect(shared).toContain('mv -Tf "$current_link" "$install_root/current"');
    expect(shared).toContain(
      'mv -Tf "$active_release" "$install_root/active-release"',
    );
    expect(shim).toContain("exec '$root_cli' \"\\$@\"");
    expect(shim).toContain("exec '$install_root/bin/ce' \"\\$@\"");
    expect(shim).toContain("Root CLI must be owned by root");
    expect(shim).toContain("assert_root_owned_directory_chain");
    for (const runtimeInstaller of [rootlessRuntime, sharedRuntime]) {
      expect(runtimeInstaller).toContain(
        "create --yes --override-channels --channel conda-forge",
      );
    }

    for (const requiredTool of [
      "create-rootless-runtime.sh",
      "create-shared-runtime.sh",
      "activate-shared-release.sh",
      "install-release.sh",
      "install-rootless-agent.sh",
      "install-rootless-global-shim.sh",
      "install-shared-agent.sh",
      "activate-rootless-release.sh",
      "verify-rootless-release.mjs",
    ]) {
      expect(assets).toContain(`deploy/hpc/${requiredTool}`);
    }
    expect(assets).toContain("packages/kernel/package.json");
  });

  it("records and verifies every installed release entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-release-inventory-"));
    temporaryDirectories.push(directory);
    const release = await fakeVerifiedBundle(
      directory,
      "release",
      "v1",
      "a".repeat(40),
    );
    await writeFile(join(release.bundle, "release-id"), "v1\n");
    await writeFile(
      join(release.bundle, "release-manifest.json"),
      await readFile(release.manifest),
    );
    await symlink("cli.js", join(release.bundle, "dist", "cli-link.js"));
    const inventory = join(directory, "inventory.json");

    const created = runNodeWithPrivateUmaskResult([
      inventoryVerifier,
      "create",
      release.bundle,
      "v1",
      "verified",
      inventory,
    ]);
    expect(created.status, created.stderr).toBe(0);
    expect((await lstat(inventory)).mode & 0o777).toBe(0o644);
    const createdInventory = JSON.parse(await readFile(inventory, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    const symlinkEntry = createdInventory.entries.find(
      (entry) => entry.path === "dist/cli-link.js",
    );
    expect(symlinkEntry).toEqual({
      path: "dist/cli-link.js",
      type: "symlink",
      target: "cli.js",
    });

    // schema v1 inventories created on Parastor recorded a filesystem-specific
    // symlink mode. A root-owned XFS copy must remain verifiable because only
    // the link path and target carry security meaning.
    if (!symlinkEntry) throw new Error("Expected symlink inventory entry");
    symlinkEntry.mode = 0o755;
    await writeFile(
      inventory,
      `${JSON.stringify(createdInventory, null, 2)}\n`,
    );
    await rename(inventory, join(release.bundle, "release-inventory.json"));
    const verified = runNodeResult([
      inventoryVerifier,
      "verify",
      release.bundle,
      "v1",
      "verified",
    ]);
    expect(verified.status, verified.stderr).toBe(0);

    await writeFile(join(release.bundle, "dist", "cli.js"), "modified\n");
    const modified = runNodeResult([
      inventoryVerifier,
      "verify",
      release.bundle,
      "v1",
      "verified",
    ]);
    expect(modified.status).not.toBe(0);
    expect(modified.stderr).toContain(
      "Installed release content does not match inventory",
    );

    await writeFile(
      join(release.bundle, "dist", "cli.js"),
      "#!/usr/bin/env node\n",
    );
    await chmod(release.bundle, 0o777);
    const unsafeRootMode = runNodeResult([
      inventoryVerifier,
      "verify",
      release.bundle,
      "v1",
      "verified",
    ]);
    expect(unsafeRootMode.status).not.toBe(0);
    expect(unsafeRootMode.stderr).toContain(
      "Release inventory identity or kind is invalid",
    );
  });

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "keeps executable and inventory on one atomic current pointer",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "ce-release-install-"));
      temporaryDirectories.push(directory);
      const installRoot = join(directory, "install");
      const runtime = join(directory, "runtime");
      await realNodeRuntime(runtime);
      const releaseOne = await fakeVerifiedBundle(
        directory,
        "bundle-one",
        "v1",
        "a".repeat(40),
      );
      const releaseTwo = await fakeVerifiedBundle(
        directory,
        "bundle-two",
        "v2",
        "b".repeat(40),
      );

      run(installer, [
        releaseOne.bundle,
        "v1",
        installRoot,
        runtime,
        releaseOne.manifest,
        "verified",
      ]);
      await expect(readlink(join(installRoot, "current"))).resolves.toBe(
        "releases/v1",
      );
      await expect(
        readFile(join(installRoot, "active-release"), "utf8"),
      ).resolves.toBe("v1\n");
      expect(
        (await lstat(join(installRoot, "active-release"))).isSymbolicLink(),
      ).toBe(true);

      // Retrying a release whose complete directory already exists is safe.
      const releaseOneRetry = await fakeVerifiedBundle(
        directory,
        "bundle-one-retry",
        "v1",
        "a".repeat(40),
      );
      run(installer, [
        releaseOneRetry.bundle,
        "v1",
        installRoot,
        runtime,
        releaseOneRetry.manifest,
        "verified",
      ]);

      run(installer, [
        releaseTwo.bundle,
        "v2",
        installRoot,
        runtime,
        releaseTwo.manifest,
        "verified",
      ]);
      await expect(
        readFile(join(installRoot, "active-release"), "utf8"),
      ).resolves.toBe("v2\n");

      run(activator, ["v1", installRoot, runtime]);
      await expect(readlink(join(installRoot, "current"))).resolves.toBe(
        "releases/v1",
      );
      await expect(
        readFile(join(installRoot, "active-release"), "utf8"),
      ).resolves.toBe("v1\n");
    },
  );

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "rejects forged, development, and modified rollback targets by default",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "ce-release-reject-"));
      temporaryDirectories.push(directory);
      const installRoot = join(directory, "install");
      const runtime = join(directory, "runtime");
      await realNodeRuntime(runtime);

      const verified = await fakeVerifiedBundle(
        directory,
        "verified",
        "v1",
        "a".repeat(40),
      );
      run(installer, [
        verified.bundle,
        "v1",
        installRoot,
        runtime,
        verified.manifest,
        "verified",
      ]);
      await writeFile(
        join(installRoot, "releases", "v1", "dist", "cli.js"),
        "#!/usr/bin/env node\n// modified\n",
      );
      const modified = runResult(activator, ["v1", installRoot, runtime]);
      expect(modified.status).not.toBe(0);
      expect(modified.stderr).toContain(
        "Installed release content does not match inventory",
      );

      const retry = await fakeVerifiedBundle(
        directory,
        "verified-retry",
        "v1",
        "a".repeat(40),
      );
      const modifiedRetry = runResult(installer, [
        retry.bundle,
        "v1",
        installRoot,
        runtime,
        retry.manifest,
        "verified",
      ]);
      expect(modifiedRetry.status).not.toBe(0);
      expect(modifiedRetry.stderr).toContain(
        "Installed release content does not match inventory",
      );

      const development = await fakeBundle(directory, "development");
      run(installer, [development, "dev", installRoot, runtime]);
      const strictDevelopment = runResult(activator, [
        "dev",
        installRoot,
        runtime,
      ]);
      expect(strictDevelopment.status).not.toBe(0);
      expect(strictDevelopment.stderr).toContain("identity or kind is invalid");
      run(activator, ["dev", installRoot, runtime, "--allow-development"]);

      const forgedDirectory = join(installRoot, "releases", "forged", "dist");
      await mkdir(forgedDirectory, { recursive: true });
      await writeFile(join(forgedDirectory, "cli.js"), "forged\n");
      const forged = runResult(activator, ["forged", installRoot, runtime]);
      expect(forged.status).not.toBe(0);
      expect(forged.stderr).toContain("Release ID is missing");
      await expect(
        lstat(join(installRoot, "releases", "forged", "release-id")),
      ).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
    "requires an independent trust root before consuming a release",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "ce-release-download-"));
      temporaryDirectories.push(directory);
      const fixture = join(directory, "fixture");
      const fakeBin = join(directory, "fake-bin");
      const archiveRoot = join(directory, "archive");
      const runtime = join(directory, "runtime");
      const installRoot = join(directory, "install");
      const version = "v1.2.3-alpha.1";
      const commit = "a".repeat(40);
      const assetName = `codex-everywhere-agent-${version}.tar.gz`;
      await mkdir(join(archiveRoot, "agent", "dist"), { recursive: true });
      await mkdir(fixture, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await realNodeRuntime(runtime);
      await writeFile(
        join(archiveRoot, "agent", "dist", "cli.js"),
        "#!/usr/bin/env node\n",
      );
      await writeFile(
        join(archiveRoot, "agent", "build-info.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          version,
          commit,
          protocolVersion: 1,
        })}\n`,
      );
      runCommand("tar", [
        "-czf",
        join(fixture, assetName),
        "-C",
        archiveRoot,
        "agent",
      ]);
      const assetContent = await readFile(join(fixture, assetName));
      const assetHash = sha256(assetContent);
      const manifest = `${JSON.stringify(
        {
          schemaVersion: 1,
          project: "CodexEverywhere",
          version,
          commit,
          protocolVersion: 1,
          node: ">=20.20.0",
          artifacts: {
            agent: {
              file: assetName,
              sha256: assetHash,
              bytes: assetContent.byteLength,
            },
          },
        },
        null,
        2,
      )}\n`;
      await writeFile(join(fixture, "manifest.json"), manifest);
      const manifestHash = sha256(Buffer.from(manifest));
      await writeFile(
        join(fixture, "SHA256SUMS"),
        `${assetHash}  ${assetName}\n${manifestHash}  manifest.json\n`,
      );
      await writeExecutable(
        join(fakeBin, "curl"),
        `#!/bin/sh
set -eu
if [ "\${CE_TEST_FAIL_NETWORK:-}" = 1 ]; then exit 99; fi
source_url=
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://*) source_url=$1 ;;
    --output) shift; destination=$1 ;;
  esac
  shift
done
cp "$CE_TEST_RELEASE_FIXTURE/\${source_url##*/}" "$destination"
`,
      );
      const environment = {
        ...process.env,
        CE_TEST_RELEASE_FIXTURE: fixture,
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      };

      await writeExecutable(
        join(fakeBin, "gh"),
        `#!/bin/sh
if [ "\${1:-} \${2:-} \${3:-}" = "attestation verify --help" ]; then
  printf '%s\n' '--signer-workflow --source-ref --deny-self-hosted-runners'
  exit 0
fi
exit 1
`,
      );
      const oldGh = runResult(
        releaseInstaller,
        [version, "example/CodexEverywhere", installRoot, runtime],
        environment,
      );
      expect(oldGh.status).not.toBe(0);
      expect(oldGh.stderr).toContain(
        "lacks required attestation identity constraint: --source-digest",
      );

      await writeExecutable(
        join(fakeBin, "gh"),
        `#!/bin/sh
if [ "\${1:-} \${2:-} \${3:-}" = "attestation verify --help" ]; then
  printf '%s\n' '--signer-workflow --source-ref --source-digest --deny-self-hosted-runners'
  exit 0
fi
exit 1
`,
      );

      const untrusted = runResult(
        releaseInstaller,
        [version, "example/CodexEverywhere", installRoot, runtime],
        environment,
      );
      expect(untrusted.status).not.toBe(0);
      expect(untrusted.stderr).toContain("provenance verification failed");

      const wrongDigest = runResult(
        releaseInstaller,
        [
          version,
          "example/CodexEverywhere",
          installRoot,
          runtime,
          "0".repeat(64),
        ],
        environment,
      );
      expect(wrongDigest.status).not.toBe(0);
      expect(wrongDigest.stderr).toContain("approved staging digest");

      const verified = runResult(
        releaseInstaller,
        [
          version,
          "example/CodexEverywhere",
          installRoot,
          runtime,
          manifestHash,
        ],
        environment,
      );
      expect(verified.status, verified.stderr).toBe(0);
      await expect(readlink(join(installRoot, "current"))).resolves.toBe(
        `releases/${version}`,
      );
      await expect(
        readFile(join(installRoot, "active-release"), "utf8"),
      ).resolves.toBe(`${version}\n`);

      const transferred = runResult(
        releaseInstaller,
        [
          version,
          "example/CodexEverywhere",
          installRoot,
          runtime,
          manifestHash,
        ],
        {
          ...environment,
          CE_RELEASE_ASSET_DIRECTORY: fixture,
          CE_TEST_FAIL_NETWORK: "1",
        },
      );
      expect(transferred.status, transferred.stderr).toBe(0);

      const ghLog = join(directory, "gh-arguments.log");
      await writeExecutable(
        join(fakeBin, "gh"),
        `#!/bin/sh
if [ "\${1:-} \${2:-} \${3:-}" = "attestation verify --help" ]; then
  printf '%s\n' '--signer-workflow --source-ref --source-digest --deny-self-hosted-runners'
  exit 0
fi
arguments=" \$* "
for required in \
  '--repo example/CodexEverywhere' \
  '--signer-workflow example/CodexEverywhere/.github/workflows/release.yml' \
  '--source-ref refs/tags/${version}' \
  '--source-digest ${commit}' \
  '--deny-self-hosted-runners'
do
  case "\$arguments" in
    *" \$required "*) ;;
    *) exit 2 ;;
  esac
done
printf '%s\n' "\$*" >>"\$CE_TEST_GH_LOG"
`,
      );
      const attested = runResult(
        releaseInstaller,
        [version, "example/CodexEverywhere", installRoot, runtime],
        { ...environment, CE_TEST_GH_LOG: ghLog },
      );
      expect(attested.status, attested.stderr).toBe(0);
      const attestationCalls = (await readFile(ghLog, "utf8"))
        .trim()
        .split("\n");
      expect(attestationCalls).toHaveLength(3);
      for (const call of attestationCalls) {
        expect(call).toContain(
          "--signer-workflow example/CodexEverywhere/.github/workflows/release.yml",
        );
        expect(call).toContain(`--source-ref refs/tags/${version}`);
        expect(call).toContain(`--source-digest ${commit}`);
        expect(call).toContain("--deny-self-hosted-runners");
      }
    },
  );
});

async function fakeBundle(root: string, name: string): Promise<string> {
  const bundle = join(root, name);
  const dist = join(bundle, "dist");
  await mkdir(dist, { recursive: true });
  const cli = join(dist, "cli.js");
  await writeFile(cli, "#!/usr/bin/env node\n");
  await chmod(cli, 0o755);
  return bundle;
}

async function fakeVerifiedBundle(
  root: string,
  name: string,
  version: string,
  commit: string,
): Promise<{ bundle: string; manifest: string }> {
  const bundle = await fakeBundle(root, name);
  await writeFile(
    join(bundle, "build-info.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      version,
      commit,
      protocolVersion: 1,
    })}\n`,
  );
  const manifest = join(root, `${name}-manifest.json`);
  await writeFile(
    manifest,
    `${JSON.stringify({
      schemaVersion: 1,
      project: "CodexEverywhere",
      version,
      commit,
      protocolVersion: 1,
      node: ">=20.20.0",
      artifacts: {
        agent: {
          file: `codex-everywhere-agent-${version}.tar.gz`,
          sha256: "c".repeat(64),
          bytes: 1,
        },
      },
    })}\n`,
  );
  return { bundle, manifest };
}

async function realNodeRuntime(path: string): Promise<void> {
  const bin = join(path, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, "node"));
  await writeExecutable(join(bin, "tmux"), "#!/bin/sh\nexit 0\n");
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function runCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
}

function runResult(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync("sh", [script, ...args], { encoding: "utf8", env });
}

function runNodeResult(args: string[]) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function runNodeWithPrivateUmaskResult(args: string[]) {
  return spawnSync(
    "sh",
    [
      "-c",
      'umask 077; exec "$@"',
      "ce-release-test",
      process.execPath,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

function run(script: string, args: string[]): void {
  const result = runResult(script, args);
  if (result.status !== 0) {
    throw new Error(
      `${script} failed (${String(result.status)}): ${result.stderr || result.stdout}`,
    );
  }
}
