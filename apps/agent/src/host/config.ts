import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { syncDirectoryForDurability } from "./durable-file.js";

import type { HostPaths } from "./paths.js";
import {
  validateCodexNetworkConfig,
  type CodexNetworkConfig,
} from "./network.js";

export const HOST_CONFIG_VERSION = 1 as const;

export type DirectTransportConfig = {
  endpoint: string;
  listenHost: string;
  listenPort: number;
};

export type RelayTransportConfig = {
  endpoint: string;
  routeId: string;
  routeCapability: string;
};

export type TransportConfig =
  | { mode: "unconfigured" }
  | ({ mode: "direct" } & DirectTransportConfig)
  | ({ mode: "relay" } & RelayTransportConfig)
  | {
      mode: "hybrid";
      direct: DirectTransportConfig;
      relay: RelayTransportConfig;
    };

export type HostConfig = {
  version: typeof HOST_CONFIG_VERSION;
  nodeId: string;
  transport: TransportConfig;
  webAuthn?: { origin: string; rpId: string };
  network?: CodexNetworkConfig;
};

export function createHostConfig(): HostConfig {
  return {
    version: HOST_CONFIG_VERSION,
    nodeId: randomUUID(),
    transport: { mode: "unconfigured" },
  };
}

export function directTransport(
  transport: TransportConfig,
): DirectTransportConfig | undefined {
  if (transport.mode === "direct")
    return {
      endpoint: transport.endpoint,
      listenHost: transport.listenHost,
      listenPort: transport.listenPort,
    };
  if (transport.mode === "hybrid") return transport.direct;
  return undefined;
}

export function relayTransport(
  transport: TransportConfig,
): RelayTransportConfig | undefined {
  if (transport.mode === "relay")
    return {
      endpoint: transport.endpoint,
      routeId: transport.routeId,
      routeCapability: transport.routeCapability,
    };
  if (transport.mode === "hybrid") return transport.relay;
  return undefined;
}

export function withDirectTransport(
  current: TransportConfig,
  direct: DirectTransportConfig,
): TransportConfig {
  const relay = relayTransport(current);
  return relay
    ? { mode: "hybrid", direct, relay }
    : { mode: "direct", ...direct };
}

export function withRelayTransport(
  current: TransportConfig,
  relay: RelayTransportConfig,
): TransportConfig {
  const direct = directTransport(current);
  return direct
    ? { mode: "hybrid", direct, relay }
    : { mode: "relay", ...relay };
}

export async function initializeHost(paths: HostPaths): Promise<HostConfig> {
  await Promise.all([
    mkdir(paths.home, { recursive: true, mode: 0o700 }),
    mkdir(paths.keysDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.logsDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(paths.home, 0o700),
    chmod(paths.keysDir, 0o700),
    chmod(paths.logsDir, 0o700),
    chmod(paths.runtimeDir, 0o700),
  ]);

  try {
    return await readHostConfig(paths);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const config = createHostConfig();
  await writeHostConfig(paths, config);
  return config;
}

export async function readHostConfig(paths: HostPaths): Promise<HostConfig> {
  const raw: unknown = JSON.parse(await readFile(paths.configFile, "utf8"));
  if (!isHostConfig(raw)) {
    throw new Error(`Invalid host configuration: ${paths.configFile}`);
  }
  return raw;
}

export async function writeHostConfig(
  paths: HostPaths,
  config: HostConfig,
): Promise<void> {
  if (!isHostConfig(config))
    throw new Error("Refusing to write invalid config");
  await mkdir(dirname(paths.configFile), { recursive: true, mode: 0o700 });
  const temporary = `${paths.configFile}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, paths.configFile);
    await syncDirectoryForDurability(dirname(paths.configFile));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isHostConfig(value: unknown): value is HostConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HostConfig>;
  return (
    candidate.version === HOST_CONFIG_VERSION &&
    typeof candidate.nodeId === "string" &&
    isTransportConfig(candidate.transport) &&
    (candidate.webAuthn === undefined ||
      isWebAuthnConfig(candidate.webAuthn)) &&
    (candidate.network === undefined ||
      validateCodexNetworkConfig(candidate.network))
  );
}

function isWebAuthnConfig(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return typeof config.origin === "string" && typeof config.rpId === "string";
}

function isTransportConfig(value: unknown): value is TransportConfig {
  if (!value || typeof value !== "object") return false;
  const transport = value as Record<string, unknown>;
  if (transport.mode === "unconfigured") return true;
  if (transport.mode === "direct") return isDirectTransportConfig(transport);
  if (transport.mode === "relay") return isRelayTransportConfig(transport);
  return (
    transport.mode === "hybrid" &&
    isDirectTransportConfig(transport.direct) &&
    isRelayTransportConfig(transport.relay)
  );
}

function isDirectTransportConfig(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const transport = value as Record<string, unknown>;
  return (
    typeof transport.endpoint === "string" &&
    typeof transport.listenHost === "string" &&
    Number.isSafeInteger(transport.listenPort) &&
    Number(transport.listenPort) > 0 &&
    Number(transport.listenPort) <= 65_535
  );
}

function isRelayTransportConfig(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const transport = value as Record<string, unknown>;
  return (
    typeof transport.endpoint === "string" &&
    typeof transport.routeId === "string" &&
    typeof transport.routeCapability === "string"
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
