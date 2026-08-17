import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  inspectSshUnixAccount,
  type UnixAccountEligibility,
} from "../../admin/unix-accounts.js";
import { setUserAccessDisabled } from "../../admin/access-policy.js";
import {
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
} from "../../host/process-files.js";
import type { ManagedUserRecord } from "../repositories/admin-repository.js";
import type { AdminSystemPort } from "../services/admin-service.js";

export interface HostAdminSystemAdapterOptions {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly inspectAccount?: (
    username: string,
  ) => Promise<UnixAccountEligibility>;
}

/** Linux side effects stay behind a testable administrator port. */
export class HostAdminSystemAdapter implements AdminSystemPort {
  readonly #nodePath: string;
  readonly #cliPath: string;
  readonly #inspectAccount: (
    username: string,
  ) => Promise<UnixAccountEligibility>;

  constructor(options: HostAdminSystemAdapterOptions) {
    this.#nodePath = options.nodePath;
    this.#cliPath = options.cliPath;
    this.#inspectAccount = options.inspectAccount ?? inspectSshUnixAccount;
  }

  inspectAccount(username: string): Promise<UnixAccountEligibility> {
    return this.#inspectAccount(username);
  }

  async assertCurrentAccount(user: ManagedUserRecord) {
    const eligibility = await this.#inspectAccount(user.username);
    if (
      !eligibility.eligible ||
      eligibility.account.username !== user.username ||
      eligibility.account.uid !== user.uid ||
      resolve(eligibility.account.home) !== resolve(user.home)
    ) {
      throw new Error("Unix account identity changed; operation refused");
    }
    let registeredHome: string;
    let nssHome: string;
    try {
      [registeredHome, nssHome] = await Promise.all([
        realpath(user.home),
        realpath(eligibility.account.home),
      ]);
      const metadata = await stat(nssHome);
      if (!metadata.isDirectory() || metadata.uid !== user.uid) {
        throw new Error("unsafe home ownership");
      }
    } catch {
      throw new Error("Unix account identity changed; operation refused");
    }
    if (registeredHome !== nssHome) {
      throw new Error("Unix account identity changed; operation refused");
    }
    return { ...eligibility.account, home: nssHome };
  }

  async agentOnline(uid: number): Promise<boolean> {
    const record = await readProcessRecord(agentPidPath(uid));
    return Boolean(
      record &&
      (await processRecordMatches(record, { uid })) &&
      (await processOwnedBy(record.pid, uid)),
    );
  }

  setAccessDisabled(uid: number, disabled: boolean): Promise<void> {
    return setUserAccessDisabled(uid, disabled);
  }

  async stopAgent(uid: number): Promise<void> {
    const pidFile = agentPidPath(uid);
    const record = await readProcessRecord(pidFile);
    if (!record || !(await processRecordMatches(record, { uid }))) {
      await rm(pidFile, { force: true });
      return;
    }
    if (!(await processOwnedBy(record.pid, uid))) {
      throw new Error("Agent PID is not owned by the managed Unix user");
    }
    await signalRecordedProcess(record, "SIGTERM", {
      uid,
      commandIncludes: ["agent", "serve"],
    });
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      (await processRecordMatches(record, { uid }))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (await processRecordMatches(record, { uid })) {
      throw new Error(`Agent PID ${record.pid} did not stop after SIGTERM`);
    }
  }

  async issueRecoveryHandoff(user: ManagedUserRecord) {
    const stdout = await runProcess("/sbin/runuser", [
      "-u",
      user.username,
      "--",
      "/usr/bin/env",
      "-i",
      `HOME=${user.home}`,
      `USER=${user.username}`,
      `LOGNAME=${user.username}`,
      "CE_ADMIN_RECOVERY=1",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      this.#nodePath,
      this.#cliPath,
      "auth",
      "issue-admin-recovery-ticket",
      "--json",
    ]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    if (
      typeof parsed.handoffCode !== "string" ||
      parsed.handoffCode.length < 1 ||
      parsed.handoffCode.length > 256 ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.expiresAt))
    ) {
      throw new Error("User recovery helper returned an invalid result");
    }
    return {
      handoffCode: parsed.handoffCode,
      expiresAt: parsed.expiresAt,
    };
  }

  async removeUserState(user: ManagedUserRecord): Promise<void> {
    const account = await this.assertCurrentAccount(user);
    const stateDirectory = join(account.home, ".codex-everywhere");
    try {
      const metadata = await lstat(stateDirectory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== user.uid
      ) {
        throw new Error("User state path is unsafe; removal refused");
      }
      await rm(stateDirectory, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function agentPidPath(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid <= 0)
    throw new Error("Invalid Unix UID");
  return `/tmp/codex-everywhere-${uid}/agent.pid`;
}

async function processOwnedBy(pid: number, uid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^Uid:\s+(\d+)/mu.exec(status);
    return match?.[1] === String(uid);
  } catch {
    return false;
  }
}

function runProcess(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length <= 1024 * 1024) stdout += chunk;
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length + chunk.length <= 64 * 1024) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else {
        reject(
          new Error(
            stderr.trim() ||
              `User helper failed (${signal === null ? `exit ${code}` : signal})`,
          ),
        );
      }
    });
  });
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
