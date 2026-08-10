import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  NoiseInitiator,
  base64UrlToBytes,
  generateStaticKeyPair,
} from "@codex-everywhere/crypto";

import { inspectSshUnixAccount } from "../admin/unix-accounts.js";
import { parseAdminRouteRenewalGrant } from "../admin/admin-route-provisioning.js";
import { parseSelfProvisioningGrant } from "./self-service-provisioning.js";
import {
  DEFAULT_ROOTLESS_PROVISIONER_USER,
  ROOTLESS_ADMIN_RELAY_RENEWAL_FEATURE,
  ROOTLESS_PROVISIONING_MAX_FILE_BYTES,
  ROOTLESS_PROVISIONING_VERSION,
  ROOTLESS_RELAY_RENEWAL_FEATURE,
  assertFreshProvisioningTimestamp,
  decodeHandshake,
  encodeHandshake,
  parseRootlessProvisionerDescriptor,
  parseRootlessProvisioningResponse,
  rootlessProvisionerRuntimeDirectory,
  rootlessProvisioningPrologue,
  type RootlessProvisioningRequest,
  type RootlessProvisioningResult,
} from "./rootless-provisioning-protocol.js";

const RESPONSE_TIMEOUT_MS = 15_000;
const RESPONSE_POLL_MS = 100;

export class RootlessProvisionerUnavailableError extends Error {}

export async function requestRootlessSelfProvisioningGrant(
  options: {
    serviceUsername?: string;
    now?: () => number;
    timeoutMs?: number;
    renewalCapability?: string;
  } = {},
) {
  const grant = await requestRootlessProvisioningGrant({
    ...options,
    operation: options.renewalCapability ? "renew-relay" : "initialize",
  });
  return parseSelfProvisioningGrant(grant);
}

export async function requestRootlessAdminRouteRenewal(options: {
  serviceUsername?: string;
  now?: () => number;
  timeoutMs?: number;
  renewalCapability: string;
}) {
  const grant = await requestRootlessProvisioningGrant({
    ...options,
    operation: "renew-admin-relay",
  });
  return parseAdminRouteRenewalGrant(grant);
}

