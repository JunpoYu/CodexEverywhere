import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  AdminHostStatus,
  AdminMutationRequest,
  AdminRecoveryStartResult,
  AdminUserSummary,
} from "@codex-everywhere/protocol";

import { readProcessRecord, isProcessAlive } from "../host/process-files.js";
import type { HostStateStore } from "../host/state-store.js";
import { setUserAccessDisabled } from "./access-policy.js";
import { AdminUserRegistry } from "./registry.js";
import { inspectSshUnixAccount } from "./unix-accounts.js";

export const ADMIN_HELPER_PROTOCOL_VERSION = 1 as const;

export type AdminHelperRequest = {
  version: typeof ADMIN_HELPER_PROTOCOL_VERSION;
  requestId: string;
  actor: string;
  action: string;
  payload: unknown;
};

export class AdminControlService {
  readonly #registry: AdminUserRegistry;
  readonly #installationId: string;
  readonly #serverName: string;
  readonly #nodePath: string;
  readonly #cliPath: string;
  readonly #startedAt: string;

  constructor(
    state: HostStateStore,
    options: {
      installationId: string;
      serverName: string;
      nodePath: string;
      cliPath: string;
      startedAt?: string;
    },
  ) {
    this.#registry = new AdminUserRegistry(state);
    this.#installationId = options.installationId;
    this.#serverName = options.serverName;
    this.#nodePath = options.nodePath;
    this.#cliPath = options.cliPath;
    this.#startedAt = options.startedAt ?? new Date().toISOString();
  }

