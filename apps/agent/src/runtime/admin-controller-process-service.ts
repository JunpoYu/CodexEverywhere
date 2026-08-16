import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

import {
  loadAdminControllerConfig,
  resolveAdminControllerPaths,
  type AdminControllerConfig,
} from "../admin/controller-config.js";
import {
  isProcessAlive,
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
} from "../host/process-files.js";
import {
  inspectAdminRelayCapabilityRenewal,
  renewAdminRelayCapabilityIfNeeded,
} from "./admin-relay-capability-renewal.js";

export async function reloadAdminControllerConfigForStartup(
  configPath: string,
  bootstrapConfig: AdminControllerConfig,
  options: {
    readonly renew?: typeof renewAdminRelayCapabilityIfNeeded;
    readonly onRenewalError?: (error: unknown) => void;
  } = {},
): Promise<AdminControllerConfig> {
  let current = await loadAdminControllerConfig(configPath);
  assertSameControllerIdentity(bootstrapConfig, current);
  const status = inspectAdminRelayCapabilityRenewal(current.routeCapability);
  if (status.remainingMs !== undefined && status.remainingMs <= 0) {
    try {
      await (options.renew ?? renewAdminRelayCapabilityIfNeeded)(configPath, {
        currentUser: {
          username: current.runAsUser,
          uid: current.runAsUid,
        },
      });
    } catch (error) {
      options.onRenewalError?.(error);
    }
    current = await loadAdminControllerConfig(configPath);
    assertSameControllerIdentity(bootstrapConfig, current);
  }
  return current;
}

export async function startAdminControllerService(
  cliEntryPoint: string,
): Promise<{ readonly started: boolean; readonly pid: number }> {
  const config = await loadAdminControllerConfig();
  assertControllerUser(config);
  const paths = resolveAdminControllerPaths(config.home, config.runAsUid);
  const existing = await readProcessRecord(paths.pidFile);
  if (existing && (await processRecordMatches(existing))) {
    return { started: false, pid: existing.pid };
  }
  const child = spawn(
    process.execPath,
    [cliEntryPoint, "admin", "web", "serve"],
    {
      detached: true,
      env: { ...process.env, CE_ADMIN_HOME: config.home },
      stdio: "ignore",
    },
  );
  if (child.pid === undefined) {
    throw new Error("Failed to start Administrator Controller");
  }
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = await readProcessRecord(paths.pidFile);
    if (
      record !== undefined &&
      record.pid === child.pid &&
      (await processRecordMatches(record))
    ) {
      return { started: true, pid: record.pid };
    }
    if (!isProcessAlive(child.pid)) break;
    await delay(50);
  }
  throw new Error("Administrator Controller did not become ready");
}

export async function stopAdminControllerService(): Promise<boolean> {
  const config = await loadAdminControllerConfig();
  assertControllerUser(config);
  const paths = resolveAdminControllerPaths(config.home, config.runAsUid);
  const record = await readProcessRecord(paths.pidFile);
  if (record === undefined || !(await processRecordMatches(record))) {
    await rm(paths.pidFile, { force: true });
    return false;
  }
  await signalRecordedProcess(record, "SIGTERM", {
    uid: config.runAsUid,
    commandIncludes: ["admin", "web", "serve"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await processRecordMatches(record))) {
    await delay(50);
  }
  if (await processRecordMatches(record)) {
    throw new Error("Administrator Controller did not stop after SIGTERM");
  }
  return true;
}

function assertSameControllerIdentity(
  expected: AdminControllerConfig,
  current: AdminControllerConfig,
): void {
  for (const field of [
    "version",
    "adminHandle",
    "runAsUser",
    "runAsUid",
    "installationId",
    "serverName",
    "origin",
    "rpId",
    "relayEndpoint",
    "routeId",
    "nodeId",
    "home",
  ] as const) {
    if (current[field] !== expected[field]) {
      throw new Error(
        `Administrator Controller identity changed while acquiring its service lock (${field})`,
      );
    }
  }
}

function assertControllerUser(config: AdminControllerConfig): void {
  if (process.getuid?.() !== config.runAsUid) {
    throw new Error(
      `Administrator Controller must run as ${config.runAsUser} (UID ${config.runAsUid})`,
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