async function requestRootlessProvisioningGrant(options: {
  serviceUsername?: string;
  now?: () => number;
  timeoutMs?: number;
  operation: "initialize" | "renew-relay" | "renew-admin-relay";
  renewalCapability?: string;
}): Promise<unknown> {
  const serviceUsername =
    options.serviceUsername ??
    process.env.CE_PROVISIONER_USER ??
    DEFAULT_ROOTLESS_PROVISIONER_USER;
  const eligibility = await inspectSshUnixAccount(serviceUsername);
  if (!eligibility.eligible)
    throw new RootlessProvisionerUnavailableError(
      `Rootless provisioner account is unavailable: ${eligibility.reason}`,
    );
  const serviceUid = eligibility.account.uid;
  const runtimeDirectory = rootlessProvisionerRuntimeDirectory(serviceUid);
  const descriptorFile = join(runtimeDirectory, "descriptor.json");
  let descriptorRaw: string;
  try {
    const descriptorStat = await stat(descriptorFile);
    const runtimeStat = await stat(runtimeDirectory);
    if (
      !descriptorStat.isFile() ||
      descriptorStat.uid !== serviceUid ||
      (descriptorStat.mode & 0o022) !== 0 ||
      !runtimeStat.isDirectory() ||
      runtimeStat.uid !== serviceUid ||
      (runtimeStat.mode & 0o022) !== 0
    ) {
      throw new Error("Unsafe rootless provisioner descriptor ownership");
    }
    descriptorRaw = await readFile(descriptorFile, "utf8");
  } catch (error) {
    if (isMissing(error))
      throw new RootlessProvisionerUnavailableError(
        "Rootless provisioner is not running",
      );
    throw error;
  }
  const descriptor = parseRootlessProvisionerDescriptor(
    JSON.parse(descriptorRaw) as unknown,
  );
  if (
    descriptor.serviceUsername !== serviceUsername ||
    descriptor.serviceUid !== serviceUid ||
    descriptor.requestsDirectory !== join(runtimeDirectory, "requests") ||
    descriptor.responsesDirectory !== join(runtimeDirectory, "responses")
  ) {
    throw new Error("Rootless provisioner descriptor identity mismatch");
  }
  const [requestsStat, responsesStat] = await Promise.all([
    stat(descriptor.requestsDirectory),
    stat(descriptor.responsesDirectory),
  ]);
  if (
    !requestsStat.isDirectory() ||
    requestsStat.uid !== serviceUid ||
    (requestsStat.mode & 0o7777) !== 0o1733 ||
    !responsesStat.isDirectory() ||
    responsesStat.uid !== serviceUid ||
    (responsesStat.mode & 0o7777) !== 0o711
  )
    throw new Error("Unsafe rootless provisioner queue ownership");
  if (options.operation === "renew-relay") {
    assertRootlessProvisionerSupportsRelayRenewal(descriptor.features);
  } else if (options.operation === "renew-admin-relay") {
    assertRootlessProvisionerSupportsAdminRelayRenewal(descriptor.features);
  }

  const requestId = randomUUID();
  const createdAt = new Date((options.now ?? Date.now)()).toISOString();
  const initiator = new NoiseInitiator(
    generateStaticKeyPair(),
    base64UrlToBytes(descriptor.publicKey),
    rootlessProvisioningPrologue(requestId),
  );
  const request: RootlessProvisioningRequest = {
    version: ROOTLESS_PROVISIONING_VERSION,
    requestId,
    createdAt,
    handshake: encodeHandshake(
      initiator.start(
        Buffer.from(
          JSON.stringify({
            requestId,
            createdAt,
            operation: options.operation,
            ...(options.renewalCapability
              ? { routeCapability: options.renewalCapability }
              : {}),
          }),
          "utf8",
        ),
      ),
    ),
  };
  const requestPath = join(descriptor.requestsDirectory, `${requestId}.json`);
  await writeRequest(requestPath, request);

  const responsePath = join(descriptor.responsesDirectory, `${requestId}.json`);
  const deadline = Date.now() + (options.timeoutMs ?? RESPONSE_TIMEOUT_MS);
  let responseRaw: string | undefined;
  while (Date.now() < deadline) {
    try {
      const responseStat = await stat(responsePath);
      if (
        !responseStat.isFile() ||
        responseStat.uid !== serviceUid ||
        (responseStat.mode & 0o022) !== 0 ||
        responseStat.size <= 0 ||
        responseStat.size > ROOTLESS_PROVISIONING_MAX_FILE_BYTES
      ) {
        throw new Error("Unsafe rootless provisioning response file");
      }
      responseRaw = await readFile(responsePath, "utf8");
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      await wait(RESPONSE_POLL_MS);
    }
  }
  if (!responseRaw)
    throw new RootlessProvisionerUnavailableError(
      "Rootless provisioner did not respond in time",
    );
  const response = parseRootlessProvisioningResponse(
    JSON.parse(responseRaw) as unknown,
  );
  if (response.requestId !== requestId)
    throw new Error("Rootless provisioning response ID mismatch");
  assertFreshProvisioningTimestamp(response.createdAt, Date.now());
  const completed = initiator.finish(decodeHandshake(response.handshake));
  const result = parseResult(
    JSON.parse(Buffer.from(completed.payload).toString("utf8")) as unknown,
  );
  if (!result.ok) throw new Error(result.error);
  return result.grant;
}

export function assertRootlessProvisionerSupportsRelayRenewal(
  features: readonly string[] | undefined,
): void {
  if (!features?.includes(ROOTLESS_RELAY_RENEWAL_FEATURE)) {
    throw new RootlessProvisionerUnavailableError(
      "Rootless provisioner must be restarted on the current release before Relay renewal",
    );
  }
}

export function assertRootlessProvisionerSupportsAdminRelayRenewal(
  features: readonly string[] | undefined,
): void {
  if (!features?.includes(ROOTLESS_ADMIN_RELAY_RENEWAL_FEATURE)) {
    throw new RootlessProvisionerUnavailableError(
      "Rootless provisioner must be restarted on the current release before administrator Relay renewal",
    );
  }
}

async function writeRequest(
  path: string,
  request: RootlessProvisioningRequest,
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
    await handle.writeFile(`${JSON.stringify(request)}\n`, "utf8");
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

function parseResult(value: unknown): RootlessProvisioningResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid rootless provisioning result");
  const record = value as Record<string, unknown>;
  if (record.ok === true && "grant" in record)
    return { ok: true, grant: record.grant };
  if (record.ok === false && typeof record.error === "string")
    return { ok: false, error: record.error };
  throw new Error("Invalid rootless provisioning result");
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
