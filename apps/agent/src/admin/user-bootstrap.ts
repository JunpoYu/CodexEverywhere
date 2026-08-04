import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { UnixAccount } from "./unix-accounts.js";

export type UserBootstrapOptions = {
  account: UnixAccount;
  nodePath: string;
  cliPath: string;
  origin: string;
  relayEndpoint: string;
  routeCapability: string;
  runuserPath?: string;
};

export type UserBootstrapInvocation = {
  label: string;
  file: string;
  args: string[];
  input?: string;
};

export type UserBootstrapRunner = (
  invocation: UserBootstrapInvocation,
) => Promise<void>;

export async function validateExistingUserState(
  account: UnixAccount,
): Promise<boolean> {
  const stateDirectory = join(account.home, ".codex-everywhere");
  try {
    const state = await lstat(stateDirectory);
    if (!state.isDirectory() || state.uid !== account.uid) {
      throw new Error(
        "Existing CodexEverywhere state is not a target-user-owned directory",
      );
    }
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export function userBootstrapInvocations(
  options: UserBootstrapOptions,
): UserBootstrapInvocation[] {
  const runuserPath = options.runuserPath ?? "/sbin/runuser";
  const command = (label: string, args: string[], input?: string) => ({
    label,
    file: runuserPath,
    args: [
      "-u",
      options.account.username,
      "--",
      "/usr/bin/env",
      "-i",
      `HOME=${options.account.home}`,
      `USER=${options.account.username}`,
      `LOGNAME=${options.account.username}`,
      `SHELL=${options.account.shell}`,
      `PATH=${join(options.account.home, ".local", "bin")}:${dirname(options.nodePath)}:/usr/local/bin:/usr/bin:/bin`,
      options.nodePath,
      options.cliPath,
      ...args,
    ],
    ...(input === undefined ? {} : { input }),
  });

  return [
    command("Initialize user state", ["agent", "init"]),
    command("Configure Passkey origin", ["auth", "configure", options.origin]),
    command(
      "Configure Relay",
      ["transport", "relay", options.relayEndpoint, "--capability-stdin"],
      `${options.routeCapability}\n`,
    ),
    command("Install user watchdog", ["agent", "install-service"]),
    command("Start user Agent", ["agent", "start"]),
  ];
}

export async function bootstrapUnixUser(
  options: UserBootstrapOptions,
  run: UserBootstrapRunner = runUserBootstrapInvocation,
): Promise<void> {
  for (const invocation of userBootstrapInvocations(options)) {
    await run(invocation);
  }
}

async function runUserBootstrapInvocation(
  invocation: UserBootstrapInvocation,
): Promise<void> {
  const child = spawn(invocation.file, invocation.args, {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  child.stdout.resume();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${invocation.label} was terminated by ${signal}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `${invocation.label} failed with exit code ${String(code)}: ${stderr.trim() || "no error output"}`,
          ),
        );
      } else {
        resolve();
      }
    });
    child.stdin.end(invocation.input);
  });
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