  async execute(request: AdminHelperRequest): Promise<unknown> {
    validateHelperRequest(request);
    const cached = await this.#registry.readIdempotent(request.requestId);
    if (cached !== undefined) return cached;
    const targetUsername = payloadUsername(request.payload);
    try {
      const result = await this.#dispatch(request.action, request.payload);
      if (isMutation(request.action)) {
        await this.#registry.saveIdempotent(request.requestId, result);
        await this.#registry.audit({
          requestId: request.requestId,
          actor: request.actor,
          action: request.action,
          ...(targetUsername ? { targetUsername } : {}),
          result: "succeeded",
        });
      }
      return result;
    } catch (error) {
      if (isMutation(request.action)) {
        await this.#registry.audit({
          requestId: request.requestId,
          actor: request.actor,
          action: request.action,
          ...(targetUsername ? { targetUsername } : {}),
          result: "failed",
        });
      }
      throw error;
    }
  }

  async maintenance(): Promise<number> {
    const due = await this.#registry.dueRemovals();
    const failures: Error[] = [];
    for (const user of due) {
      const requestId = randomUUID();
      try {
        await this.#removeUser(user);
        await this.#registry.audit({
          requestId,
          actor: "system:maintenance",
          action: "admin/removal/apply",
          targetUsername: user.username,
          result: "succeeded",
        });
      } catch (error) {
        await this.#registry.audit({
          requestId,
          actor: "system:maintenance",
          action: "admin/removal/apply",
          targetUsername: user.username,
          result: "failed",
        });
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `${failures.length} administrator removal operation(s) failed`,
      );
    return due.length;
  }

  async #dispatch(action: string, payload: unknown): Promise<unknown> {
    switch (action) {
      case "admin/host/status":
        return this.#hostStatus();
      case "admin/users/list":
        return { version: 1, users: await this.#usersWithRuntime() };
      case "admin/user/inspect":
        return this.#inspect(payloadUsernameRequired(payload));
      case "admin/user/register":
        return this.#register(payloadUsernameRequired(payload));
      case "admin/user/disable":
        return this.#disable(parseMutation(payload));
      case "admin/user/enable":
        return this.#enable(parseMutation(payload));
      case "admin/recovery/start":
        return this.#startRecovery(parseMutation(payload));
      case "admin/removal/schedule":
        return this.#scheduleRemoval(parseMutation(payload));
      case "admin/removal/cancel":
        return this.#cancelRemoval(parseMutation(payload));
      case "admin/audit/list":
        return {
          version: 1,
          events: await this.#registry.listAudit(payloadLimit(payload)),
        };
      default:
        throw new Error("Unsupported administrator operation");
    }
  }

  async #hostStatus(): Promise<AdminHostStatus> {
    const users = await this.#registry.list();
    return {
      version: 1,
      installationId: this.#installationId,
      serverName: this.#serverName,
      controllerStartedAt: this.#startedAt,
      managedUsers: users.length,
      enabledUsers: users.filter((user) => user.status === "enabled").length,
      disabledUsers: users.filter((user) => user.status === "disabled").length,
      pendingRemovals: users.filter(
        (user) =>
          user.status === "removal_pending" || user.status === "removing",
      ).length,
    };
  }

  async #usersWithRuntime(): Promise<AdminUserSummary[]> {
    const users = await this.#registry.list();
    return Promise.all(
      users.map(async (user) => ({
        ...user,
        agentOnline: await userAgentOnline(user.uid),
      })),
    );
  }

  async #inspect(username: string): Promise<unknown> {
    const eligibility = await inspectSshUnixAccount(username);
    return {
      version: 1,
      eligibility,
      managed: await this.#registry.get(username),
    };
  }

  async #register(username: string): Promise<AdminUserSummary> {
    const eligibility = await inspectSshUnixAccount(username);
    if (!eligibility.eligible)
      throw new Error(`Unix account is not eligible: ${eligibility.reason}`);
    return this.#registry.register(eligibility.account);
  }

  async #disable(input: AdminMutationRequest): Promise<AdminUserSummary> {
    const current = await this.#requiredCurrent(input);
    if (current.status !== "enabled")
      throw new Error("Only an enabled user can be disabled");
    await setUserAccessDisabled(current.uid, true);
    await stopUserAgent(current.uid);
    return this.#registry.setStatus({
      ...input,
      status: "disabled",
    });
  }

  async #enable(input: AdminMutationRequest): Promise<AdminUserSummary> {
    const current = await this.#requiredCurrent(input);
    if (current.status !== "disabled" && current.status !== "removed")
      throw new Error("Only a disabled or removed user can be enabled");
    const updated = await this.#registry.setStatus({
      ...input,
      status: "enabled",
    });
    await setUserAccessDisabled(current.uid, false);
    return updated;
  }

  async #startRecovery(
    input: AdminMutationRequest,
  ): Promise<AdminRecoveryStartResult> {
    const current = await this.#requiredCurrent(input);
    if (current.status !== "enabled")
      throw new Error(
        "Enable the user before starting Web credential recovery",
      );
    await stopUserAgent(current.uid);
    const result = await runUserCommand(
      current,
      this.#nodePath,
      this.#cliPath,
      ["auth", "issue-admin-recovery-ticket", "--json"],
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (
      typeof parsed.handoffCode !== "string" ||
      typeof parsed.expiresAt !== "string"
    )
      throw new Error("User recovery helper returned an invalid result");
    return {
      version: 1,
      username: current.username,
      handoffCode: parsed.handoffCode,
      expiresAt: parsed.expiresAt,
    };
  }

  async #scheduleRemoval(input: AdminMutationRequest) {
    const current = await this.#requiredCurrent(input);
    if (current.status !== "enabled")
      throw new Error("Only an enabled user can be scheduled for removal");
    await setUserAccessDisabled(current.uid, true);
    await stopUserAgent(current.uid);
    return this.#registry.setStatus({
      ...input,
      status: "removal_pending",
      removeAfter: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    });
  }

  async #cancelRemoval(input: AdminMutationRequest) {
    const current = await this.#requiredCurrent(input);
    if (current.status !== "removal_pending")
      throw new Error("The user is not pending removal");
    const updated = await this.#registry.setStatus({
      ...input,
      status: "enabled",
    });
    await setUserAccessDisabled(current.uid, false);
    return updated;
  }

  async #requiredCurrent(input: AdminMutationRequest) {
    const current = await this.#registry.get(input.username);
    if (!current) throw new Error("User is not registered for CodexEverywhere");
    if (current.revision !== input.expectedRevision)
      throw new Error(
        `User state changed: expected revision ${input.expectedRevision}, current revision ${current.revision}`,
      );
    return current;
  }

  async #removeUser(user: AdminUserSummary): Promise<void> {
    const eligibility = await inspectSshUnixAccount(user.username);
    if (
      !eligibility.eligible ||
      eligibility.account.uid !== user.uid ||
      resolve(eligibility.account.home) !== resolve(user.home)
    )
      throw new Error("Unix account identity changed; removal refused");
    const realHome = await realpath(user.home);
    const claimed =
      user.status === "removing"
        ? user
        : await this.#registry.setStatus({
            username: user.username,
            expectedRevision: user.revision,
            status: "removing",
            ...(user.removeAfter ? { removeAfter: user.removeAfter } : {}),
          });
    await setUserAccessDisabled(claimed.uid, true);
    await stopUserAgent(claimed.uid);
    const stateDirectory = join(realHome, ".codex-everywhere");
    try {
      const home = await stat(realHome);
      const state = await lstat(stateDirectory);
      if (!home.isDirectory() || home.uid !== claimed.uid)
        throw new Error("User home ownership changed; removal refused");
      if (
        !state.isDirectory() ||
        state.isSymbolicLink() ||
        state.uid !== claimed.uid
      )
        throw new Error("User state path is unsafe; removal refused");
      await rm(stateDirectory, { recursive: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await this.#registry.setStatus({
      username: claimed.username,
      expectedRevision: claimed.revision,
      status: "removed",
    });
  }
}

