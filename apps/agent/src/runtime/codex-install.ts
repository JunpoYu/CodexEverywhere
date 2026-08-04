import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CodexInstallProgressPhase } from "@codex-everywhere/protocol";

const execFileAsync = promisify(execFile);
export const SUPPORTED_CODEX_CLI_VERSION = "0.144.1";
const CODEX_NPM_SPEC = `@openai/codex@${SUPPORTED_CODEX_CLI_VERSION}`;

export type CodexInstallation = {
  installed: boolean;
  binary: string;
  version?: string;
};

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;

export async function probeCodexInstallation(
  options: {
    userHome?: string;
    env?: NodeJS.ProcessEnv;
    run?: CommandRunner;
  } = {},
): Promise<CodexInstallation> {
  const userHome = options.userHome ?? homedir();
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const candidates = [join(userHome, ".local", "bin", "codex"), "codex"];

  for (const binary of candidates) {
    if (binary !== "codex" && !(await isExecutable(binary))) continue;
    try {
      const { stdout } = await run(binary, ["--version"], {
        env,
        timeoutMs: 10_000,
      });
      const version = stdout.trim();
      if (codexCliVersion(version) === SUPPORTED_CODEX_CLI_VERSION) {
        return { installed: true, binary, version };
      }
    } catch {
      // Try the next candidate without exposing command output or credentials.
    }
  }
  return {
    installed: false,
    binary: join(userHome, ".local", "bin", "codex"),
  };
}

export async function installCodexForCurrentUser(
  options: {
    userHome?: string;
    env?: NodeJS.ProcessEnv;
    npmBinary?: string;
    run?: CommandRunner;
    onProgress?: (phase: CodexInstallProgressPhase) => void;
  } = {},
): Promise<CodexInstallation> {
  const userHome = options.userHome ?? homedir();
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const prefix = join(userHome, ".local");
  options.onProgress?.("preparing");
  await mkdir(prefix, { recursive: true, mode: 0o700 });

  options.onProgress?.("installing");
  await run(
    options.npmBinary ?? "npm",
    ["install", "--global", "--prefix", prefix, CODEX_NPM_SPEC],
    { env, timeoutMs: 10 * 60_000 },
  );

  options.onProgress?.("verifying");
  const installation = await probeCodexInstallation({ userHome, env, run });
  if (!installation.installed) {
    throw new Error("Codex installation completed but codex is not executable");
  }
  options.onProgress?.("completed");
  return installation;
}

export function codexCliVersion(output: string): string | undefined {
  return output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1];
}

async function runCommand(
  file: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ stdout: string }> {
  const result = await execFileAsync(file, [...args], {
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
