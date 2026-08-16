import type { Database } from "sql.js";

import { IdentityRepository } from "./identity-repository.js";
import { MutationReceiptRepository } from "./mutation-receipt-repository.js";
import { PreferencesRepository } from "./preferences-repository.js";
import { QueueRepository } from "./queue-repository.js";
import { WorkspaceRepository } from "./workspace-repository.js";
import {
  blob,
  clearIdentity,
  insertIdentity,
  insertMutationReceipts,
  integer,
  nullableText,
  queryRows,
  readIdentity,
  readMutationReceipts,
  text,
} from "./snapshot-sql.js";
import { SqliteStateFile } from "./sqlite-state-file.js";
import { USER_STATE_SPEC } from "./state-schema.js";
import { ThreadSettingsRepository } from "./thread-settings-repository.js";
import type {
  QueueDeliveryClaimStateRecord,
  QueueItemStateRecord,
  RecoveryHandoffStateRecord,
  SecurityAuditStateRecord,
  StateSnapshotV1,
  ThreadPermissionObservationStateRecord,
  ThreadPermissionStateRecord,
  UserStateRecords,
  WorkspaceStateRecord,
} from "./state-snapshot.js";

export class UserStateDatabase {
  readonly #file: SqliteStateFile;
  readonly mutationReceipts: MutationReceiptRepository;
  readonly identity: IdentityRepository;
  readonly preferences: PreferencesRepository;
  readonly queue: QueueRepository;
  readonly threadSettings: ThreadSettingsRepository;
  readonly workspaces: WorkspaceRepository;

  private constructor(file: SqliteStateFile) {
    this.#file = file;
    this.mutationReceipts = new MutationReceiptRepository(file);
    this.identity = new IdentityRepository(file);
    this.preferences = new PreferencesRepository(file);
    this.queue = new QueueRepository(file);
    this.threadSettings = new ThreadSettingsRepository(file);
    this.workspaces = new WorkspaceRepository(file);
  }

  static async open(
    path: string,
    options: { readonly create?: boolean } = {},
  ): Promise<UserStateDatabase> {
    const file = await SqliteStateFile.open(path, USER_STATE_SPEC, options);
    const state = new UserStateDatabase(file);
    const hasMetadata = await file.read(
      (database) =>
        queryRows(database, "SELECT 1 FROM metadata WHERE id = 1").length === 1,
    );
    if (!hasMetadata) {
      if (options.create !== true) {
        await file.close();
        throw new Error("User state metadata is missing");
      }
      await state.replaceSnapshot(emptyUserSnapshot());
    }
    await state.verify();
    return state;
  }

  static async createFromSnapshot(
    path: string,
    snapshot: Extract<StateSnapshotV1, { kind: "user" }>,
  ): Promise<UserStateDatabase> {
    const file = await SqliteStateFile.open(path, USER_STATE_SPEC, {
      create: true,
    });
    const state = new UserStateDatabase(file);
    await state.replaceSnapshot(snapshot);
    await state.verify();
    return state;
  }

  exportSnapshot(): Promise<Extract<StateSnapshotV1, { kind: "user" }>> {
    return this.#file.read((database) => ({
      version: 1,
      kind: "user",
      records: readUserRecords(database),
    }));
  }

  replaceSnapshot(
    snapshot: Extract<StateSnapshotV1, { kind: "user" }>,
  ): Promise<void> {
    return this.#file.transaction((database) => {
      clearUserState(database);
      insertUserRecords(database, snapshot.records);
      validateUserInvariants(database);
    });
  }

  async verify(): Promise<void> {
    await this.#file.verify();
    await this.#file.read(validateUserInvariants);
  }

  acquireCoordinationLock(
    name: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{ release(): Promise<void> }> {
    return this.#file.acquireCoordinationLock(name, options);
  }

  close(): Promise<void> {
    return this.#file.close();
  }
}

