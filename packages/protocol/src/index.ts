export const PROTOCOL_VERSION = 1 as const;

const MAX_GATEWAY_HANDSHAKE_BASE64URL_LENGTH = 128 * 1024;
const MAX_GATEWAY_CIPHERTEXT_BASE64URL_LENGTH = 128 * 1024;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const IDEMPOTENCY_OUTCOME_INDETERMINATE =
  "IDEMPOTENCY_OUTCOME_INDETERMINATE" as const;

export type RequestEnvelope<T = unknown> = {
  version: ProtocolVersion;
  requestId: string;
  idempotencyKey: string;
  method: string;
  payload: T;
};

export type ProtocolError = {
  code: string;
  message: string;
  retryable?: boolean;
};

export type ResponseEnvelope<T = unknown> = {
  version: ProtocolVersion;
  requestId: string;
  ok: boolean;
  result?: T;
  error?: ProtocolError;
};

export type EventEnvelope<T = unknown> = {
  version: ProtocolVersion;
  eventId: string;
  cursor: string;
  type: string;
  payload: T;
};

export const CODEX_INSTALL_PROGRESS_EVENT =
  "setup/codex/install/progress" as const;

export type CodexInstallProgressPhase =
  "preparing" | "installing" | "verifying" | "completed" | "failed";

export type CodexInstallProgressPayload = {
  version: 1;
  operationId: string;
  phase: CodexInstallProgressPhase;
};

export type CodexVersionRelation = "older" | "current" | "newer" | "unknown";

export type CodexVersionStatus = {
  version: 1;
  installed: boolean;
  installedVersion?: string;
  binary?: string;
  latestVersion?: string;
  relation: CodexVersionRelation;
};

export type SessionSandboxDefault =
  "read-only" | "workspace-write" | "danger-full-access";

export type SessionApprovalDefault = "untrusted" | "on-request" | "never";

export type SessionPermissionDefaults = {
  version: 1;
  sandbox: SessionSandboxDefault;
  approvalPolicy: SessionApprovalDefault;
  updatedAt?: string;
};

export type CodexAuthImportRequest = {
  version: 1;
  content: string;
};

export type CodexAuthImportResult = {
  version: 1;
  imported: true;
  replacedExisting: boolean;
  restartRequired: boolean;
};

export type TransportKind = "direct" | "relay";

export type HostProfile = {
  id: string;
  name: string;
  transport: TransportKind;
  endpoint: string;
  directEndpoint?: string;
  relayEndpoint?: string;
  routeId?: string;
};

export type AdminUserAccessStatus =
  "enabled" | "disabled" | "removal_pending" | "removing" | "removed";

export type AdminUserSummary = {
  version: 1;
  uid: number;
  username: string;
  home: string;
  status: AdminUserAccessStatus;
  agentOnline: boolean;
  registeredAt: string;
  updatedAt: string;
  revision: number;
  removeAfter?: string;
};

export type AdminHostStatus = {
  version: 1;
  installationId: string;
  serverName: string;
  controllerStartedAt: string;
  managedUsers: number;
  enabledUsers: number;
  disabledUsers: number;
  pendingRemovals: number;
};

export type AdminAuditEvent = {
  version: 1;
  id: string;
  requestId: string;
  actor: string;
  action: string;
  targetUsername?: string;
  result: "succeeded" | "failed";
  createdAt: string;
};

export type AdminMutationRequest = {
  version: 1;
  username: string;
  expectedRevision: number;
};

export type AdminRecoveryStartResult = {
  version: 1;
  username: string;
  handoffCode: string;
  expiresAt: string;
};

export type WorkspaceRoot = {
  id: string;
  path: string;
  label: string;
};

export type ConnectionState =
  | { type: "offline"; reason?: string }
  | { type: "connecting" }
  | { type: "online"; connectedAt: number };

export type GatewayHandshakeHello = {
  type: "handshake/hello";
  version: ProtocolVersion;
  nodeId: string;
  deviceId: string;
  message: string;
};

export type GatewayHandshakeReply = {
  type: "handshake/reply";
  version: ProtocolVersion;
  message: string;
};

export type GatewayHandshakeAccepted = {
  version: ProtocolVersion;
  ok: true;
  principal: "user" | "host-admin";
  loginName?: string;
};

export type GatewayHandshakeRejected = {
  version: ProtocolVersion;
  ok: false;
  error: {
    code: "REAUTH_REQUIRED";
  };
};

export type GatewayHandshakeResult =
  GatewayHandshakeAccepted | GatewayHandshakeRejected;

