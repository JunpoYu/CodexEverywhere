import { spawn } from "node:child_process";
import { userInfo } from "node:os";

import { routeIdFromCapability } from "@codex-everywhere/protocol/relay-capability";

import {
  initializeHost,
  relayTransport,
  withRelayTransport,
  writeHostConfig,
  type HostConfig,
} from "../host/config.js";
import {
  validateCodexNetworkConfig,
  type CodexNetworkConfig,
} from "../host/network.js";
import type { HostPaths } from "../host/paths.js";

export const SELF_PROVISION_HELPER_PATH =
  "/usr/local/libexec/ce-self-provision";

export type UserSelfProvisioningGrant = {
  version: 1;
  username: string;
  uid: number;
  origin: string;
  relayEndpoint: string;
  routeId: string;
  routeCapability: string;
  defaultCodexNetwork?: CodexNetworkConfig;
};

export async function requestSelfProvisioningGrant(
  options: {
    sudoPath?: string;
    helperPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<UserSelfProvisioningGrant> {
  const sudoPath = options.sudoPath ?? "/usr/bin/sudo";
  const helperPath = options.helperPath ?? SELF_PROVISION_HELPER_PATH;
  const result = await run(sudoPath, ["-n", helperPath], options.env);
  if (result.code !== 0) {
    throw new Error(
      `Self-service initialization is unavailable. Ask the HPC administrator to install the host provisioner once. ${result.stderr || "The sudo helper failed."}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("The host self-provisioning helper returned invalid data");
  }
  return parseSelfProvisioningGrant(value);
}

export async function applySelfProvisioningGrant(
  paths: HostPaths,
  grantValue: unknown,
  currentUser: { username: string; uid: number } = {
    username: userInfo().username,
    uid: process.getuid?.() ?? -1,
  },
): Promise<HostConfig> {
  const grant = parseSelfProvisioningGrant(grantValue);
  if (
    grant.username !== currentUser.username ||
    grant.uid !== currentUser.uid
  ) {
    throw new Error("Host provisioner returned a different Unix identity");
  }
  const config = await initializeHost(paths);
  const origin = new URL(grant.origin);
  const updated: HostConfig = {
    ...config,
    transport: withRelayTransport(config.transport, {
      endpoint: grant.relayEndpoint,
      routeId: grant.routeId,
      routeCapability: grant.routeCapability,
    }),
    webAuthn: { origin: origin.origin, rpId: origin.hostname },
    ...(config.network === undefined && grant.defaultCodexNetwork
      ? { network: grant.defaultCodexNetwork }
      : {}),
  };
  await writeHostConfig(paths, updated);
  return updated;
}

export async function applyRelayCapabilityRenewal(
  paths: HostPaths,
  grantValue: unknown,
  expectedCapability: string,
  currentUser: { username: string; uid: number } = {
    username: userInfo().username,
    uid: process.getuid?.() ?? -1,
  },
): Promise<HostConfig> {
  const grant = parseSelfProvisioningGrant(grantValue);
  if (
    grant.username !== currentUser.username ||
    grant.uid !== currentUser.uid
  ) {
    throw new Error("Host provisioner returned a different Unix identity");
  }
  const config = await initializeHost(paths);
  const relay = relayTransport(config.transport);
  if (!relay) throw new Error("Relay transport is not configured");
  if (relay.routeCapability !== expectedCapability) {
    throw new Error("Relay transport changed while applying its renewal");
  }
  if (relay.routeId !== grant.routeId) {
    throw new Error("Host provisioner attempted to replace the Relay route ID");
  }
  const updated: HostConfig = {
    ...config,
    transport: withRelayTransport(config.transport, {
      ...relay,
      routeCapability: grant.routeCapability,
    }),
  };
  await writeHostConfig(paths, updated);
  return updated;
}

export function parseSelfProvisioningGrant(
  value: unknown,
): UserSelfProvisioningGrant {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid self-provisioning grant");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.username !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}\$?$/u.test(record.username) ||
    typeof record.uid !== "number" ||
    !Number.isSafeInteger(record.uid) ||
    record.uid <= 0 ||
    typeof record.origin !== "string" ||
    typeof record.relayEndpoint !== "string" ||
    typeof record.routeId !== "string" ||
    typeof record.routeCapability !== "string"
  ) {
    throw new Error("Invalid self-provisioning grant");
  }
  const origin = new URL(record.origin);
  const relayEndpoint = new URL(record.relayEndpoint);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (relayEndpoint.protocol !== "wss:" && relayEndpoint.protocol !== "ws:") ||
    routeIdFromCapability(record.routeCapability) !== record.routeId
  ) {
    throw new Error("Invalid self-provisioning grant");
  }
  const defaultCodexNetwork = normalizeOptionalCodexNetworkConfig(
    record.defaultCodexNetwork,
  );
  return {
    version: 1,
    username: record.username,
    uid: record.uid,
    origin: origin.origin,
    relayEndpoint: relayEndpoint.toString(),
    routeId: record.routeId,
    routeCapability: record.routeCapability,
    ...(defaultCodexNetwork ? { defaultCodexNetwork } : {}),
  };
}

function normalizeOptionalCodexNetworkConfig(
  value: unknown,
): CodexNetworkConfig | undefined {
  if (value === undefined) return undefined;
  if (!validateCodexNetworkConfig(value)) {
    throw new Error("Invalid self-provisioning grant");
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

function run(
  command: string,
  args: string[],
  env = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 64 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16 * 1024) stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Self-provisioning helper ${signal}`));
      else
        resolve({
          code: code ?? 1,
          stdout,
          stderr: stderr.trim(),
        });
    });
  });
}