function emptyUserSnapshot(): Extract<StateSnapshotV1, { kind: "user" }> {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "user",
    records: {
      createdAt: now,
      sourceSchema: 0,
      workspaceAuthorizationRevision: 0,
      workspaces: [],
      preferences: {
        theme: "system",
        locale: "zh-CN",
        defaultSandbox: "workspace-write",
        defaultApprovalPolicy: "on-request",
        revision: 0,
        updatedAt: now,
      },
      threadPermissionGeneration: 0,
      threadPermissions: [],
      threadPermissionObservations: [],
      trustedDevices: [],
      pairingSessions: [],
      passkeys: [],
      recoveryCodes: [],
      recoveryHandoffs: [],
      mutationReceipts: [],
      queueItems: [],
      queueDeliveryClaims: [],
      auditEvents: [],
    },
  };
}

function readUserRecords(database: Database): UserStateRecords {
  const metadata = queryRows(
    database,
    "SELECT created_at, source_schema, workspace_authorization_revision, thread_permission_generation, default_workspace_id FROM metadata WHERE id = 1 AND kind = 'user'",
  )[0];
  if (!metadata) throw new Error("User state metadata is missing");
  const identity = readIdentity(database);
  const preferencesRow = queryRows(
    database,
    "SELECT theme, locale, default_sandbox, default_approval_policy, revision, updated_at FROM preferences WHERE id = 1",
  )[0];
  const recoveryHandoffs: RecoveryHandoffStateRecord[] = queryRows(
    database,
    "SELECT hash, expires_at, created_at, used_at FROM recovery_handoffs ORDER BY created_at, hex(hash)",
  ).map((row) => ({
    hash: blob(row.hash, "recovery handoff hash"),
    expiresAt: text(row.expires_at, "recovery handoff expires_at"),
    createdAt: text(row.created_at, "recovery handoff created_at"),
    ...(nullableText(row.used_at, "recovery handoff used_at") === undefined
      ? {}
      : { usedAt: nullableText(row.used_at, "recovery handoff used_at")! }),
  }));
  return {
    createdAt: text(metadata.created_at, "user metadata created_at"),
    sourceSchema: integer(metadata.source_schema, "user source schema"),
    workspaceAuthorizationRevision: integer(
      metadata.workspace_authorization_revision,
      "workspace authorization revision",
    ),
    workspaces: readWorkspaces(database),
    ...(nullableText(metadata.default_workspace_id, "default workspace id") ===
    undefined
      ? {}
      : {
          defaultWorkspaceId: nullableText(
            metadata.default_workspace_id,
            "default workspace id",
          )!,
        }),
    ...(preferencesRow === undefined
      ? {}
      : {
          preferences: {
            theme: preferenceTheme(preferencesRow.theme),
            locale: text(preferencesRow.locale, "preference locale"),
            defaultSandbox: text(
              preferencesRow.default_sandbox,
              "preference sandbox",
            ),
            defaultApprovalPolicy: text(
              preferencesRow.default_approval_policy,
              "preference approval policy",
            ),
            revision: integer(preferencesRow.revision, "preference revision"),
            updatedAt: text(preferencesRow.updated_at, "preference updated_at"),
          },
        }),
    threadPermissionGeneration: integer(
      metadata.thread_permission_generation,
      "thread permission generation",
    ),
    threadPermissions: readThreadPermissions(database),
    threadPermissionObservations: readThreadPermissionObservations(database),
    ...identity,
    recoveryHandoffs,
    mutationReceipts: readMutationReceipts(database),
    queueItems: readQueueItems(database),
    queueDeliveryClaims: readQueueClaims(database),
    auditEvents: readAuditEvents(database),
  };
}

function readWorkspaces(database: Database): WorkspaceStateRecord[] {
  return queryRows(
    database,
    "SELECT id, path, label, created_at, revision FROM workspaces ORDER BY path",
  ).map((row) => ({
    id: text(row.id, "workspace id"),
    path: text(row.path, "workspace path"),
    label: text(row.label, "workspace label"),
    createdAt: text(row.created_at, "workspace created_at"),
    revision: integer(row.revision, "workspace revision"),
  }));
}

function readThreadPermissions(
  database: Database,
): ThreadPermissionStateRecord[] {
  return queryRows(
    database,
    "SELECT thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, revision, updated_at FROM thread_permissions ORDER BY thread_id",
  ).map((row) => ({
    threadId: text(row.thread_id, "thread permission id"),
    approvalPolicyJson: text(row.approval_policy_json, "approval policy"),
    approvalsReviewer: text(row.approvals_reviewer, "approvals reviewer"),
    sandboxMode: text(row.sandbox_mode, "sandbox mode"),
    revision: integer(row.revision, "thread permission revision"),
    updatedAt: text(row.updated_at, "thread permission updated_at"),
  }));
}

