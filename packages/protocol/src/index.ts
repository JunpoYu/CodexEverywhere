export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

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

export type GatewayCipherFrame = {
  type: "cipher";
  version: ProtocolVersion;
  sessionId: string;
  sequence: number;
  ciphertext: string;
};

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
