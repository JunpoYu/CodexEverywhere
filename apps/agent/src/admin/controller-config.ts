import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  issueProvisionedAdminRouteCapability,
  normalizeLoginName,
} from "@codex-everywhere/protocol/relay-capability";

import { loadHostProvisioner } from "./self-provision.js";
import { inspectSshUnixAccount } from "./unix-accounts.js";

export const ADMIN_INSTALLATION_CONFIG =
  "/etc/codex-everywhere-admin-controller.json";
export const ADMIN_CONTROLLER_VERSION = 1 as const;

export type AdminControllerConfig = {
  version: typeof ADMIN_CONTROLLER_VERSION;
  adminHandle: string;
  runAsUser: string;
  runAsUid: number;
  installationId: string;
  serverName: string;
  origin: string;
  rpId: string;
  relayEndpoint: string;
  routeId: string;
  routeCapability: string;
  nodeId: string;
  home: string;
};

export type AdminControllerPaths = {
  home: string;
  configFile: string;
  stateFile: string;
  keysDir: string;
  runtimeDir: string;
  pidFile: string;
  lockFile: string;
};

export type AdminInstallation = Pick<
  AdminControllerConfig,
  | "version"
  | "adminHandle"
  | "runAsUser"
  | "runAsUid"
  | "installationId"
  | "serverName"
  | "home"
>;

export function resolveAdminControllerPaths(
  home: string,
  runAsUid: number,
): AdminControllerPaths {
  const resolvedHome = resolve(home);
  const runtimeDir = `/tmp/codex-everywhere-admin-${runAsUid}`;
  return {
    home: resolvedHome,
    configFile: join(resolvedHome, "config.json"),
    stateFile: join(resolvedHome, "state.sqlite"),
    keysDir: join(resolvedHome, "keys"),
    runtimeDir,
    pidFile: join(runtimeDir, "controller.pid"),
    lockFile: join(runtimeDir, "controller.lock"),
  };
}

export async function installAdminController(options: {
  runAsUser: string;
  adminHandle: string;
  home?: string;
}): Promise<AdminControllerConfig> {
  if (process.getuid?.() !== 0)
    throw new Error("Administrator Controller installation requires root");
  const eligibility = await inspectSshUnixAccount(options.runAsUser);
  if (!eligibility.eligible)
    throw new Error(`Unix account is not eligible: ${eligibility.reason}`);
  const account = eligibility.account;
  const installed = await loadHostProvisioner();
  const home = resolve(
    options.home ?? "/var/lib/codex-everywhere/admin-controller",
  );
  const adminHandle = normalizeLoginName(options.adminHandle);
  const origin = new URL(installed.origin);
  try {
    const existing = validateAdminControllerConfig(
      JSON.parse(await readFile(join(home, "config.json"), "utf8")) as unknown,
    );
    if (
      existing.runAsUser !== account.username ||
      existing.runAsUid !== account.uid ||
      existing.adminHandle !== adminHandle ||
      existing.installationId !== installed.credential.installationId ||
      existing.origin !== origin.origin ||
      existing.relayEndpoint !== installed.relayEndpoint
    )
      throw new Error(
        "An Administrator Controller already exists with a different identity; migrate or remove it explicitly",
      );
    const renewed = issueProvisionedAdminRouteCapability(installed.credential, {
      adminHandle,
      routeId: existing.routeId,
    });
    const updated = {
      ...existing,
      routeCapability: renewed.capability,
    };
    await writeJson(join(home, "config.json"), updated, {
      uid: account.uid,
      gid: account.gid,
      mode: 0o600,
    });
    await writePublicInstallation(updated);
    return updated;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const issued = issueProvisionedAdminRouteCapability(installed.credential, {
    adminHandle,
  });
  const config: AdminControllerConfig = {
    version: ADMIN_CONTROLLER_VERSION,
    adminHandle: issued.payload.loginName,
    runAsUser: account.username,
    runAsUid: account.uid,
    installationId: installed.credential.installationId,
    serverName: hostname(),
    origin: origin.origin,
    rpId: origin.hostname,
    relayEndpoint: installed.relayEndpoint,
    routeId: issued.payload.routeId,
    routeCapability: issued.capability,
    nodeId: randomUUID(),
    home,
  };
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chown(home, account.uid, account.gid);
  await writeJson(join(home, "config.json"), config, {
    uid: account.uid,
    gid: account.gid,
    mode: 0o600,
  });
  await writePublicInstallation(config);
  return config;
}

function writePublicInstallation(config: AdminControllerConfig): Promise<void> {
  return writeJson(
    ADMIN_INSTALLATION_CONFIG,
    {
      version: 1,
      adminHandle: config.adminHandle,
      runAsUser: config.runAsUser,
      runAsUid: config.runAsUid,
      installationId: config.installationId,
      serverName: config.serverName,
      home: config.home,
    },
    { uid: 0, gid: 0, mode: 0o644 },
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function loadAdminControllerConfig(
  path?: string,
): Promise<AdminControllerConfig> {
  const configPath =
    path ??
    join(
      process.env.CE_ADMIN_HOME ?? (await loadAdminInstallation()).home,
      "config.json",
    );
  const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
  return validateAdminControllerConfig(value);
}

export async function loadAdminInstallation(): Promise<AdminInstallation> {
  const value: unknown = JSON.parse(
    await readFile(ADMIN_INSTALLATION_CONFIG, "utf8"),
  );
  if (!value || typeof value !== "object")
    throw new Error("Invalid administrator installation");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.adminHandle !== "string" ||
    typeof record.runAsUser !== "string" ||
    !Number.isSafeInteger(record.runAsUid) ||
    typeof record.installationId !== "string" ||
    typeof record.serverName !== "string" ||
    typeof record.home !== "string"
  )
    throw new Error("Invalid administrator installation");
  return record as AdminInstallation;
}

export function validateAdminControllerConfig(
  value: unknown,
): AdminControllerConfig {
  if (!value || typeof value !== "object")
    throw new Error("Invalid administrator Controller configuration");
  const record = value as Record<string, unknown>;
  if (
    record.version !== ADMIN_CONTROLLER_VERSION ||
    typeof record.adminHandle !== "string" ||
    typeof record.runAsUser !== "string" ||
    !Number.isSafeInteger(record.runAsUid) ||
    typeof record.installationId !== "string" ||
    typeof record.serverName !== "string" ||
    typeof record.origin !== "string" ||
    typeof record.rpId !== "string" ||
    typeof record.relayEndpoint !== "string" ||
    typeof record.routeId !== "string" ||
    typeof record.routeCapability !== "string" ||
    typeof record.nodeId !== "string" ||
    typeof record.home !== "string"
  )
    throw new Error("Invalid administrator Controller configuration");
  return record as AdminControllerConfig;
}

async function writeJson(
  path: string,
  value: unknown,
  options: { uid: number; gid: number; mode: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", options.mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chown(temporary, options.uid, options.gid);
    await chmod(temporary, options.mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
