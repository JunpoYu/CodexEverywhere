import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  issueProvisionedRouteCapability,
  parseHostProvisionerCredential,
  parseHostProvisionerCredentialRecord,
  routeIdFromCapability,
  verifyProvisionedUserRouteForRenewal,
  type HostProvisionerCredential,
} from "@codex-everywhere/protocol/relay-capability";

import {
  validateCodexNetworkConfig,
  type CodexNetworkConfig,
} from "../host/network.js";
import {
  inspectSshUnixAccount,
  type GetentRunner,
  type UnixAccount,
} from "./unix-accounts.js";
import { AdminStateDatabase } from "../v2/repositories/admin-state-database.js";
import { writePrivateJsonAtomically } from "../host/process-files.js";
import { ADMIN_STATE_FILE } from "./access-policy.js";

export const INSTALLED_PROVISIONER_VERSION = 1 as const;
export const HOST_PROVISIONER_CONFIG_PATH =
  "/etc/codex-everywhere/provisioner.json";

export type InstalledHostProvisioner = {
  version: typeof INSTALLED_PROVISIONER_VERSION;
  origin: string;
  relayEndpoint: string;
  credential: HostProvisionerCredential;
  renewalVerificationCredentials?: HostProvisionerCredential[];
  defaultCodexNetwork?: CodexNetworkConfig;
};

type ProvisionedRouteBinding = {
  uid: number;
  username: string;
  home: string;
  installationId: string;
  routeId: string;
  createdAt: string;
  updatedAt: string;
};

type ProvisionedRouteBindings = {
  version: 1;
  bindings: ProvisionedRouteBinding[];
};

export type SelfProvisioningGrant = {
  version: 1;
  username: string;
  uid: number;
  origin: string;
  relayEndpoint: string;
  routeId: string;
  routeCapability: string;
  defaultCodexNetwork?: CodexNetworkConfig;
};

export async function installHostProvisioner(
  input: {
    origin: string;
    relayEndpoint: string;
    credential: unknown;
    defaultCodexNetwork?: unknown;
  },
  path = HOST_PROVISIONER_CONFIG_PATH,
  now = new Date(),
): Promise<InstalledHostProvisioner> {
  const credential = parseHostProvisionerCredential(input.credential, now);
  const renewalVerificationCredentials =
    await readRenewalVerificationCredentials(
      path,
      credential.installationId,
      credential,
      now,
    );
  const installed = validateInstalledHostProvisioner(
    {
      version: INSTALLED_PROVISIONER_VERSION,
      origin: input.origin,
      relayEndpoint: input.relayEndpoint,
      credential,
      ...(renewalVerificationCredentials.length > 0
        ? { renewalVerificationCredentials }
        : {}),
      defaultCodexNetwork: input.defaultCodexNetwork,
    },
    now,
  );
  await writePrivateJson(path, installed);
  return installed;
}

export async function loadHostProvisioner(
  path = HOST_PROVISIONER_CONFIG_PATH,
  now = new Date(),
): Promise<InstalledHostProvisioner> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return validateInstalledHostProvisioner(value, now);
}

export async function pruneExpiredRenewalVerificationCredentials(
  path = HOST_PROVISIONER_CONFIG_PATH,
  now = new Date(),
): Promise<boolean> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") {
    throw new Error("Invalid installed host provisioner");
  }
  const record = value as Record<string, unknown>;
  if (record.renewalVerificationCredentials === undefined) return false;
  if (!Array.isArray(record.renewalVerificationCredentials)) {
    throw new Error("Invalid installed host provisioner");
  }
  const active = parseHostProvisionerCredentialRecord(record.credential);
  const current = record.renewalVerificationCredentials.map((candidate) => {
    const credential = parseHostProvisionerCredentialRecord(candidate);
    if (credential.installationId !== active.installationId) {
      throw new Error("Invalid installed host provisioner");
    }
    return credential;
  });
  const retained = current.filter(
    (credential) => Date.parse(credential.expiresAt) > now.getTime(),
  );
  if (retained.length === current.length) return false;
  const updated: Record<string, unknown> = { ...record };
  delete updated.renewalVerificationCredentials;
  if (retained.length > 0) updated.renewalVerificationCredentials = retained;
  await writePrivateJson(path, updated);
  return true;
}

