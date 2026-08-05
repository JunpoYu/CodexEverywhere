import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  issueProvisionedRouteCapability,
  parseHostProvisionerCredential,
  type HostProvisionerCredential,
} from "@codex-everywhere/protocol/relay-capability";

import {
  validateCodexNetworkConfig,
  type CodexNetworkConfig,
} from "../host/network.js";
import { inspectSshUnixAccount, type GetentRunner } from "./unix-accounts.js";
import { HostStateStore } from "../host/state-store.js";
import { ADMIN_STATE_FILE } from "./access-policy.js";
import { AdminUserRegistry } from "./registry.js";

export const INSTALLED_PROVISIONER_VERSION = 1 as const;
export const HOST_PROVISIONER_CONFIG_PATH =
  "/etc/codex-everywhere/provisioner.json";

export type InstalledHostProvisioner = {
  version: typeof INSTALLED_PROVISIONER_VERSION;
  origin: string;
  relayEndpoint: string;
  credential: HostProvisionerCredential;
  defaultCodexNetwork?: CodexNetworkConfig;
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
): Promise<InstalledHostProvisioner> {
  const installed = validateInstalledHostProvisioner({
    version: INSTALLED_PROVISIONER_VERSION,
    origin: input.origin,
    relayEndpoint: input.relayEndpoint,
    credential: input.credential,
    defaultCodexNetwork: input.defaultCodexNetwork,
  });
  await writePrivateJson(path, installed);
  return installed;
}

export async function loadHostProvisioner(
  path = HOST_PROVISIONER_CONFIG_PATH,
): Promise<InstalledHostProvisioner> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  return validateInstalledHostProvisioner(value);
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
  const home = await stat(account.home);
  if (!home.isDirectory() || home.uid !== account.uid) {
    throw new Error("Unix account home is not owned by the requesting user");
  }
  const installed = await loadHostProvisioner(options.configPath);
  const adminState = await HostStateStore.open(
    options.adminStatePath ?? ADMIN_STATE_FILE,
  );
  try {
    const registry = new AdminUserRegistry(adminState);
    const current = await registry.get(account.username);
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
    await registry.register(account);
  } finally {
    await adminState.close();
  }
  const issued = issueProvisionedRouteCapability(installed.credential, {
    loginName: account.username,
  });
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
  const credential = parseHostProvisionerCredential(record.credential);
  const defaultCodexNetwork = normalizeOptionalCodexNetworkConfig(
    record.defaultCodexNetwork,
  );
  return {
    version: INSTALLED_PROVISIONER_VERSION,
    origin,
    relayEndpoint,
    credential,
    ...(defaultCodexNetwork ? { defaultCodexNetwork } : {}),
  };
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
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