export type GatewayCipherFrame = {
  type: "cipher";
  version: ProtocolVersion;
  sessionId: string;
  sequence: number;
  ciphertext: string;
};

export const RELAY_PROTOCOL_VERSION = PROTOCOL_VERSION;

export const RELAY_MESSAGE_TYPES = {
  register: "relay/register",
  registered: "relay/registered",
  connect: "relay/connect",
  incoming: "relay/incoming",
  accept: "relay/accept",
  accepted: "relay/accepted",
  tunnelReady: "relay/tunnel-ready",
  ready: "relay/ready",
  lookup: "relay/lookup",
  profile: "relay/profile",
} as const;

export type RelayMessageType =
  (typeof RELAY_MESSAGE_TYPES)[keyof typeof RELAY_MESSAGE_TYPES];

export type RelayWireMessage<T extends RelayMessageType = RelayMessageType> =
  Record<string, unknown> & {
    type: T;
    version: typeof RELAY_PROTOCOL_VERSION;
  };

/**
 * Parses the unencrypted Relay control envelope. Field-specific parsers still
 * validate each message body, while this shared boundary rejects unknown
 * message kinds and unsupported wire versions consistently in all clients.
 */
export function parseRelayWireMessage<T extends RelayMessageType>(
  input: unknown,
  expectedType: T,
): RelayWireMessage<T>;
export function parseRelayWireMessage(input: unknown): RelayWireMessage;
export function parseRelayWireMessage(
  input: unknown,
  expectedType?: RelayMessageType,
): RelayWireMessage {
  const value = parseWireRecord(input, "Relay message");
  if (value.version !== RELAY_PROTOCOL_VERSION) {
    throw new Error("Unsupported Relay protocol version");
  }
  if (!isRelayMessageType(value.type)) {
    throw new Error("Unknown Relay message type");
  }
  if (expectedType !== undefined && value.type !== expectedType) {
    throw new Error(`Expected ${expectedType} Relay message`);
  }
  return value as RelayWireMessage;
}

export function parseGatewayHandshakeReply(
  input: unknown,
): GatewayHandshakeReply {
  const value = parseWireRecord(input, "gateway handshake reply");
  if (
    value.type !== "handshake/reply" ||
    value.version !== PROTOCOL_VERSION ||
    !isBoundedBase64Url(value.message, MAX_GATEWAY_HANDSHAKE_BASE64URL_LENGTH)
  ) {
    throw new Error("Invalid gateway handshake reply");
  }
  return value as GatewayHandshakeReply;
}

export function parseGatewayHandshakeAccepted(
  input: unknown,
): GatewayHandshakeAccepted {
  const value = parseWireRecord(input, "gateway handshake result");
  if (
    value.version !== PROTOCOL_VERSION ||
    value.ok !== true ||
    (value.principal !== "user" && value.principal !== "host-admin") ||
    (value.loginName !== undefined &&
      !isBoundedIdentifier(value.loginName, 128))
  ) {
    throw new Error("Invalid gateway handshake result");
  }
  return value as GatewayHandshakeAccepted;
}

/**
 * Parses the Noise-authenticated handshake result. A structured rejection is
 * carried inside the encrypted IK response so a reverse proxy stripping the
 * WebSocket close reason cannot turn an invalid resume token into an endless
 * reconnect loop.
 */
export function parseGatewayHandshakeResult(
  input: unknown,
): GatewayHandshakeResult {
  const value = parseWireRecord(input, "gateway handshake result");
  if (value.ok === true) return parseGatewayHandshakeAccepted(value);
  const error = value.error;
  if (
    value.version !== PROTOCOL_VERSION ||
    value.ok !== false ||
    !isRecord(error) ||
    error.code !== "REAUTH_REQUIRED"
  ) {
    throw new Error("Invalid gateway handshake result");
  }
  return value as GatewayHandshakeRejected;
}

export function parseGatewayCipherFrame(input: unknown): GatewayCipherFrame {
  const value = parseWireRecord(input, "gateway cipher frame");
  if (
    value.type !== "cipher" ||
    value.version !== PROTOCOL_VERSION ||
    !isBoundedBase64Url(value.sessionId, 128) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    !isBoundedBase64Url(
      value.ciphertext,
      MAX_GATEWAY_CIPHERTEXT_BASE64URL_LENGTH,
    )
  ) {
    throw new Error("Invalid gateway cipher frame");
  }
  return value as GatewayCipherFrame;
}

