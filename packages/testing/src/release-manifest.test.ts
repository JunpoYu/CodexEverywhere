import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  sha256File,
  writeReleaseManifest,
} from "../../../deploy/release/write-manifest.mjs";

describe("release manifest", () => {
  it("records immutable artifact metadata and writes matching checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-release-manifest-"));
    const agent = join(directory, "agent.tar.gz");
    const web = join(directory, "web.tar.gz");
    await writeFile(agent, "agent");
    await writeFile(web, "web");

    const manifest = await writeReleaseManifest({
      outputDirectory: directory,
      version: "v0.3.0-alpha.1",
      commit: "a".repeat(40),
      protocolVersion: 1,
      artifactPaths: { agent, web },
    });

    expect(manifest.artifacts.agent).toEqual({
      file: "agent.tar.gz",
      sha256: await sha256File(agent),
      bytes: 5,
    });
    expect(await readFile(join(directory, "SHA256SUMS"), "utf8")).toContain(
      `${await sha256File(web)}  web.tar.gz`,
    );
  });

  it("rejects a mutable or malformed version", async () => {
    await expect(
      writeReleaseManifest({
        outputDirectory: "/tmp",
        version: "main",
        commit: "a".repeat(40),
        protocolVersion: 1,
        artifactPaths: {},
      }),
    ).rejects.toThrow("Invalid release version");
  });
});
