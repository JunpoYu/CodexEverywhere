import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import {
  NoiseResponder,
  bytesToBase64Url,
  type StaticKeyPair,
} from "@codex-everywhere/crypto";

import { loadOrCreateHostIdentity } from "../host/identity.js";
import { ProcessLock, writeProcessRecord } from "../host/process-files.js";
import {
  ROOTLESS_PROVISIONING_MAX_FILE_BYTES,
  ROOTLESS_PROVISIONING_RESPONSE_TTL_MS,
  ROOTLESS_PROVISIONING_VERSION,
  ROOTLESS_RELAY_RENEWAL_FEATURE,
  assertFreshProvisioningTimestamp,
  decodeHandshake,
  encodeHandshake,
  parseRootlessProvisioningRequest,
  rootlessProvisionerRuntimeDirectory,
  rootlessProvisioningPrologue,
  type RootlessProvisionerDescriptor,
  type RootlessProvisioningResult,
  type RootlessProvisioningResponse,
} from "../runtime/rootless-provisioning-protocol.js";
import {
  installHostProvisioner,
  issueProvisioningGrantForAccount,
  loadHostProvisioner,
  pruneExpiredRenewalVerificationCredentials,
  setHostProvisionerDefaultCodexNetwork,
  type InstalledHostProvisioner,
} from "./self-provision.js";
import { inspectSshUnixAccountByUid } from "./unix-accounts.js";

const POLL_INTERVAL_MS = 200;
const CREDENTIAL_MAINTENANCE_INTERVAL_MS = 60_000;

export type RootlessProvisionerPaths = {
  home: string;
  configFile: string;
  configMutationLock: string;
  routeBindingsFile: string;
  adminStateFile: string;
  keysDirectory: string;
  logsDirectory: string;
  watchdogScript: string;
  runtimeDirectory: string;
  requestsDirectory: string;
  responsesDirectory: string;
  descriptorFile: string;
  lockFile: string;
  pidFile: string;
};

export function resolveRootlessProvisionerPaths(
  options: { home?: string; uid?: number } = {},
): RootlessProvisionerPaths {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || uid <= 0)
    throw new Error("Rootless provisioner requires a non-root Unix account");
  const home = options.home ?? join(homedir(), ".codex-everywhere-provisioner");
  const runtimeDirectory = rootlessProvisionerRuntimeDirectory(uid);
  return {
    home,
    configFile: join(home, "config.json"),
    configMutationLock: join(home, "config.mutation.lock"),
    routeBindingsFile: join(home, "route-bindings.json"),
    adminStateFile: join(home, "admin-state.sqlite"),
    keysDirectory: join(home, "keys"),
    logsDirectory: join(home, "logs"),
    watchdogScript: join(home, "bin", "watchdog.sh"),
    runtimeDirectory,
    requestsDirectory: join(runtimeDirectory, "requests"),
    responsesDirectory: join(runtimeDirectory, "responses"),
    descriptorFile: join(runtimeDirectory, "descriptor.json"),
    lockFile: join(runtimeDirectory, "provisioner.lock"),
    pidFile: join(runtimeDirectory, "provisioner.pid"),
  };
}

export function installRootlessProvisioner(
  input: {
    origin: string;
    relayEndpoint: string;
    credential: unknown;
    defaultCodexNetwork?: unknown;
  },
  paths = resolveRootlessProvisionerPaths(),
): Promise<InstalledHostProvisioner> {
  return withRootlessProvisionerConfigLock(paths, () =>
    installHostProvisioner(input, paths.configFile),
  );
}

export function setRootlessProvisionerDefaultCodexNetwork(
  value: unknown,
  paths = resolveRootlessProvisionerPaths(),
): Promise<InstalledHostProvisioner> {
  return withRootlessProvisionerConfigLock(paths, () =>
    setHostProvisionerDefaultCodexNetwork(value, paths.configFile),
  );
}

export async function runRootlessProvisioner(
  paths = resolveRootlessProvisionerPaths(),
): Promise<void> {
  const identity = userInfo();
  if ((process.getuid?.() ?? 0) <= 0)
    throw new Error("Rootless provisioner must not run as root");
  await loadHostProvisioner(paths.configFile);
  await prepareRuntimeDirectories(paths);
  const lock = await ProcessLock.acquire(paths.lockFile);
  const provisionerIdentity = await loadOrCreateHostIdentity(
    paths.keysDirectory,
  );
  await writeDescriptor(paths, provisionerIdentity.keyPair.publicKey, {
    username: identity.username,
    uid: identity.uid,
  });
  await writeProcessRecord(paths.pidFile);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    let nextCredentialMaintenance = Date.now();
    while (!stopping) {
      await processPendingRequests(paths, provisionerIdentity.keyPair);
      await cleanupExpiredResponses(paths);
      if (Date.now() >= nextCredentialMaintenance) {
        await withRootlessProvisionerConfigLock(paths, () =>
          pruneExpiredRenewalVerificationCredentials(paths.configFile),
        );
        nextCredentialMaintenance =
          Date.now() + CREDENTIAL_MAINTENANCE_INTERVAL_MS;
      }
      await wait(POLL_INTERVAL_MS);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.all([
      rm(paths.descriptorFile, { force: true }),
      rm(paths.pidFile, { force: true }),
    ]);
    await lock.release();
  }
}

