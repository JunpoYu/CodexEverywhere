import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const RELAY_CAPABILITY_VERSION = 4 as const;
export const HOST_PROVISIONER_VERSION = 1 as const;

export type RelayPrincipal = "user" | "host-admin";

export type LegacyRouteCapabilityPayload = {
  version: 1 | 2;
  purpose: "agent-route";
  routeId: string;
  loginId?: string;
  issuedAt: string;
  expiresAt?: string;
};

export type ProvisionedRouteCapabilityPayload = {
  version: typeof RELAY_CAPABILITY_VERSION;
  purpose: "agent-route" | "host-admin-route";
  principal: RelayPrincipal;
  routeId: string;
  installationId: string;
  loginName: string;
  issuedAt: string;
  expiresAt?: string;
  provisionerExpiresAt: string;
};

export type LegacyProvisionedRouteCapabilityPayload = {
  version: 3;
  purpose: "agent-route";
  routeId: string;
  installationId: string;
  loginName: string;
  issuedAt: string;
  expiresAt?: string;
  provisionerExpiresAt: string;
};

export type RouteCapabilityPayload =
  | LegacyRouteCapabilityPayload
  | LegacyProvisionedRouteCapabilityPayload
  | ProvisionedRouteCapabilityPayload;

export type HostProvisionerCredential = {
  version: typeof HOST_PROVISIONER_VERSION;
  purpose: "host-provisioner";
  installationId: string;
  issuedAt: string;
  expiresAt: string;
  signingKey: string;
};

export function generateRelaySigningKey(): Uint8Array {
  return randomBytes(32);
}

export function issueRouteCapability(
  signingKey: Uint8Array,
  options: { expiresAt?: Date; loginName?: string; routeId?: string } = {},
): { capability: string; payload: LegacyRouteCapabilityPayload } {
  assertSigningKey(signingKey);
  const payload: LegacyRouteCapabilityPayload = {
    version: 2,
    purpose: "agent-route",
    routeId: options.routeId ?? randomRouteId(),
    ...(options.loginName
      ? { loginId: relayLoginId(signingKey, options.loginName) }
      : {}),
    issuedAt: new Date().toISOString(),
    ...(options.expiresAt
      ? { expiresAt: options.expiresAt.toISOString() }
      : {}),
  };
  assertRouteId(payload.routeId);
  return signCapability(payload, signingKey, "ce-relay-v1");
}

export function issueHostProvisionerCredential(
  relaySigningKey: Uint8Array,
  options: { installationId: string; expiresAt: Date },
): HostProvisionerCredential {
  assertSigningKey(relaySigningKey);
  const installationId = normalizeInstallationId(options.installationId);
  const expiresAt = options.expiresAt.toISOString();
  if (options.expiresAt.getTime() <= Date.now()) {
    throw new Error("Host provisioner expiration must be in the future");
  }
  return {
    version: HOST_PROVISIONER_VERSION,
    purpose: "host-provisioner",
    installationId,
    issuedAt: new Date().toISOString(),
    expiresAt,
    signingKey: Buffer.from(
      deriveProvisionerSigningKey(relaySigningKey, installationId, expiresAt),
    ).toString("base64url"),
  };
}

export function issueProvisionedRouteCapability(
  credentialValue: unknown,
  options: { loginName: string; expiresAt?: Date; routeId?: string },
  now = new Date(),
): { capability: string; payload: ProvisionedRouteCapabilityPayload } {
  const credential = parseHostProvisionerCredential(credentialValue, now);
  if (options.expiresAt && options.expiresAt.getTime() <= now.getTime()) {
    throw new Error("Route capability expiration must be in the future");
  }
  if (
    options.expiresAt &&
    options.expiresAt.getTime() > Date.parse(credential.expiresAt)
  ) {
    throw new Error("Route capability cannot outlive its host provisioner");
  }
  const payload: ProvisionedRouteCapabilityPayload = {
    version: RELAY_CAPABILITY_VERSION,
    purpose: "agent-route",
    principal: "user",
    routeId: options.routeId ?? randomRouteId(),
    installationId: credential.installationId,
    loginName: normalizeLoginName(options.loginName),
    issuedAt: now.toISOString(),
    ...(options.expiresAt
      ? { expiresAt: options.expiresAt.toISOString() }
      : {}),
    provisionerExpiresAt: credential.expiresAt,
  };
  assertRouteId(payload.routeId);
  const signingKey = Buffer.from(credential.signingKey, "base64url");
  assertSigningKey(signingKey);
  return signCapability(payload, signingKey, "ce-relay-provisioned-v1");
}

