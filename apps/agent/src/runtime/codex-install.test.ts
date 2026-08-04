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
      if (file === "codex") return { stdout: "codex-cli 0.144.1\n" };
      throw new Error("unexpected binary");
    });

    await expect(
      probeCodexInstallation({ userHome: "/missing/home", run }),
    ).resolves.toEqual({
      installed: true,
      binary: "codex",
      version: "codex-cli 0.144.1",
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
          "@openai/codex@0.144.1",
        ]);
        return { stdout: "" };
      }
      if (file === "codex" && installed) {
        return { stdout: "codex-cli 0.144.1\n" };
      }
      throw new Error("not installed");
    });

    await expect(
      installCodexForCurrentUser({ userHome, run, onProgress }),
    ).resolves.toMatchObject({
      installed: true,
      version: "codex-cli 0.144.1",
    });
    expect(onProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "preparing",
      "installing",
      "verifying",
      "completed",
    ]);
  });

  it("does not start app-server with an untested Codex version", async () => {
    const run = vi.fn<CommandRunner>(async () => ({
      stdout: "codex-cli 0.145.0\n",
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
});
