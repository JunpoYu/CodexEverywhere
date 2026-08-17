export type BinaryValue = Uint8Array;

export interface WorkspaceStateRecord {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly createdAt: string;
  readonly revision: number;
}

export interface PreferencesStateRecord {
  readonly theme: "system" | "light" | "dark";
  readonly locale: string;
  readonly defaultSandbox: string;
  readonly defaultApprovalPolicy: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ThreadPermissionStateRecord {
  readonly threadId: string;
  readonly approvalPolicyJson: string;
  readonly approvalsReviewer: string;
  readonly sandboxMode: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface ThreadPermissionObservationStateRecord {
  readonly threadId: string;
  readonly generation: number;
}

export interface TrustedDeviceStateRecord {
  readonly id: string;
  readonly name: string;
  readonly publicKey: BinaryValue;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface PairingStateRecord {
  readonly id: string;
  readonly secretHash: BinaryValue;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface PasskeyStateRecord {
  readonly credentialId: BinaryValue;
  readonly publicKey: BinaryValue;
  readonly signCount: number;
  readonly createdAt: string;
}

export interface RecoveryCodeStateRecord {
  readonly hash: BinaryValue;
  readonly createdAt: string;
  readonly usedAt?: string;
}

export interface RecoveryHandoffStateRecord {
  readonly hash: BinaryValue;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly usedAt?: string;
}

export interface PasswordStateRecord {
  readonly registrationRecord: string;
  readonly updatedAt: string;
}

export type MutationReceiptStatus = "pending" | "completed" | "indeterminate";

export interface MutationReceiptStateRecord {
  readonly operationKey: string;
  readonly method: string;
  readonly requestFingerprint?: string;
  readonly status: MutationReceiptStatus;
  readonly resultJson?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export type QueueState =
  "pending" | "paused" | "delivering" | "completed" | "indeterminate";

export interface QueueItemStateRecord {
  readonly id: string;
  readonly workspacePath: string;
  readonly threadId: string;
  readonly requestJson: string;
  readonly status: QueueState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QueueDeliveryClaimStateRecord {
  readonly queueItemId: string;
  readonly operation: string;
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly outcome?: "completed" | "indeterminate" | "abandoned";
  readonly turnId?: string;
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface SecurityAuditStateRecord {
  readonly id: string;
  readonly kind: string;
  readonly subjectId?: string;
  readonly createdAt: string;
}

export interface UserStateRecords {
  readonly createdAt: string;
  readonly sourceSchema: number;
  readonly workspaceAuthorizationRevision: number;
  readonly workspaces: readonly WorkspaceStateRecord[];
  readonly defaultWorkspaceId?: string;
  readonly preferences?: PreferencesStateRecord;
  readonly threadPermissionGeneration: number;
  readonly threadPermissions: readonly ThreadPermissionStateRecord[];
  readonly threadPermissionObservations: readonly ThreadPermissionObservationStateRecord[];
  readonly trustedDevices: readonly TrustedDeviceStateRecord[];
  readonly pairingSessions: readonly PairingStateRecord[];
  readonly passkeys: readonly PasskeyStateRecord[];
  readonly recoveryCodes: readonly RecoveryCodeStateRecord[];
  readonly recoveryHandoffs: readonly RecoveryHandoffStateRecord[];
  readonly password?: PasswordStateRecord;
  readonly mutationReceipts: readonly MutationReceiptStateRecord[];
  readonly queueItems: readonly QueueItemStateRecord[];
  readonly queueDeliveryClaims: readonly QueueDeliveryClaimStateRecord[];
  readonly auditEvents: readonly SecurityAuditStateRecord[];
}

export interface AdminIdentityStateRecords {
  readonly trustedDevices: readonly TrustedDeviceStateRecord[];
  readonly pairingSessions: readonly PairingStateRecord[];
  readonly passkeys: readonly PasskeyStateRecord[];
  readonly recoveryCodes: readonly RecoveryCodeStateRecord[];
  readonly password?: PasswordStateRecord;
}

export interface ManagedUserStateRecord {
  readonly uid: number;
  readonly username: string;
  readonly home: string;
  readonly status: string;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly removeAfter?: string;
}

export interface AdminAuditStateRecord {
  readonly id: string;
  readonly requestId: string;
  readonly actor: string;
  readonly action: string;
  readonly targetUsername?: string;
  readonly result: string;
  readonly createdAt: string;
}

export interface AdminStateRecords {
  readonly createdAt: string;
  readonly sourceSchema: number;
  readonly identity: AdminIdentityStateRecords;
  readonly managedUsers: readonly ManagedUserStateRecord[];
  readonly auditEvents: readonly AdminAuditStateRecord[];
  readonly mutationReceipts: readonly MutationReceiptStateRecord[];
}

export type StateSnapshotV1 =
  | {
      readonly version: 1;
      readonly kind: "user";
      readonly records: UserStateRecords;
    }
  | {
      readonly version: 1;
      readonly kind: "admin";
      readonly records: AdminStateRecords;
    };

export function stateSnapshotCounts(
  snapshot: StateSnapshotV1,
): Record<string, number> {
  if (snapshot.kind === "admin") {
    return {
      identities:
        snapshot.records.identity.trustedDevices.length +
        snapshot.records.identity.passkeys.length +
        snapshot.records.identity.recoveryCodes.length +
        (snapshot.records.identity.password === undefined ? 0 : 1),
      managedUsers: snapshot.records.managedUsers.length,
      auditEvents: snapshot.records.auditEvents.length,
      mutationReceipts: snapshot.records.mutationReceipts.length,
    };
  }
  return {
    workspaces: snapshot.records.workspaces.length,
    threadPermissions: snapshot.records.threadPermissions.length,
    trustedDevices: snapshot.records.trustedDevices.length,
    passkeys: snapshot.records.passkeys.length,
    recoveryCodes: snapshot.records.recoveryCodes.length,
    mutationReceipts: snapshot.records.mutationReceipts.length,
    queueItems: snapshot.records.queueItems.filter(
      (item) => item.status !== "completed",
    ).length,
    queueDeliveryClaims: snapshot.records.queueDeliveryClaims.filter(
      (claim) =>
        claim.outcome === undefined || claim.outcome === "indeterminate",
    ).length,
    auditEvents: snapshot.records.auditEvents.length,
  };
}
