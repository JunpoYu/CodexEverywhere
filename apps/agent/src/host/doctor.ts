import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

import type { HostConfig } from "./config.js";
import type { HostPaths } from "./paths.js";
import { probeAppServer } from "../runtime/app-server-supervisor.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
};

export async function runDoctor(
  paths: HostPaths,
  config: HostConfig,
  workspaceCount: number,
): Promise<DoctorCheck[]> {
  const [codex, login, tmux, crontab, homeMode, keyMode, appServer] =
    await Promise.all([
      command("codex", ["--version"]),
      command("codex", ["login", "status"]),
      command("tmux", ["-V"]),
      command("crontab", ["-l"], true),
      privateMode(paths.home),
      privateMode(paths.keysDir),
      probeAppServer(paths.appServerSocket),
    ]);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  return [
    check("Node.js", nodeMajor >= 20, process.version, true),
    check("Codex CLI", codex.ok, codex.label, true),
    check(
      "Codex login",
      login.ok,
      login.ok ? "authenticated" : "not authenticated",
      true,
    ),
    check("Private state directory", homeMode, paths.home, true),
    check("Private key directory", keyMode, paths.keysDir, true),
    check(
      "Transport",
      config.transport.mode !== "unconfigured",
      config.transport.mode,
      true,
    ),
    check(
      "Passkey origin",
      Boolean(config.webAuthn),
      config.webAuthn?.origin ?? "unconfigured",
      true,
    ),
    check("Workspace roots", workspaceCount > 0, String(workspaceCount), true),
    check(
      "Codex app-server",
      appServer,
      appServer ? "healthy" : "not running",
      false,
    ),
    check("tmux", tmux.ok, tmux.label, true),
    check(
      "crontab",
      crontab.ok,
      crontab.ok ? "available" : "unavailable",
      true,
    ),
  ];
}

function check(
  name: string,
  ok: boolean,
  detail: string,
  required: boolean,
): DoctorCheck {
  return { name, ok, detail, required };
}

async function privateMode(path: string): Promise<boolean> {
  try {
    return ((await stat(path)).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function command(
  executable: string,
  args: string[],
  acceptNonzero = false,
): Promise<{ ok: boolean; label: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", () => resolve({ ok: false, label: "not found" }));
    child.once("close", (code) =>
      resolve({
        ok: code === 0 || acceptNonzero,
        label:
          stdout.trim().split("\n")[0] || (code === 0 ? "available" : "failed"),
      }),
    );
  });
}