export class AdminHelperClient {
  readonly #helperPath: string;

  constructor(helperPath = "/usr/local/libexec/ce-admin-helper") {
    this.#helperPath = helperPath;
  }

  request(value: AdminHelperRequest): Promise<unknown> {
    return runJsonHelper(this.#helperPath, value);
  }
}

function validateHelperRequest(value: AdminHelperRequest): void {
  if (
    value.version !== ADMIN_HELPER_PROTOCOL_VERSION ||
    typeof value.requestId !== "string" ||
    !/^[0-9a-f-]{16,64}$/iu.test(value.requestId) ||
    typeof value.actor !== "string" ||
    value.actor.length < 1 ||
    value.actor.length > 256 ||
    typeof value.action !== "string" ||
    !/^admin\/[a-z/]+$/u.test(value.action)
  )
    throw new Error("Invalid administrator helper request");
}

function parseMutation(value: unknown): AdminMutationRequest {
  if (!value || typeof value !== "object")
    throw new Error("Invalid administrator mutation");
  const record = value as Record<string, unknown>;
  const username = payloadUsername(value);
  if (
    record.version !== 1 ||
    !username ||
    !Number.isSafeInteger(record.expectedRevision) ||
    Number(record.expectedRevision) < 1
  )
    throw new Error("Invalid administrator mutation");
  return {
    version: 1,
    username,
    expectedRevision: Number(record.expectedRevision),
  };
}

function payloadUsernameRequired(value: unknown): string {
  const username = payloadUsername(value);
  if (!username) throw new Error("Unix username is required");
  return username;
}

function payloadUsername(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const username = (value as Record<string, unknown>).username;
  return typeof username === "string" &&
    /^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/u.test(username)
    ? username
    : undefined;
}

function payloadLimit(value: unknown): number {
  if (!value || typeof value !== "object") return 100;
  const limit = (value as Record<string, unknown>).limit;
  return Number.isSafeInteger(limit) ? Number(limit) : 100;
}

function isMutation(action: string): boolean {
  return ![
    "admin/host/status",
    "admin/users/list",
    "admin/user/inspect",
    "admin/audit/list",
  ].includes(action);
}

async function userAgentOnline(uid: number): Promise<boolean> {
  const record = await readProcessRecord(
    `/tmp/codex-everywhere-${uid}/agent.pid`,
  );
  return Boolean(
    record &&
    isProcessAlive(record.pid) &&
    (await processOwnedBy(record.pid, uid)),
  );
}

async function stopUserAgent(uid: number): Promise<void> {
  const pidFile = `/tmp/codex-everywhere-${uid}/agent.pid`;
  const record = await readProcessRecord(pidFile);
  if (!record || !isProcessAlive(record.pid)) {
    await rm(pidFile, { force: true });
    return;
  }
  if (!(await processOwnedBy(record.pid, uid)))
    throw new Error("Agent PID is not owned by the managed Unix user");
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessAlive(record.pid))
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (isProcessAlive(record.pid))
    throw new Error(`Agent PID ${record.pid} did not stop after SIGTERM`);
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

function runUserCommand(
  user: AdminUserSummary,
  nodePath: string,
  cliPath: string,
  args: string[],
): Promise<string> {
  return runProcess("/sbin/runuser", [
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
    nodePath,
    cliPath,
    ...args,
  ]);
}

function runJsonHelper(path: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || "Admin helper failed"));
      else {
        try {
          resolve(JSON.parse(stdout) as unknown);
        } catch (error) {
          reject(
            new Error("Admin helper returned invalid JSON", { cause: error }),
          );
        }
      }
    });
    child.stdin.end(`${JSON.stringify(value)}\n`);
  });
}

function runProcess(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(
            new Error(stderr.trim() || `Helper exited with ${String(code)}`),
          ),
    );
  });
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
