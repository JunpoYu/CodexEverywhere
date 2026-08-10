import { readFile, stat } from "node:fs/promises";

import {
  RELAY_CAPABILITY_VERSION,
  inspectRouteCapability,
  issueProvisionedAdminRouteCapability,
  verifyProvisionedAdminRouteForRenewal,
  type HostProvisionerCredential,
} from "@codex-everywhere/protocol/relay-capability";

import { writePrivateJsonAtomically } from "../host/process-files.js";
import {
  loadAdminInstallation,
  type AdminInstallation,
  type AdminInstallationV2,
} from "./controller-config.js";
import {
  loadHostProvisioner,
  type InstalledHostProvisioner,
} from "./self-provision.js";
import type { UnixAccount } from "./unix-accounts.js";

type ProvisionedAdminRouteBinding = {
  uid: number;
  gid: number;
  username: string;
  home: string;
  shell: string;
  installationId: string;
  adminHandle: string;
  routeId: string;
  createdAt: string;
  updatedAt: string;
};

type ProvisionedAdminRouteBindings = {
  version: 1;
  bindings: ProvisionedAdminRouteBinding[];
};

export type AdminRouteRenewalGrant = {
  version: 1;
  username: string;
  uid: number;
  adminHandle: string;
  origin: string;
  relayEndpoint: string;
  routeId: string;
  routeCapability: string;
};

export function parseAdminRouteRenewalGrant(
  value: unknown,
): AdminRouteRenewalGrant {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid administrator Relay renewal grant");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.username !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}\$?$/u.test(record.username) ||
    !Number.isSafeInteger(record.uid) ||
    Number(record.uid) <= 0 ||
    typeof record.adminHandle !== "string" ||
    typeof record.origin !== "string" ||
    typeof record.relayEndpoint !== "string" ||
    typeof record.routeId !== "string" ||
    typeof record.routeCapability !== "string"
  ) {
    throw new Error("Invalid administrator Relay renewal grant");
  }
  const origin = new URL(record.origin);
  const relayEndpoint = new URL(record.relayEndpoint);
  const capability = inspectRouteCapability(record.routeCapability);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (relayEndpoint.protocol !== "wss:" && relayEndpoint.protocol !== "ws:") ||
    capability.version !== RELAY_CAPABILITY_VERSION ||
    capability.principal !== "host-admin" ||
    capability.purpose !== "host-admin-route" ||
    capability.routeId !== record.routeId ||
    capability.loginName !== record.adminHandle
  ) {
    throw new Error("Invalid administrator Relay renewal grant");
  }
  return {
    version: 1,
    username: record.username,
    uid: Number(record.uid),
    adminHandle: record.adminHandle,
    origin: origin.origin,
    relayEndpoint: relayEndpoint.toString(),
    routeId: record.routeId,
    routeCapability: record.routeCapability,
  };
}

/**
 * Renews exactly the administrator route registered by root for this Unix
 * account. The first request must also prove the existing capability while
 * its signing credential is retained; later requests rely on the provisioner
 * private UID/NSS binding and never expose its credential to the Controller.
 */
export async function issueAdminRouteRenewalGrantForAccount(
  account: UnixAccount,
  options: {
    configPath: string;
    adminInstallationPath: string;
    adminRouteBindingsPath: string;
    renewalCapability: string;
    now?: Date;
    loadInstallation?: typeof loadAdminInstallation;
  },
): Promise<AdminRouteRenewalGrant> {
  const home = await stat(account.home);
  if (!home.isDirectory() || home.uid !== account.uid) {
    throw new Error("Unix account home is not owned by the requesting user");
  }
  const now = options.now ?? new Date();
  const [installed, installation] = await Promise.all([
    loadHostProvisioner(options.configPath, now),
    (options.loadInstallation ?? loadAdminInstallation)(
      options.adminInstallationPath,
    ),
  ]);
  assertRegisteredAdministrator(account, installation, installed);

  const registry = await loadAdminRouteBindings(options.adminRouteBindingsPath);
  const current = resolveCurrentBinding(
    registry,
    account,
    installation,
    installed,
  );
  const renewal = inspectRouteCapability(options.renewalCapability);
  if (
    renewal.version !== RELAY_CAPABILITY_VERSION ||
    renewal.principal !== "host-admin" ||
    renewal.purpose !== "host-admin-route" ||
    renewal.installationId !== installation.installationId ||
    renewal.loginName !== installation.adminHandle ||
    renewal.routeId !== installation.routeId
  ) {
    throw new Error(
      "Administrator Relay renewal owner, handle, or route does not match root registration",
    );
  }
  const binding =
    current ??
    verifyInitialBinding(
      account,
      installation,
      installed,
      options.renewalCapability,
      now,
    );

  const issued = issueProvisionedAdminRouteCapability(
    installed.credential,
    {
      adminHandle: binding.adminHandle,
      routeId: binding.routeId,
    },
    now,
  );
  await saveAdminRouteBinding(
    options.adminRouteBindingsPath,
    registry,
    binding,
    now,
  );
  return {
    version: 1,
    username: account.username,
    uid: account.uid,
    adminHandle: binding.adminHandle,
    origin: installed.origin,
    relayEndpoint: installed.relayEndpoint,
    routeId: issued.payload.routeId,
    routeCapability: issued.capability,
  };
}

