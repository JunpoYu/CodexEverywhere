import {
  base64UrlToBytes,
  bytesToBase64Url,
  encodePrologue,
} from "@codex-everywhere/crypto";

export const ROOTLESS_PROVISIONING_VERSION = 1 as const;
export const ROOTLESS_PROVISIONING_REQUEST_TTL_MS = 2 * 60 * 1_000;
export const ROOTLESS_PROVISIONING_RESPONSE_TTL_MS = 5 * 60 * 1_000;
export const ROOTLESS_PROVISIONING_MAX_FILE_BYTES = 64 * 1_024;
export const DEFAULT_ROOTLESS_PROVISIONER_USER = "codexeverywhere";

export type RootlessProvisionerDescriptor = {
  version: typeof ROOTLESS_PROVISIONING_VERSION;
  serviceUsername: string;
  serviceUid: number;
  publicKey: string;
  requestsDirectory: string;
  responsesDirectory: string;
  startedAt: string;
};

export type RootlessProvisioningRequest = {
  version: typeof ROOTLESS_PROVISIONING_VERSION;
  requestId: string;
  createdAt: string;
  handshake: string;
};

export type RootlessProvisioningResponse = {
  version: typeof ROOTLESS_PROVISIONING_VERSION;
  requestId: string;
  createdAt: string;
  handshake: string;
};

export type RootlessProvisioningResult =
  { ok: true; grant: unknown } | { ok: false; error: string };

export function rootlessProvisionerRuntimeDirectory(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid <= 0)
    throw new Error("Invalid rootless provisioner UID");
  return `/tmp/codex-everywhere-provisioner-${String(uid)}`;
}

export function rootlessProvisioningPrologue(requestId: string): Uint8Array {
  assertRequestId(requestId);
  return encodePrologue({
    version: 1,
    userId: "rootless-provisioner",
    nodeId: requestId,
    deviceId: "unix-self-provision",
  });
}

export function parseRootlessProvisionerDescriptor(
  value: unknown,
): RootlessProvisionerDescriptor {
  const record = objectRecord(value, "rootless provisioner descriptor");
  if (
    record.version !== ROOTLESS_PROVISIONING_VERSION ||
    typeof record.serviceUsername !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}\$?$/u.test(record.serviceUsername) ||
    !Number.isSafeInteger(record.serviceUid) ||
    Number(record.serviceUid) <= 0 ||
    typeof record.publicKey !== "string" ||
    base64UrlToBytes(record.publicKey).byteLength !== 32 ||
    typeof record.requestsDirectory !== "string" ||
    !record.requestsDirectory.startsWith("/") ||
    typeof record.responsesDirectory !== "string" ||
    !record.responsesDirectory.startsWith("/") ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) {
    throw new Error("Invalid rootless provisioner descriptor");
  }
  return record as RootlessProvisionerDescriptor;
}

export function parseRootlessProvisioningRequest(
  value: unknown,
): RootlessProvisioningRequest {
  const record = objectRecord(value, "rootless provisioning request");
  if (
    record.version !== ROOTLESS_PROVISIONING_VERSION ||
    typeof record.requestId !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.handshake !== "string"
  ) {
    throw new Error("Invalid rootless provisioning request");
  }
  assertRequestId(record.requestId);
  assertTimestamp(record.createdAt);
  const handshake = base64UrlToBytes(record.handshake);
  if (handshake.byteLength < 48 || handshake.byteLength > 8 * 1_024)
    throw new Error("Invalid rootless provisioning request handshake");
  return record as RootlessProvisioningRequest;
}

export function parseRootlessProvisioningResponse(
  value: unknown,
): RootlessProvisioningResponse {
  const record = objectRecord(value, "rootless provisioning response");
  if (
    record.version !== ROOTLESS_PROVISIONING_VERSION ||
    typeof record.requestId !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.handshake !== "string"
  ) {
    throw new Error("Invalid rootless provisioning response");
  }
  assertRequestId(record.requestId);
  assertTimestamp(record.createdAt);
  const handshake = base64UrlToBytes(record.handshake);
  if (handshake.byteLength < 48 || handshake.byteLength > 64 * 1_024)
    throw new Error("Invalid rootless provisioning response handshake");
  return record as RootlessProvisioningResponse;
}

export function encodeHandshake(value: Uint8Array): string {
  return bytesToBase64Url(value);
}

export function decodeHandshake(value: string): Uint8Array {
  return base64UrlToBytes(value);
}

export function assertFreshProvisioningTimestamp(
  timestamp: string,
  now = Date.now(),
  ttlMs = ROOTLESS_PROVISIONING_REQUEST_TTL_MS,
): void {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || time > now + 30_000 || now - time > ttlMs)
    throw new Error("Rootless provisioning request expired");
}

export function assertRequestId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    throw new Error("Invalid rootless provisioning request ID");
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error("Invalid rootless provisioning timestamp");
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