export async function inspectInstalledProvisionerCredential(
  path = HOST_PROVISIONER_CONFIG_PATH,
  now = new Date(),
): Promise<{
  installationId: string;
  expiresAt: string;
  remainingMs: number;
}> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object") {
    throw new Error("Invalid installed host provisioner");
  }
  const credential = parseHostProvisionerCredentialRecord(
    (value as Record<string, unknown>).credential,
  );
  return {
    installationId: credential.installationId,
    expiresAt: credential.expiresAt,
    remainingMs: Date.parse(credential.expiresAt) - now.getTime(),
  };
}

export async function setHostProvisionerDefaultCodexNetwork(
  defaultCodexNetwork: unknown,
  path = HOST_PROVISIONER_CONFIG_PATH,
): Promise<InstalledHostProvisioner> {
  const installed = await loadHostProvisioner(path);
  const updated = validateInstalledHostProvisioner({
    ...installed,
    defaultCodexNetwork,
  });
  await writePrivateJson(path, updated);
  return updated;
}

export async function issueSelfProvisioningGrant(
  options: {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
    adminStatePath?: string;
    routeBindingsPath?: string;
    runGetent?: GetentRunner;
  } = {},
): Promise<SelfProvisioningGrant> {
  const env = options.env ?? process.env;
  const username = env.SUDO_USER;
  const uidText = env.SUDO_UID;
  if (
    !username ||
    !uidText ||
    !/^[1-9][0-9]*$/u.test(uidText) ||
    !Number.isSafeInteger(Number(uidText))
  ) {
    throw new Error(
      "Self-provisioning must be invoked by the installed sudo helper",
    );
  }
  const uid = Number(uidText);
  const eligibility = await inspectSshUnixAccount(username, options.runGetent);
  if (!eligibility.eligible) {
    throw new Error(`Unix account is not eligible: ${eligibility.reason}`);
  }
  const account = eligibility.account;
  if (account.uid !== uid) {
    throw new Error("sudo identity does not match the NSS Unix account");
  }
  return issueProvisioningGrantForAccount(account, options);
}

export async function issueProvisioningGrantForAccount(
  account: UnixAccount,
  options: {
    configPath?: string;
    adminStatePath?: string;
    routeBindingsPath?: string;
    renewalCapability?: string;
    now?: Date;
  } = {},
): Promise<SelfProvisioningGrant> {
  const home = await stat(account.home);
  if (!home.isDirectory() || home.uid !== account.uid) {
    throw new Error("Unix account home is not owned by the requesting user");
  }
  const now = options.now ?? new Date();
  const installed = await loadHostProvisioner(options.configPath, now);
  const adminState = await AdminStateDatabase.open(
    options.adminStatePath ?? ADMIN_STATE_FILE,
    { create: true },
  );
  try {
    const current = await adminState.admin.get(account.username);
    if (
      current &&
      (current.status === "disabled" ||
        current.status === "removal_pending" ||
        current.status === "removing" ||
        current.status === "removed")
    ) {
      throw new Error(
        "CodexEverywhere access is disabled; contact the host administrator",
      );
    }
    await adminState.admin.register(account);
  } finally {
    await adminState.close();
  }
  const routeBinding = options.routeBindingsPath
    ? await resolveProvisionedRouteBinding(
        options.routeBindingsPath,
        account,
        installed,
        options.renewalCapability,
        now,
      )
    : undefined;
  const issued = issueProvisionedRouteCapability(
    installed.credential,
    {
      loginName: account.username,
      ...(routeBinding ? { routeId: routeBinding.routeId } : {}),
    },
    now,
  );
  if (options.routeBindingsPath) {
    await saveProvisionedRouteBinding(
      options.routeBindingsPath,
      account,
      installed.credential.installationId,
      issued.payload.routeId,
      routeBinding,
      now,
    );
  }
  return {
    version: 1,
    username: account.username,
    uid: account.uid,
    origin: installed.origin,
    relayEndpoint: installed.relayEndpoint,
    routeId: issued.payload.routeId,
    routeCapability: issued.capability,
    ...(installed.defaultCodexNetwork
      ? { defaultCodexNetwork: installed.defaultCodexNetwork }
      : {}),
  };
}

