import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CodexInstallProgressPhase } from "@codex-everywhere/protocol";

const execFileAsync = promisify(execFile);
export const CODEX_NPM_SPEC = "@openai/codex@latest";

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
      if (codexCliVersion(version)) {
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
  const binary = join(prefix, "bin", "codex");
  let version: string | undefined;
  try {
    version = (
      await run(binary, ["--version"], { env, timeoutMs: 10_000 })
    ).stdout.trim();
  } catch {
    // The generic PATH fallback must not make a failed managed update succeed.
  }
  if (!version || !codexCliVersion(version)) {
    throw new Error("Codex installation completed but codex is not executable");
  }
  options.onProgress?.("completed");
  return { installed: true, binary, version };
}

export async function probeLatestCodexVersion(
  options: {
    env?: NodeJS.ProcessEnv;
    npmBinary?: string;
    run?: CommandRunner;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  try {
    const { stdout } = await run(
      options.npmBinary ?? "npm",
      ["view", CODEX_NPM_SPEC, "version", "--json"],
      { env, timeoutMs: 20_000 },
    );
    const result: unknown = JSON.parse(stdout);
    return typeof result === "string" && semanticVersion(result)
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

export function codexCliVersion(output: string): string | undefined {
  return output.match(
    /(?:^|\s)codex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/iu,
  )?.[1];
}

export function compareCodexVersions(left: string, right: string): number {
  const leftVersion = semanticVersion(left);
  const rightVersion = semanticVersion(right);
  if (!leftVersion || !rightVersion) return 0;
  for (const key of ["major", "minor", "patch"] as const) {
    const difference = leftVersion[key] - rightVersion[key];
    if (difference !== 0) return Math.sign(difference);
  }
  if (leftVersion.prerelease.length === 0)
    return rightVersion.prerelease.length === 0 ? 0 : 1;
  if (rightVersion.prerelease.length === 0) return -1;
  const length = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/u.test(rightPart)
      ? Number(rightPart)
      : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined)
      return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function semanticVersion(version: string):
  | {
      major: number;
      minor: number;
      patch: number;
      prerelease: string[];
    }
  | undefined {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u,
  );
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
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