async function withRootlessProvisionerConfigLock<T>(
  paths: RootlessProvisionerPaths,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await chmod(paths.home, 0o700);
  const deadline = Date.now() + 10_000;
  let lock: ProcessLock | undefined;
  while (!lock) {
    try {
      lock = await ProcessLock.acquire(paths.configMutationLock);
    } catch (error) {
      if (
        Date.now() >= deadline ||
        !(error instanceof Error) ||
        !error.message.includes("already running")
      ) {
        throw error;
      }
      await wait(25);
    }
  }
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

export async function processPendingRequests(
  paths: RootlessProvisionerPaths,
  keyPair: StaticKeyPair,
): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(paths.requestsDirectory);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let processed = 0;
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const requestPath = join(paths.requestsDirectory, entry);
    try {
      await processRequestFile(requestPath, paths, keyPair);
      processed += 1;
    } catch {
      // Invalid unauthenticated requests are discarded without reflecting
      // attacker-controlled content into logs or another user's terminal.
    } finally {
      await rm(requestPath, { force: true });
    }
  }
  return processed;
}

export async function processRequestFile(
  requestPath: string,
  paths: RootlessProvisionerPaths,
  keyPair: StaticKeyPair,
  options: {
    now?: number;
    issueGrant?: typeof issueProvisioningGrantForAccount;
    inspectAccount?: typeof inspectSshUnixAccountByUid;
  } = {},
): Promise<void> {
  const { raw, owner } = await readAuthenticatedRequest(requestPath);
  const completed = await createRootlessProvisioningResponse(
    raw,
    owner.uid,
    paths,
    keyPair,
    options,
  );
  if (
    requestPath !== join(paths.requestsDirectory, `${completed.requestId}.json`)
  )
    throw new Error("Rootless provisioning request filename mismatch");
  await writePublicResponse(
    join(paths.responsesDirectory, `${completed.requestId}.json`),
    completed.response,
  );
}

export async function createRootlessProvisioningResponse(
  raw: string,
  ownerUid: number,
  paths: RootlessProvisionerPaths,
  keyPair: StaticKeyPair,
  options: {
    now?: number;
    issueGrant?: typeof issueProvisioningGrantForAccount;
    inspectAccount?: typeof inspectSshUnixAccountByUid;
  } = {},
): Promise<{
  requestId: string;
  response: RootlessProvisioningResponse;
}> {
  const request = parseRootlessProvisioningRequest(JSON.parse(raw) as unknown);
  assertFreshProvisioningTimestamp(request.createdAt, options.now);

  const responder = new NoiseResponder(
    keyPair,
    rootlessProvisioningPrologue(request.requestId),
  );
  const authenticatedPayload = parseAuthenticatedRequestPayload(
    responder.receive(decodeHandshake(request.handshake)),
  );
  if (
    authenticatedPayload.requestId !== request.requestId ||
    authenticatedPayload.createdAt !== request.createdAt
  )
    throw new Error("Rootless provisioning request payload mismatch");
  let result: RootlessProvisioningResult;
  try {
    const eligibility = await (
      options.inspectAccount ?? inspectSshUnixAccountByUid
    )(ownerUid);
    if (!eligibility.eligible)
      throw new Error(`Unix account is not eligible: ${eligibility.reason}`);
    const grant = await (
      options.issueGrant ?? issueProvisioningGrantForAccount
    )(eligibility.account, {
      configPath: paths.configFile,
      adminStatePath: paths.adminStateFile,
      routeBindingsPath: paths.routeBindingsFile,
      ...(authenticatedPayload.operation === "renew-relay"
        ? { renewalCapability: authenticatedPayload.routeCapability }
        : {}),
      now: new Date(options.now ?? Date.now()),
    });
    result = { ok: true, grant };
  } catch (error) {
    result = { ok: false, error: safeProvisioningError(error) };
  }
  const completed = responder.finish(
    Buffer.from(JSON.stringify(result), "utf8"),
  );
  const response: RootlessProvisioningResponse = {
    version: ROOTLESS_PROVISIONING_VERSION,
    requestId: request.requestId,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    handshake: encodeHandshake(completed.message),
  };
  return { requestId: request.requestId, response };
}