export function validateInstalledHostProvisioner(
  value: unknown,
  now = new Date(),
): InstalledHostProvisioner {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid installed host provisioner");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== INSTALLED_PROVISIONER_VERSION ||
    typeof record.origin !== "string" ||
    typeof record.relayEndpoint !== "string"
  ) {
    throw new Error("Invalid installed host provisioner");
  }
  const origin = normalizeOrigin(record.origin);
  const relayEndpoint = normalizeRelayEndpoint(record.relayEndpoint);
  const credential = parseHostProvisionerCredential(record.credential, now);
  const renewalVerificationCredentials =
    record.renewalVerificationCredentials === undefined
      ? []
      : parseRenewalVerificationCredentials(
          record.renewalVerificationCredentials,
          credential.installationId,
          now,
        );
  const defaultCodexNetwork = normalizeOptionalCodexNetworkConfig(
    record.defaultCodexNetwork,
  );
  return {
    version: INSTALLED_PROVISIONER_VERSION,
    origin,
    relayEndpoint,
    credential,
    ...(renewalVerificationCredentials.length > 0
      ? { renewalVerificationCredentials }
      : {}),
    ...(defaultCodexNetwork ? { defaultCodexNetwork } : {}),
  };
}

async function readRenewalVerificationCredentials(
  path: string,
  installationId: string,
  nextCredential: HostProvisionerCredential,
  now: Date,
): Promise<HostProvisionerCredential[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid existing host provisioner configuration");
  }
  const record = value as Record<string, unknown>;
  if (
    record.renewalVerificationCredentials !== undefined &&
    !Array.isArray(record.renewalVerificationCredentials)
  ) {
    throw new Error("Invalid existing host provisioner configuration");
  }
  const candidates = [
    record.credential,
    ...(Array.isArray(record.renewalVerificationCredentials)
      ? record.renewalVerificationCredentials
      : []),
  ];
  const unique = new Map<string, HostProvisionerCredential>();
  for (const candidate of candidates) {
    const credential = parseHostProvisionerCredentialRecord(candidate);
    if (credential.installationId !== installationId) {
      throw new Error(
        "Host provisioner installation ID cannot change during credential renewal",
      );
    }
    if (Date.parse(credential.expiresAt) <= now.getTime()) continue;
    const key = credentialKey(credential);
    if (key !== credentialKey(nextCredential)) unique.set(key, credential);
  }
  return [...unique.values()];
}

function parseRenewalVerificationCredentials(
  value: unknown,
  installationId: string,
  now: Date,
): HostProvisionerCredential[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid installed host provisioner");
  }
  const unique = new Map<string, HostProvisionerCredential>();
  for (const candidate of value) {
    const credential = parseHostProvisionerCredentialRecord(candidate);
    if (credential.installationId !== installationId) {
      throw new Error("Invalid installed host provisioner");
    }
    if (Date.parse(credential.expiresAt) > now.getTime()) {
      unique.set(credentialKey(credential), credential);
    }
  }
  return [...unique.values()];
}

function credentialKey(credential: HostProvisionerCredential): string {
  return `${credential.installationId}\0${credential.expiresAt}\0${credential.signingKey}`;
}