function assertRegisteredAdministrator(
  account: UnixAccount,
  installation: AdminInstallation,
  installed: InstalledHostProvisioner,
): asserts installation is AdminInstallationV2 {
  if (installation.version !== 2) {
    throw new Error(
      "Administrator Relay renewal requires root to rerun ce admin install-controller once to publish the version 2 UID/NSS route registration",
    );
  }
  if (
    account.uid !== installation.runAsUid ||
    account.gid !== installation.runAsGid ||
    account.username !== installation.runAsUser ||
    account.home !== installation.runAsHome ||
    account.shell !== installation.runAsShell
  ) {
    throw new Error(
      "Authenticated Unix account does not match the root-registered Administrator Controller",
    );
  }
  if (installation.installationId !== installed.credential.installationId) {
    throw new Error(
      "Administrator Controller and host provisioner installation IDs do not match",
    );
  }
}

function resolveCurrentBinding(
  registry: ProvisionedAdminRouteBindings,
  account: UnixAccount,
  installation: AdminInstallationV2,
  installed: InstalledHostProvisioner,
): ProvisionedAdminRouteBinding | undefined {
  const byUid = registry.bindings.find(
    (binding) => binding.uid === account.uid,
  );
  const byUsername = registry.bindings.find(
    (binding) => binding.username === account.username,
  );
  if (!byUid && !byUsername) return undefined;
  const binding = byUid ?? byUsername;
  if (
    !binding ||
    binding.uid !== account.uid ||
    binding.gid !== account.gid ||
    binding.username !== account.username ||
    binding.home !== account.home ||
    binding.shell !== account.shell ||
    binding.installationId !== installed.credential.installationId ||
    binding.adminHandle !== installation.adminHandle ||
    binding.routeId !== installation.routeId ||
    (byUid && byUsername && byUid.routeId !== byUsername.routeId)
  ) {
    throw new Error(
      "Administrator Relay route ownership conflicts with the authenticated Unix account or root registration",
    );
  }
  return binding;
}

function verifyInitialBinding(
  account: UnixAccount,
  installation: AdminInstallationV2,
  installed: InstalledHostProvisioner,
  renewalCapability: string,
  now: Date,
): ProvisionedAdminRouteBinding {
  const credentials: HostProvisionerCredential[] = [
    installed.credential,
    ...(installed.renewalVerificationCredentials ?? []),
  ];
  for (const credential of credentials) {
    try {
      const verified = verifyProvisionedAdminRouteForRenewal(
        renewalCapability,
        credential,
        { adminHandle: installation.adminHandle },
        now,
      );
      if (verified.routeId !== installation.routeId) continue;
      return {
        uid: account.uid,
        gid: account.gid,
        username: account.username,
        home: account.home,
        shell: account.shell,
        installationId: installation.installationId,
        adminHandle: installation.adminHandle,
        routeId: installation.routeId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    } catch {
      // Only an exact, still-valid capability from the root-registered route
      // can bootstrap the provisioner's durable UID/NSS binding.
    }
  }
  throw new Error(
    "The existing administrator Relay capability cannot prove the root-registered route; renew before its old credential expires or rerun the root Controller installer",
  );
}

async function saveAdminRouteBinding(
  path: string,
  registry: ProvisionedAdminRouteBindings,
  binding: ProvisionedAdminRouteBinding,
  now: Date,
): Promise<void> {
  const existing = registry.bindings.find(
    (candidate) =>
      candidate.uid === binding.uid ||
      candidate.username === binding.username ||
      candidate.routeId === binding.routeId,
  );
  if (
    existing &&
    (existing.uid !== binding.uid ||
      existing.username !== binding.username ||
      existing.routeId !== binding.routeId)
  ) {
    throw new Error("Refusing to replace an administrator Relay route binding");
  }
  const updated: ProvisionedAdminRouteBinding = {
    ...binding,
    createdAt: existing?.createdAt ?? binding.createdAt,
    updatedAt: now.toISOString(),
  };
  const bindings = registry.bindings.filter(
    (candidate) =>
      candidate.uid !== updated.uid &&
      candidate.username !== updated.username &&
      candidate.routeId !== updated.routeId,
  );
  bindings.push(updated);
  bindings.sort((left, right) => left.uid - right.uid);
  await writePrivateJsonAtomically(path, { version: 1, bindings });
}

async function loadAdminRouteBindings(
  path: string,
): Promise<ProvisionedAdminRouteBindings> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return { version: 1, bindings: [] };
    throw error;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid administrator Relay route binding registry");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.bindings)) {
    throw new Error("Invalid administrator Relay route binding registry");
  }
  const bindings = record.bindings.map(parseAdminRouteBinding);
  if (
    new Set(bindings.map((binding) => binding.uid)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.username)).size !==
      bindings.length ||
    new Set(bindings.map((binding) => binding.routeId)).size !== bindings.length
  ) {
    throw new Error("Invalid administrator Relay route binding registry");
  }
  return { version: 1, bindings };
}

function parseAdminRouteBinding(value: unknown): ProvisionedAdminRouteBinding {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid administrator Relay route binding registry");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.uid) ||
    Number(record.uid) <= 0 ||
    !Number.isSafeInteger(record.gid) ||
    Number(record.gid) < 0 ||
    typeof record.username !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}\$?$/u.test(record.username) ||
    typeof record.home !== "string" ||
    !record.home.startsWith("/") ||
    typeof record.shell !== "string" ||
    !record.shell.startsWith("/") ||
    typeof record.installationId !== "string" ||
    typeof record.adminHandle !== "string" ||
    typeof record.routeId !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/u.test(record.routeId) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new Error("Invalid administrator Relay route binding registry");
  }
  return record as ProvisionedAdminRouteBinding;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