function readThreadPermissionObservations(
  database: Database,
): ThreadPermissionObservationStateRecord[] {
  return queryRows(
    database,
    "SELECT thread_id, generation FROM thread_permission_observations ORDER BY thread_id",
  ).map((row) => ({
    threadId: text(row.thread_id, "thread observation id"),
    generation: integer(row.generation, "thread observation generation"),
  }));
}

function readQueueItems(database: Database): QueueItemStateRecord[] {
  return queryRows(
    database,
    "SELECT id, workspace_path, thread_id, request_json, status, revision, created_at, updated_at FROM queue_items ORDER BY created_at, id",
  ).map((row) => ({
    id: text(row.id, "queue item id"),
    workspacePath: text(row.workspace_path, "queue workspace path"),
    threadId: text(row.thread_id, "queue thread id"),
    requestJson: text(row.request_json, "queue request"),
    status: queueStatus(row.status),
    revision: integer(row.revision, "queue revision"),
    createdAt: text(row.created_at, "queue created_at"),
    updatedAt: text(row.updated_at, "queue updated_at"),
  }));
}

function readQueueClaims(database: Database): QueueDeliveryClaimStateRecord[] {
  return queryRows(
    database,
    "SELECT queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at FROM queue_delivery_claims ORDER BY created_at, queue_item_id",
  ).map((row) => ({
    queueItemId: text(row.queue_item_id, "queue claim item id"),
    operation: text(row.operation, "queue claim operation"),
    threadId: text(row.thread_id, "queue claim thread id"),
    clientUserMessageId: text(
      row.client_user_message_id,
      "queue claim client message id",
    ),
    ...(nullableText(row.outcome, "queue claim outcome") === undefined
      ? {}
      : { outcome: queueOutcome(row.outcome) }),
    ...(nullableText(row.turn_id, "queue claim turn id") === undefined
      ? {}
      : { turnId: nullableText(row.turn_id, "queue claim turn id")! }),
    createdAt: text(row.created_at, "queue claim created_at"),
    ...(nullableText(row.completed_at, "queue claim completed_at") === undefined
      ? {}
      : {
          completedAt: nullableText(
            row.completed_at,
            "queue claim completed_at",
          )!,
        }),
  }));
}

function readAuditEvents(database: Database): SecurityAuditStateRecord[] {
  return queryRows(
    database,
    "SELECT id, kind, subject_id, created_at FROM audit_events ORDER BY created_at, id",
  ).map((row) => ({
    id: text(row.id, "audit id"),
    kind: text(row.kind, "audit kind"),
    ...(nullableText(row.subject_id, "audit subject") === undefined
      ? {}
      : { subjectId: nullableText(row.subject_id, "audit subject")! }),
    createdAt: text(row.created_at, "audit created_at"),
  }));
}