async function prepareRuntimeDirectories(
  paths: RootlessProvisionerPaths,
): Promise<void> {
  await Promise.all([
    mkdir(paths.home, { recursive: true, mode: 0o700 }),
    mkdir(paths.keysDirectory, { recursive: true, mode: 0o700 }),
    mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.watchdogScript), { recursive: true, mode: 0o700 }),
    mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o711 }),
    mkdir(paths.requestsDirectory, { recursive: true, mode: 0o1733 }),
    mkdir(paths.responsesDirectory, { recursive: true, mode: 0o711 }),
  ]);
  await Promise.all([
    chmod(paths.home, 0o700),
    chmod(paths.keysDirectory, 0o700),
    chmod(paths.logsDirectory, 0o700),
    chmod(paths.runtimeDirectory, 0o711),
    chmod(paths.requestsDirectory, 0o1733),
    chmod(paths.responsesDirectory, 0o711),
  ]);
  const uid = process.getuid?.();
  for (const path of [
    paths.home,
    paths.runtimeDirectory,
    paths.requestsDirectory,
    paths.responsesDirectory,
  ]) {
    const value = await stat(path);
    const expectedMode =
      path === paths.home
        ? 0o700
        : path === paths.requestsDirectory
          ? 0o1733
          : 0o711;
    if (
      !value.isDirectory() ||
      value.uid !== uid ||
      (value.mode & 0o7777) !== expectedMode
    )
      throw new Error(`Unsafe rootless provisioner directory: ${path}`);
  }
}

async function writeDescriptor(
  paths: RootlessProvisionerPaths,
  publicKey: Uint8Array,
  service: { username: string; uid: number },
): Promise<void> {
  const descriptor: RootlessProvisionerDescriptor = {
    version: ROOTLESS_PROVISIONING_VERSION,
    serviceUsername: service.username,
    serviceUid: service.uid,
    publicKey: bytesToBase64Url(publicKey),
    requestsDirectory: paths.requestsDirectory,
    responsesDirectory: paths.responsesDirectory,
    startedAt: new Date().toISOString(),
    features: [ROOTLESS_RELAY_RENEWAL_FEATURE],
  };
  await writeFile(paths.descriptorFile, `${JSON.stringify(descriptor)}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "w",
  });
  await chmod(paths.descriptorFile, 0o644);
}

async function readAuthenticatedRequest(
  path: string,
): Promise<{ raw: string; owner: Stats }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const owner = await handle.stat();
    validateRootlessRequestFile(owner, process.getuid?.());
    return { raw: await readBoundedRequest(handle), owner };
  } finally {
    await handle.close();
  }
}

async function readBoundedRequest(handle: FileHandle): Promise<string> {
  const buffer = Buffer.alloc(ROOTLESS_PROVISIONING_MAX_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > ROOTLESS_PROVISIONING_MAX_FILE_BYTES)
    throw new Error("Rootless provisioning request is too large");
  return buffer.subarray(0, offset).toString("utf8");
}

export function validateRootlessRequestFile(
  owner: Pick<Stats, "isFile" | "nlink" | "uid" | "mode" | "size">,
  serviceUid: number | undefined,
): void {
  if (
    !owner.isFile() ||
    owner.nlink !== 1 ||
    owner.uid <= 0 ||
    owner.uid === serviceUid ||
    (owner.mode & 0o022) !== 0 ||
    owner.size <= 0 ||
    owner.size > ROOTLESS_PROVISIONING_MAX_FILE_BYTES
  ) {
    throw new Error("Unsafe rootless provisioning request file");
  }
}

async function writePublicResponse(
  path: string,
  response: RootlessProvisioningResponse,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(`${JSON.stringify(response)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o644);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cleanupExpiredResponses(
  paths: RootlessProvisionerPaths,
): Promise<void> {
  const entries = await readdir(paths.responsesDirectory).catch(() => []);
  const cutoff = Date.now() - ROOTLESS_PROVISIONING_RESPONSE_TTL_MS;
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(paths.responsesDirectory, entry);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function safeProvisioningError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/disabled/u.test(message)) return "CodexEverywhere access is disabled";
  if (/eligible|NSS|home/u.test(message)) return message;
  if (/Relay|route|credential|renew/u.test(message)) return message;
  return "Host provisioning failed";
}

function parseAuthenticatedRequestPayload(value: Uint8Array): {
  requestId: string;
  createdAt: string;
  operation: "initialize" | "renew-relay";
  routeCapability?: string;
} {
  const parsed: unknown = JSON.parse(Buffer.from(value).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid authenticated provisioning request");
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.requestId !== "string" ||
    typeof record.createdAt !== "string" ||
    (record.operation !== undefined &&
      record.operation !== "initialize" &&
      record.operation !== "renew-relay") ||
    (record.routeCapability !== undefined &&
      (typeof record.routeCapability !== "string" ||
        record.routeCapability.length > 8 * 1_024))
  )
    throw new Error("Invalid authenticated provisioning request");
  const operation = record.operation ?? "initialize";
  if (
    (operation === "renew-relay") !==
    (typeof record.routeCapability === "string")
  ) {
    throw new Error("Invalid authenticated provisioning request");
  }
  return {
    requestId: record.requestId,
    createdAt: record.createdAt,
    operation,
    ...(typeof record.routeCapability === "string"
      ? { routeCapability: record.routeCapability }
      : {}),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
