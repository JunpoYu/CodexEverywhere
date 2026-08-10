import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chown, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  issueProvisionedAdminRouteCapability,
  normalizeLoginName,
} from "@codex-everywhere/protocol/relay-capability";

import { syncDirectoryForDurability } from "../host/durable-file.js";
import { loadHostProvisioner } from "./self-provision.js";
import { inspectSshUnixAccount } from "./unix-accounts.js";

export const ADMIN_INSTALLATION_CONFIG =
  "/etc/codex-everywhere-admin-controller.json";
export const ADMIN_CONTROLLER_VERSION = 1 as const;
export const ADMIN_INSTALLATION_VERSION = 2 as const;

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

type AdminInstallationBase = Pick<
  AdminControllerConfig,
  | "adminHandle"
  | "runAsUser"
  | "runAsUid"
  | "installationId"
  | "serverName"
  | "home"
>;

export type AdminInstallationV1 = AdminInstallationBase & { version: 1 };

export type AdminInstallationV2 = AdminInstallationBase & {
  version: typeof ADMIN_INSTALLATION_VERSION;
  runAsGid: number;
  runAsHome: string;
  runAsShell: string;
  routeId: string;
};

export type AdminInstallation = AdminInstallationV1 | AdminInstallationV2;

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
    await writePublicInstallation(updated, account);
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
  await writePublicInstallation(config, account);
  return config;
}

function writePublicInstallation(
  config: AdminControllerConfig,
  account: {
    gid: number;
    home: string;
    shell: string;
  },
): Promise<void> {
  return writeJson(
    ADMIN_INSTALLATION_CONFIG,
    {
      version: ADMIN_INSTALLATION_VERSION,
      adminHandle: config.adminHandle,
      runAsUser: config.runAsUser,
      runAsUid: config.runAsUid,
      runAsGid: account.gid,
      runAsHome: account.home,
      runAsShell: account.shell,
      installationId: config.installationId,
      serverName: config.serverName,
      routeId: config.routeId,
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

export async function loadAdminInstallation(
  path = ADMIN_INSTALLATION_CONFIG,
): Promise<AdminInstallation> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    assertSafeAdminInstallationFile(await handle.stat());
    value = JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
  return validateAdminInstallation(value);
}

export function validateAdminInstallation(value: unknown): AdminInstallation {
  if (!value || typeof value !== "object")
    throw new Error("Invalid administrator installation");
  const record = value as Record<string, unknown>;
  if (
    (record.version !== 1 && record.version !== ADMIN_INSTALLATION_VERSION) ||
    typeof record.adminHandle !== "string" ||
    typeof record.runAsUser !== "string" ||
    !Number.isSafeInteger(record.runAsUid) ||
    typeof record.installationId !== "string" ||
    typeof record.serverName !== "string" ||
    typeof record.home !== "string" ||
    !record.home.startsWith("/")
  )
    throw new Error("Invalid administrator installation");
  if (record.version === 1) return record as AdminInstallationV1;
  if (
    !Number.isSafeInteger(record.runAsGid) ||
    Number(record.runAsGid) < 0 ||
    typeof record.runAsHome !== "string" ||
    !record.runAsHome.startsWith("/") ||
    typeof record.runAsShell !== "string" ||
    !record.runAsShell.startsWith("/") ||
    typeof record.routeId !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/u.test(record.routeId)
  ) {
    throw new Error("Invalid administrator installation");
  }
  return record as AdminInstallationV2;
}

export function assertSafeAdminInstallationFile(
  file: Pick<Stats, "isFile" | "nlink" | "uid" | "mode">,
): void {
  if (
    !file.isFile() ||
    file.nlink !== 1 ||
    file.uid !== 0 ||
    (file.mode & 0o7777) !== 0o644
  ) {
    throw new Error(
      "Administrator installation must be a single-link root-owned 0644 regular file",
    );
  }
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

export async function writeJson(
  path: string,
  value: unknown,
  options: { uid: number; gid: number; mode: number },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  let published = false;
  try {
    const handle = await open(temporary, "wx", options.mode);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.chown(options.uid, options.gid);
      await handle.chmod(options.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    published = true;
    await syncDirectoryForDurability(dirname(path));
  } catch (error) {
    if (temporaryCreated && !published) await rm(temporary, { force: true });
    throw error;
  }
}