function insertUserRecords(
  database: Database,
  records: UserStateRecords,
): void {
  database.run(
    "INSERT INTO metadata (id, kind, created_at, source_schema, workspace_authorization_revision, thread_permission_generation, default_workspace_id) VALUES (1, 'user', ?, ?, ?, ?, ?)",
    [
      records.createdAt,
      records.sourceSchema,
      records.workspaceAuthorizationRevision,
      records.threadPermissionGeneration,
      records.defaultWorkspaceId ?? null,
    ],
  );
  for (const record of records.workspaces) {
    database.run(
      "INSERT INTO workspaces (id, path, label, created_at, revision) VALUES (?, ?, ?, ?, ?)",
      [record.id, record.path, record.label, record.createdAt, record.revision],
    );
  }
  if (records.preferences !== undefined) {
    const record = records.preferences;
    database.run(
      "INSERT INTO preferences (id, theme, locale, default_sandbox, default_approval_policy, revision, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)",
      [
        record.theme,
        record.locale,
        record.defaultSandbox,
        record.defaultApprovalPolicy,
        record.revision,
        record.updatedAt,
      ],
    );
  }
  for (const record of records.threadPermissions) {
    database.run(
      "INSERT INTO thread_permissions (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        record.threadId,
        record.approvalPolicyJson,
        record.approvalsReviewer,
        record.sandboxMode,
        record.revision,
        record.updatedAt,
      ],
    );
  }
  for (const record of records.threadPermissionObservations) {
    database.run(
      "INSERT INTO thread_permission_observations (thread_id, generation) VALUES (?, ?)",
      [record.threadId, record.generation],
    );
  }
  insertIdentity(database, records);
  for (const record of records.recoveryHandoffs) {
    database.run(
      "INSERT INTO recovery_handoffs (hash, expires_at, created_at, used_at) VALUES (?, ?, ?, ?)",
      [record.hash, record.expiresAt, record.createdAt, record.usedAt ?? null],
    );
  }
  insertMutationReceipts(database, records.mutationReceipts);
  for (const record of records.queueItems) {
    database.run(
      "INSERT INTO queue_items (id, workspace_path, thread_id, request_json, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.workspacePath,
        record.threadId,
        record.requestJson,
        record.status,
        record.revision,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }
  for (const record of records.queueDeliveryClaims) {
    database.run(
      "INSERT INTO queue_delivery_claims (queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.queueItemId,
        record.operation,
        record.threadId,
        record.clientUserMessageId,
        record.outcome ?? null,
        record.turnId ?? null,
        record.createdAt,
        record.completedAt ?? null,
      ],
    );
  }
  for (const record of records.auditEvents) {
    database.run(
      "INSERT INTO audit_events (id, kind, subject_id, created_at) VALUES (?, ?, ?, ?)",
      [record.id, record.kind, record.subjectId ?? null, record.createdAt],
    );
  }
}

function clearUserState(database: Database): void {
  for (const table of [
    "queue_delivery_claims",
    "queue_items",
    "mutation_receipts",
    "recovery_handoffs",
    "audit_events",
    "thread_permission_observations",
    "thread_permissions",
    "preferences",
    "workspaces",
  ]) {
    database.run(`DELETE FROM ${table}`);
  }
  clearIdentity(database);
  database.run("DELETE FROM metadata");
}

function validateUserInvariants(database: Database): void {
  const metadata = queryRows(
    database,
    "SELECT default_workspace_id, thread_permission_generation FROM metadata WHERE id = 1 AND kind = 'user'",
  )[0];
  if (!metadata) throw new Error("User state metadata invariant failed");
  const defaultWorkspaceId = nullableText(
    metadata.default_workspace_id,
    "default workspace id",
  );
  if (
    defaultWorkspaceId !== undefined &&
    queryRows(database, "SELECT 1 FROM workspaces WHERE id = ?", [
      defaultWorkspaceId,
    ]).length !== 1
  ) {
    throw new Error("Default workspace does not exist");
  }
  const generation = integer(
    metadata.thread_permission_generation,
    "thread permission generation",
  );
  const newerObservation = queryRows(
    database,
    "SELECT 1 FROM thread_permission_observations WHERE generation > ? LIMIT 1",
    [generation],
  );
  if (newerObservation.length > 0) {
    throw new Error("Thread permission observation exceeds global generation");
  }
  const invalidClaim = queryRows(
    database,
    "SELECT 1 FROM queue_delivery_claims c JOIN queue_items q ON q.id = c.queue_item_id WHERE q.thread_id <> c.thread_id LIMIT 1",
  );
  if (invalidClaim.length > 0)
    throw new Error("Queue claim thread invariant failed");
}

function preferenceTheme(value: unknown): "system" | "light" | "dark" {
  if (value === "system" || value === "light" || value === "dark") return value;
  throw new Error("Invalid preference theme");
}

function queueStatus(value: unknown): QueueItemStateRecord["status"] {
  if (
    value === "pending" ||
    value === "paused" ||
    value === "delivering" ||
    value === "completed" ||
    value === "indeterminate"
  ) {
    return value;
  }
  throw new Error("Invalid queue status");
}

function queueOutcome(
  value: unknown,
): NonNullable<QueueDeliveryClaimStateRecord["outcome"]> {
  if (
    value === "completed" ||
    value === "indeterminate" ||
    value === "abandoned"
  ) {
    return value;
  }
  throw new Error("Invalid queue claim outcome");
}
