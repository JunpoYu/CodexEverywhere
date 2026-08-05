import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  installCodexForCurrentUser,
  probeCodexInstallation,
  type CommandRunner,
} from "./codex-install.js";

describe("Codex user installation", () => {
  it("detects Codex from PATH when the user-local binary is absent", async () => {
    const run = vi.fn<CommandRunner>(async (file) => {
      if (file === "codex") return { stdout: "codex-cli 0.151.0\n" };
      throw new Error("unexpected binary");
    });

    await expect(
      probeCodexInstallation({ userHome: "/missing/home", run }),
    ).resolves.toEqual({
      installed: true,
      binary: "codex",
      version: "codex-cli 0.151.0",
    });
  });

  it("installs into the user's .local prefix without root", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "ce-codex-install-"));
    let installed = false;
    const onProgress = vi.fn();
    const run = vi.fn<CommandRunner>(async (file, args) => {
      if (file === "npm") {
        installed = true;
        expect(args).toEqual([
          "install",
          "--global",
          "--prefix",
          join(userHome, ".local"),
          "@openai/codex@latest",
        ]);
        return { stdout: "" };
      }
      if (file === join(userHome, ".local", "bin", "codex") && installed) {
        return { stdout: "codex-cli 0.151.0\n" };
      }
      throw new Error("not installed");
    });

    await expect(
      installCodexForCurrentUser({ userHome, run, onProgress }),
    ).resolves.toMatchObject({
      installed: true,
      version: "codex-cli 0.151.0",
    });
    expect(onProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "preparing",
      "installing",
      "verifying",
      "completed",
    ]);
  });

  it("accepts older, newer, and prerelease Codex versions", async () => {
    const versions = ["0.120.0", "0.151.0", "0.152.0-beta.1"];
    for (const version of versions) {
      const run = vi.fn<CommandRunner>(async () => ({
        stdout: `codex-cli ${version}\n`,
      }));
      await expect(
        probeCodexInstallation({ userHome: "/missing/home", run }),
      ).resolves.toMatchObject({
        installed: true,
        version: `codex-cli ${version}`,
      });
    }
  });

  it("rejects an executable that does not report a Codex semantic version", async () => {
    const run = vi.fn<CommandRunner>(async () => ({
      stdout: "not-codex\n",
    }));
    await expect(
      probeCodexInstallation({ userHome: "/missing/home", run }),
    ).resolves.toMatchObject({ installed: false });
  });

  it("does not mistake an unrelated semantic-versioned binary for Codex", async () => {
    const run = vi.fn<CommandRunner>(async () => ({
      stdout: "other-cli 1.2.3\n",
    }));
    await expect(
      probeCodexInstallation({ userHome: "/missing/home", run }),
    ).resolves.toMatchObject({ installed: false });
  });

  it("does not expose installer output when verification fails", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "ce-codex-install-"));
    const run = vi.fn<CommandRunner>(async (file) => {
      if (file === "npm") return { stdout: "secret output" };
      throw new Error("not found");
    });
    await expect(installCodexForCurrentUser({ userHome, run })).rejects.toThrow(
      "installation completed but codex is not executable",
    );
  });

  it("does not let an older PATH installation mask a failed managed update", async () => {
    const userHome = await mkdtemp(join(tmpdir(), "ce-codex-install-"));
    const run = vi.fn<CommandRunner>(async (file) => {
      if (file === "npm") return { stdout: "" };
      if (file === "codex") return { stdout: "codex-cli 0.120.0\n" };
      throw new Error("managed binary missing");
    });

    await expect(installCodexForCurrentUser({ userHome, run })).rejects.toThrow(
      "installation completed but codex is not executable",
    );
    expect(run).not.toHaveBeenCalledWith(
      "codex",
      expect.anything(),
      expect.anything(),
    );
  });
});