async function resolveProvisionedRouteBinding(
  path: string,
  account: UnixAccount,
  installed: InstalledHostProvisioner,
  renewalCapability: string | undefined,
  now: Date,
): Promise<ProvisionedRouteBinding | undefined> {
  const registry = await loadProvisionedRouteBindings(path);
  const byUid = registry.bindings.find(
    (binding) => binding.uid === account.uid,
  );
  const byUsername = registry.bindings.find(
    (binding) => binding.username === account.username,
  );
  if (byUid || byUsername) {
    const binding = byUid ?? byUsername;
    if (
      !binding ||
      binding.uid !== account.uid ||
      binding.username !== account.username ||
      binding.home !== account.home ||
      binding.installationId !== installed.credential.installationId ||
      (byUid && byUsername && byUid.routeId !== byUsername.routeId)
    ) {
      throw new Error(
        "Relay route ownership conflicts with the authenticated Unix account",
      );
    }
    if (
      renewalCapability &&
      routeIdFromCapability(renewalCapability) !== binding.routeId
    ) {
      throw new Error("Relay renewal route does not match the bound route");
    }
    return binding;
  }
  if (!renewalCapability) return undefined;
  const credentials = [
    installed.credential,
    ...(installed.renewalVerificationCredentials ?? []),
  ];
  for (const credential of credentials) {
    try {
      const verified = verifyProvisionedUserRouteForRenewal(
        renewalCapability,
        credential,
        { loginName: account.username },
        now,
      );
      return {
        uid: account.uid,
        username: account.username,
        home: account.home,
        installationId: installed.credential.installationId,
        routeId: verified.routeId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    } catch {
      // Only the exact still-valid credential that signed the current route
      // may bootstrap an existing installation into the UID-bound registry.
    }
  }
  throw new Error(
    "The existing Relay capability cannot prove this route; renew before its old credential expires or ask the Relay operator to recover the route",
  );
}

async function saveProvisionedRouteBinding(
  path: string,
  account: UnixAccount,
  installationId: string,
  routeId: string,
  current: ProvisionedRouteBinding | undefined,
  now: Date,
): Promise<void> {
  const registry = await loadProvisionedRouteBindings(path);
  const existing = registry.bindings.find(
    (binding) =>
      binding.uid === account.uid || binding.username === account.username,
  );
  if (existing && existing.routeId !== routeId) {
    throw new Error("Refusing to replace an existing Relay route binding");
  }
  const createdAt =
    existing?.createdAt ?? current?.createdAt ?? now.toISOString();
  const updated: ProvisionedRouteBinding = {
    uid: account.uid,
    username: account.username,
    home: account.home,
    installationId,
    routeId,
    createdAt,
    updatedAt: now.toISOString(),
  };
  const bindings = registry.bindings.filter(
    (binding) =>
      binding.uid !== account.uid && binding.username !== account.username,
  );
  bindings.push(updated);
  bindings.sort((left, right) => left.uid - right.uid);
  await writePrivateJson(path, { version: 1, bindings });
}

async function loadProvisionedRouteBindings(
  path: string,
): Promise<ProvisionedRouteBindings> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return { version: 1, bindings: [] };
    throw error;
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Relay route binding registry");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.bindings)) {
    throw new Error("Invalid Relay route binding registry");
  }
  const bindings = record.bindings.map(parseProvisionedRouteBinding);
  if (
    new Set(bindings.map((binding) => binding.uid)).size !== bindings.length ||
    new Set(bindings.map((binding) => binding.username)).size !==
      bindings.length ||
    new Set(bindings.map((binding) => binding.routeId)).size !== bindings.length
  ) {
    throw new Error("Invalid Relay route binding registry");
  }
  return { version: 1, bindings };
}

function parseProvisionedRouteBinding(value: unknown): ProvisionedRouteBinding {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Relay route binding registry");
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.uid) ||
    Number(record.uid) <= 0 ||
    typeof record.username !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}\$?$/u.test(record.username) ||
    typeof record.home !== "string" ||
    !record.home.startsWith("/") ||
    typeof record.installationId !== "string" ||
    typeof record.routeId !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/u.test(record.routeId) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new Error("Invalid Relay route binding registry");
  }
  return record as ProvisionedRouteBinding;
}

function normalizeOptionalCodexNetworkConfig(
  value: unknown,
): CodexNetworkConfig | undefined {
  if (value === undefined) return undefined;
  if (!validateCodexNetworkConfig(value)) {
    throw new Error("Invalid default Codex network configuration");
  }
  if (value.mode === "direct") return { mode: "direct" };
  return {
    mode: "proxy",
    httpsProxy: value.httpsProxy,
    ...(value.httpProxy ? { httpProxy: value.httpProxy } : {}),
    ...(value.allProxy ? { allProxy: value.allProxy } : {}),
    ...(value.noProxy ? { noProxy: value.noProxy } : {}),
    ...(value.caCertificate ? { caCertificate: value.caCertificate } : {}),
  };
}

function normalizeOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("PWA origin must be an HTTPS origin without a path");
  }
  return origin.origin;
}

function normalizeRelayEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    (endpoint.protocol !== "wss:" && endpoint.protocol !== "ws:") ||
    endpoint.hash
  ) {
    throw new Error("Relay endpoint must use wss:// or ws://");
  }
  return endpoint.toString();
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writePrivateJsonAtomically(path, value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