export function issueProvisionedAdminRouteCapability(
  credentialValue: unknown,
  options: { adminHandle: string; expiresAt?: Date; routeId?: string },
  now = new Date(),
): { capability: string; payload: ProvisionedRouteCapabilityPayload } {
  const credential = parseHostProvisionerCredential(credentialValue, now);
  if (options.expiresAt && options.expiresAt.getTime() <= now.getTime()) {
    throw new Error("Route capability expiration must be in the future");
  }
  if (
    options.expiresAt &&
    options.expiresAt.getTime() > Date.parse(credential.expiresAt)
  ) {
    throw new Error("Route capability cannot outlive its host provisioner");
  }
  const payload: ProvisionedRouteCapabilityPayload = {
    version: RELAY_CAPABILITY_VERSION,
    purpose: "host-admin-route",
    principal: "host-admin",
    routeId: options.routeId ?? randomRouteId(),
    installationId: credential.installationId,
    loginName: normalizeLoginName(options.adminHandle),
    issuedAt: now.toISOString(),
    ...(options.expiresAt
      ? { expiresAt: options.expiresAt.toISOString() }
      : {}),
    provisionerExpiresAt: credential.expiresAt,
  };
  assertRouteId(payload.routeId);
  const signingKey = Buffer.from(credential.signingKey, "base64url");
  assertSigningKey(signingKey);
  return signCapability(payload, signingKey, "ce-relay-provisioned-v1");
}

export function parseHostProvisionerCredential(
  value: unknown,
  now = new Date(),
): HostProvisionerCredential {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid host provisioner credential");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== HOST_PROVISIONER_VERSION ||
    record.purpose !== "host-provisioner" ||
    typeof record.installationId !== "string" ||
    normalizeInstallationId(record.installationId) !== record.installationId ||
    typeof record.issuedAt !== "string" ||
    !validDate(record.issuedAt) ||
    typeof record.expiresAt !== "string" ||
    !validDate(record.expiresAt) ||
    Date.parse(record.expiresAt) <= now.getTime() ||
    typeof record.signingKey !== "string" ||
    Buffer.from(record.signingKey, "base64url").byteLength !== 32
  ) {
    throw new Error("Invalid or expired host provisioner credential");
  }
  return record as HostProvisionerCredential;
}

export function relayLoginId(
  signingKey: Uint8Array,
  loginName: string,
): string {
  assertSigningKey(signingKey);
  return createHmac("sha256", signingKey)
    .update(`ce-relay-login-v1\0${normalizeLoginName(loginName)}`)
    .digest("base64url")
    .slice(0, 32);
}

export function relayPrincipalLoginId(
  signingKey: Uint8Array,
  principal: RelayPrincipal,
  loginName: string,
): string {
  assertSigningKey(signingKey);
  if (principal === "user") return relayLoginId(signingKey, loginName);
  return createHmac("sha256", signingKey)
    .update(`ce-relay-login-v2\0${principal}\0${normalizeLoginName(loginName)}`)
    .digest("base64url")
    .slice(0, 32);
}

export function routeCapabilityPrincipal(
  payload: RouteCapabilityPayload,
): RelayPrincipal {
  return payload.version === RELAY_CAPABILITY_VERSION
    ? payload.principal
    : "user";
}

export function routeCapabilityLoginId(
  payload: RouteCapabilityPayload,
  relaySigningKey: Uint8Array,
): string | undefined {
  if (payload.version === RELAY_CAPABILITY_VERSION) {
    return relayPrincipalLoginId(
      relaySigningKey,
      payload.principal,
      payload.loginName,
    );
  }
  return payload.version === 3
    ? relayLoginId(relaySigningKey, payload.loginName)
    : payload.loginId;
}

export function normalizeLoginName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 64 ||
    !/^[A-Za-z_][A-Za-z0-9_.-]{0,62}\$?$/u.test(normalized)
  ) {
    throw new Error("Invalid Relay login name");
  }
  return normalized;
}

export function normalizeInstallationId(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)
  ) {
    throw new Error("Invalid Relay installation ID");
  }
  return normalized;
}

export function verifyRouteCapability(
  capability: string,
  relaySigningKey: Uint8Array,
  now = new Date(),
): RouteCapabilityPayload {
  assertSigningKey(relaySigningKey);
  const parts = capability.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid route capability");
  }
  const value: unknown = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  );
  if (!isCapabilityPayload(value)) {
    throw new Error("Invalid route capability payload");
  }
  const signingKey =
    value.version === RELAY_CAPABILITY_VERSION || value.version === 3
      ? deriveProvisionerSigningKey(
          relaySigningKey,
          value.installationId,
          value.provisionerExpiresAt,
        )
      : relaySigningKey;
  const prefix =
    value.version === RELAY_CAPABILITY_VERSION || value.version === 3
      ? "ce-relay-provisioned-v1"
      : "ce-relay-v1";
  verifySignature(parts[0], parts[1], signingKey, prefix);
  if (value.expiresAt && Date.parse(value.expiresAt) <= now.getTime()) {
    throw new Error("Route capability has expired");
  }
  if (
    (value.version === RELAY_CAPABILITY_VERSION || value.version === 3) &&
    Date.parse(value.provisionerExpiresAt) <= now.getTime()
  ) {
    throw new Error("Host provisioner credential has expired");
  }
  return value;
}