export function parseResponseEnvelope(input: unknown): ResponseEnvelope {
  const value = parseWireRecord(input, "gateway response envelope");
  if (
    value.version !== PROTOCOL_VERSION ||
    !isBoundedIdentifier(value.requestId) ||
    typeof value.ok !== "boolean"
  ) {
    throw new Error("Invalid gateway response envelope");
  }
  if (value.ok) {
    if (value.error !== undefined) {
      throw new Error("Successful gateway response contains an error");
    }
  } else {
    if (value.result !== undefined || !isProtocolError(value.error)) {
      throw new Error("Invalid gateway error response");
    }
  }
  return value as ResponseEnvelope;
}

export function parseEventEnvelope(input: unknown): EventEnvelope {
  const value = parseWireRecord(input, "gateway event envelope");
  if (
    value.version !== PROTOCOL_VERSION ||
    !isBoundedIdentifier(value.eventId) ||
    !isBoundedIdentifier(value.cursor) ||
    !isBoundedIdentifier(value.type) ||
    !Object.hasOwn(value, "payload")
  ) {
    throw new Error("Invalid gateway event envelope");
  }
  return value as EventEnvelope;
}

export function parseGatewayServerEnvelope(
  input: unknown,
): ResponseEnvelope | EventEnvelope {
  const value = parseWireRecord(input, "gateway server envelope");
  const responseLike =
    Object.hasOwn(value, "requestId") || Object.hasOwn(value, "ok");
  const eventLike =
    Object.hasOwn(value, "eventId") || Object.hasOwn(value, "cursor");
  if (responseLike === eventLike) {
    throw new Error("Ambiguous gateway server envelope");
  }
  return responseLike
    ? parseResponseEnvelope(value)
    : parseEventEnvelope(value);
}

export type PairingHandshakePayload = {
  mode: "pair";
  pairingId: string;
  secret: string;
  deviceName: string;
};

export type TrustedHandshakePayload = { mode: "connect" };

export type LoginHandshakePayload = {
  mode: "login";
  deviceName: string;
  rememberDevice: boolean;
};

export type ResumeHandshakePayload = {
  mode: "resume";
  resumeToken: string;
};

export type GatewayAuthenticationPayload =
  | PairingHandshakePayload
  | TrustedHandshakePayload
  | LoginHandshakePayload
  | ResumeHandshakePayload;

export function parseGatewayAuthenticationPayload(
  input: unknown,
): GatewayAuthenticationPayload {
  const value = parseWireRecord(input, "gateway authentication payload");
  if (value.mode === "connect") return { mode: "connect" };
  if (
    value.mode === "resume" &&
    typeof value.resumeToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.resumeToken)
  ) {
    return { mode: "resume", resumeToken: value.resumeToken };
  }
  if (
    value.mode === "login" &&
    isBoundedIdentifier(value.deviceName, 128) &&
    typeof value.rememberDevice === "boolean"
  ) {
    return value as LoginHandshakePayload;
  }
  if (
    value.mode === "pair" &&
    isBoundedIdentifier(value.pairingId, 128) &&
    isBoundedBase64Url(value.secret, 128) &&
    isBoundedIdentifier(value.deviceName, 128)
  ) {
    return value as PairingHandshakePayload;
  }
  throw new Error("Invalid gateway authentication payload");
}

export function requestEnvelope<T>(
  method: string,
  payload: T,
  options: { requestId: string; idempotencyKey: string },
): RequestEnvelope<T> {
  return {
    version: PROTOCOL_VERSION,
    requestId: options.requestId,
    idempotencyKey: options.idempotencyKey,
    method,
    payload,
  };
}

function parseWireRecord(
  input: unknown,
  description: string,
): Record<string, unknown> {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw new Error(`Invalid ${description} JSON`);
    }
  }
  if (!isRecord(value)) throw new Error(`Invalid ${description}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRelayMessageType(value: unknown): value is RelayMessageType {
  return Object.values(RELAY_MESSAGE_TYPES).some((type) => type === value);
}

function isBoundedIdentifier(
  value: unknown,
  maximumLength = 256,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function isBase64Url(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length % 4 !== 1 &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function isBoundedBase64Url(
  value: unknown,
  maximumLength: number,
): value is string {
  return isBase64Url(value) && value.length <= maximumLength;
}

function isProtocolError(value: unknown): value is ProtocolError {
  if (!isRecord(value)) return false;
  return (
    isBoundedIdentifier(value.code, 128) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    (value.retryable === undefined || typeof value.retryable === "boolean")
  );
}