export function routeIdFromCapability(capability: string): string {
  const body = capability.split(".")[0];
  if (!body) throw new Error("Invalid Relay capability");
  const value: unknown = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  );
  if (!isCapabilityPayload(value)) {
    throw new Error("Invalid Relay capability payload");
  }
  return value.routeId;
}

export function relayKeyFingerprint(signingKey: Uint8Array): string {
  assertSigningKey(signingKey);
  return `sha256:${createHash("sha256").update(signingKey).digest("base64url")}`;
}

function deriveProvisionerSigningKey(
  relaySigningKey: Uint8Array,
  installationId: string,
  expiresAt: string,
): Buffer {
  assertSigningKey(relaySigningKey);
  return createHmac("sha256", relaySigningKey)
    .update(
      `ce-relay-provisioner-v1\0${normalizeInstallationId(installationId)}\0${expiresAt}`,
    )
    .digest();
}

function signCapability<T extends RouteCapabilityPayload>(
  payload: T,
  signingKey: Uint8Array,
  prefix: string,
): { capability: string; payload: T } {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update(`${prefix}.${body}`)
    .digest("base64url");
  return { capability: `${body}.${signature}`, payload };
}

function verifySignature(
  body: string,
  signature: string,
  signingKey: Uint8Array,
  prefix: string,
): void {
  const expected = createHmac("sha256", signingKey)
    .update(`${prefix}.${body}`)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (
    actual.byteLength !== expected.byteLength ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new Error("Invalid route capability signature");
  }
}

function isCapabilityPayload(value: unknown): value is RouteCapabilityPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    (record.purpose !== "agent-route" &&
      record.purpose !== "host-admin-route") ||
    typeof record.routeId !== "string" ||
    !/^[A-Za-z0-9_-]{32}$/u.test(record.routeId) ||
    typeof record.issuedAt !== "string" ||
    !validDate(record.issuedAt) ||
    (record.expiresAt !== undefined &&
      (typeof record.expiresAt !== "string" || !validDate(record.expiresAt)))
  ) {
    return false;
  }
  if (record.version === 1 || record.version === 2) {
    return (
      record.purpose === "agent-route" &&
      (record.loginId === undefined ||
        (typeof record.loginId === "string" &&
          /^[A-Za-z0-9_-]{32}$/u.test(record.loginId)))
    );
  }
  if (record.version === 3) {
    return (
      record.purpose === "agent-route" &&
      typeof record.installationId === "string" &&
      isNormalizedInstallationId(record.installationId) &&
      typeof record.loginName === "string" &&
      isNormalizedLoginName(record.loginName) &&
      typeof record.provisionerExpiresAt === "string" &&
      validDate(record.provisionerExpiresAt)
    );
  }
  return (
    record.version === RELAY_CAPABILITY_VERSION &&
    (record.principal === "user" || record.principal === "host-admin") &&
    ((record.principal === "user" && record.purpose === "agent-route") ||
      (record.principal === "host-admin" &&
        record.purpose === "host-admin-route")) &&
    typeof record.installationId === "string" &&
    isNormalizedInstallationId(record.installationId) &&
    typeof record.loginName === "string" &&
    isNormalizedLoginName(record.loginName) &&
    typeof record.provisionerExpiresAt === "string" &&
    validDate(record.provisionerExpiresAt)
  );
}

function isNormalizedInstallationId(value: string): boolean {
  try {
    return normalizeInstallationId(value) === value;
  } catch {
    return false;
  }
}

function isNormalizedLoginName(value: string): boolean {
  try {
    return normalizeLoginName(value) === value;
  } catch {
    return false;
  }
}

function assertSigningKey(value: Uint8Array): void {
  if (value.byteLength !== 32) {
    throw new Error("Relay signing key must be 32 bytes");
  }
}

function assertRouteId(value: string): void {
  if (!/^[A-Za-z0-9_-]{32}$/u.test(value)) {
    throw new Error("Invalid Relay route ID");
  }
}

function randomRouteId(): string {
  return randomBytes(24).toString("base64url");
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
