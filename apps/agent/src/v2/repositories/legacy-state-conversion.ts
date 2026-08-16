import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { Database } from "sql.js";

import {
  LEGACY_STATE_SCHEMA_V4,
  LEGACY_STATE_SCHEMA_VERSION,
} from "../../host/state-store.js";
import {
  blob,
  insertIdentity,
  integer,
  nullableText,
  queryRows,
  readIdentity,
  text,
} from "./snapshot-sql.js";
import { loadSqliteRuntime } from "./sqlite-runtime.js";
import type {
  AdminStateRecords,
  MutationReceiptStateRecord,
  QueueDeliveryClaimStateRecord,
  QueueItemStateRecord,
  StateSnapshotV1,
  UserStateRecords,
} from "./state-snapshot.js";

const PERMANENT_EXPIRY = "9999-12-31T23:59:59.999Z";
const DURABLE_LEGACY_METHODS = new Set([
  "thread/start",
  "thread/fork",
  "turn/start",
  "queue/add",
]);
const REQUIRED_LEGACY_TABLES = [
  "workspace_roots",
  "workspace_settings",
  "workspace_authorization_state",
  "user_preferences",
  "thread_permissions",
  "thread_permission_observation_state",
  "thread_permission_observations",
  "trusted_devices",
  "pairing_sessions",
  "passkeys",
  "recovery_codes",
  "admin_recovery_tickets",
  "web_password",
  "idempotency_keys",
  "durable_mutation_claims",
  "queue_consumption_claims",
  "queue_item_states",
  "queue_items",
  "schedules",
  "schedule_runs",
  "push_subscriptions",
  "audit_events",
  "thread_cache",
  "admin_managed_users",
  "admin_audit_events",
  "admin_idempotency",
] as const;

export type LegacyStateKind = "user" | "admin";

export interface LegacyPersistentBlockers {
  readonly schedules: number;
  readonly scheduleRuns: number;
  readonly pushSubscriptions: number;
  readonly deliveringQueue: number;
  readonly pendingMutations: number;
}

export class StateConversionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly counts?: Readonly<Record<string, number>>,
  ) {
    super(message);
    this.name = "StateConversionError";
  }
}

export function inspectLegacyPersistentBlockers(
  database: Database,
): LegacyPersistentBlockers {
  assertLegacyDatabase(database);
  return {
    schedules: rowCount(database, "schedules"),
    scheduleRuns: rowCount(database, "schedule_runs"),
    pushSubscriptions: rowCount(database, "push_subscriptions"),
    deliveringQueue: Number(
      queryRows(
        database,
        `SELECT
          (SELECT COUNT(*) FROM queue_item_states WHERE status IN ('running', 'delivering')) +
          (SELECT COUNT(*) FROM queue_consumption_claims WHERE outcome IS NULL) AS count`,
      )[0]?.count ?? 0,
    ),
    pendingMutations: Number(
      queryRows(
        database,
        "SELECT COUNT(*) AS count FROM durable_mutation_claims WHERE completed_at IS NULL OR result_json IS NULL",
      )[0]?.count ?? 0,
    ),
  };
}

export function readLegacyStateSnapshot(
  database: Database,
  kind: LegacyStateKind,
  now = new Date(),
): StateSnapshotV1 {
  assertLegacyDatabase(database);
  const blockers = inspectLegacyPersistentBlockers(database);
  if (
    blockers.schedules > 0 ||
    blockers.scheduleRuns > 0 ||
    blockers.pushSubscriptions > 0
  ) {
    throw new StateConversionError(
      "UNSUPPORTED_LEGACY_DATA",
      "Schedule or Push data must be removed or migrated by a future release",
      {
        schedules: blockers.schedules,
        scheduleRuns: blockers.scheduleRuns,
        pushSubscriptions: blockers.pushSubscriptions,
      },
    );
  }
  if (blockers.deliveringQueue > 0 || blockers.pendingMutations > 0) {
    throw new StateConversionError(
      "STATE_NOT_QUIESCENT",
      "Legacy state contains delivering Queue items or pending mutations",
      {
        deliveringQueue: blockers.deliveringQueue,
        pendingMutations: blockers.pendingMutations,
      },
    );
  }

  return kind === "user"
    ? { version: 1, kind, records: readLegacyUserRecords(database, now) }
    : { version: 1, kind, records: readLegacyAdminRecords(database, now) };
}

export async function writeLegacyStateSnapshot(
  snapshot: StateSnapshotV1,
): Promise<Uint8Array> {
  assertReverseRepresentable(snapshot);
  const SQL = await loadSqliteRuntime();
  const database = new SQL.Database();
  try {
    database.run(LEGACY_STATE_SCHEMA_V4);
    database.run(`PRAGMA user_version = ${LEGACY_STATE_SCHEMA_VERSION}`);
    database.run("PRAGMA application_id = 0");
    database.run("PRAGMA foreign_keys = ON");
    database.run("BEGIN IMMEDIATE");
    try {
      if (snapshot.kind === "user") {
        writeLegacyUserRecords(database, snapshot.records);
      } else {
        writeLegacyAdminRecords(database, snapshot.records);
      }
      database.run("COMMIT");
    } catch (error) {
      database.run("ROLLBACK");
      throw error;
    }
    const integrity = database.exec("PRAGMA integrity_check")[0]
      ?.values[0]?.[0];
    if (integrity !== "ok")
      throw new Error("Generated legacy database is corrupt");
    return database.export();
  } finally {
    database.close();
  }
}

export function assertReverseRepresentable(snapshot: StateSnapshotV1): void {
  const receipts = snapshot.records.mutationReceipts;
  const unsettled = receipts.filter(
    (receipt) => receipt.status !== "completed",
  );
  if (unsettled.length > 0) {
    throw new StateConversionError(
      "UNREPRESENTABLE_V4_STATE",
      "v0.3 cannot represent pending or indeterminate v0.4 mutations",
      { mutationReceipts: unsettled.length },
    );
  }
  if (snapshot.kind === "admin") return;

  if (
    snapshot.records.preferences !== undefined &&
    (snapshot.records.preferences.theme !== "system" ||
      snapshot.records.preferences.locale !== "zh-CN")
  ) {
    throw new StateConversionError(
      "UNREPRESENTABLE_V4_STATE",
      "v0.3 cannot preserve the selected theme or locale",
    );
  }
  const customLabels = snapshot.records.workspaces.filter(
    (workspace) => workspace.label !== workspaceLabel(workspace.path),
  );
  if (customLabels.length > 0) {
    throw new StateConversionError(
      "UNREPRESENTABLE_V4_STATE",
      "v0.3 cannot preserve custom Workspace labels",
      { workspaces: customLabels.length },
    );
  }
  const delivering = snapshot.records.queueItems.filter(
    (item) => item.status === "delivering",
  );
  if (delivering.length > 0) {
    throw new StateConversionError(
      "STATE_NOT_QUIESCENT",
      "Queue delivery must stop before rollback",
      { deliveringQueue: delivering.length },
    );
  }
  for (const item of snapshot.records.queueItems) parseQueueRequest(item);
  for (const receipt of receipts) {
    if (
      DURABLE_LEGACY_METHODS.has(receipt.method) &&
      receipt.requestFingerprint === undefined
    ) {
      throw new StateConversionError(
        "UNREPRESENTABLE_V4_STATE",
        `A ${receipt.method} receipt has no rollback fingerprint`,
      );
    }
  }
}

function assertLegacyDatabase(database: Database): void {
  const version = Number(
    database.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? 0,
  );
  if (version !== LEGACY_STATE_SCHEMA_VERSION) {
    throw new StateConversionError(
      "UNSUPPORTED_SOURCE_SCHEMA",
      `Expected legacy schema 4, found schema ${version}`,
    );
  }
  const applicationId = Number(
    database.exec("PRAGMA application_id")[0]?.values[0]?.[0] ?? 0,
  );
  if (applicationId !== 0) {
    throw new StateConversionError(
      "WRONG_MIGRATION_DIRECTION",
      "The source is not a v0.3 state database",
    );
  }
  const tables = new Set(
    queryRows(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => text(row.name, "legacy table name")),
  );
  const missing = REQUIRED_LEGACY_TABLES.filter((table) => !tables.has(table));
  if (missing.length > 0) {
    throw new StateConversionError(
      "INCOMPLETE_SOURCE_SCHEMA",
      `Legacy schema 4 is missing required tables: ${missing.join(", ")}`,
    );
  }
}

function readLegacyUserRecords(
  database: Database,
  now: Date,
): UserStateRecords {
  const nowIso = now.toISOString();
  const identity = filterValidIdentity(readIdentity(database), nowIso);
  const workspaceRows = queryRows(
    database,
    "SELECT path, created_at FROM workspace_roots ORDER BY path",
  );
  const workspaces = workspaceRows.map((row) => {
    const path = text(row.path, "legacy workspace path");
    return {
      id: workspaceId(path),
      path,
      label: workspaceLabel(path),
      createdAt: text(row.created_at, "legacy workspace created_at"),
      revision: 0,
    };
  });
  const defaultPath = nullableText(
    queryRows(
      database,
      "SELECT default_path FROM workspace_settings WHERE id = 1",
    )[0]?.default_path,
    "legacy default workspace",
  );
  const preferenceRow = queryRows(
    database,
    "SELECT default_sandbox, default_approval_policy, updated_at FROM user_preferences WHERE id = 1",
  )[0];
  const permissionGeneration = Number(
    queryRows(
      database,
      "SELECT generation FROM thread_permission_observation_state WHERE id = 1",
    )[0]?.generation ?? 0,
  );
  const threadObservations = new Map(
    queryRows(
      database,
      "SELECT thread_id, generation FROM thread_permission_observations ORDER BY thread_id",
    ).map((row) => [
      text(row.thread_id, "legacy thread observation id"),
      integer(row.generation, "legacy thread observation generation"),
    ]),
  );
  const recoveryHandoffs = queryRows(
    database,
    "SELECT hash, expires_at, created_at, used_at FROM admin_recovery_tickets WHERE expires_at > ? AND used_at IS NULL ORDER BY created_at, hex(hash)",
    [nowIso],
  ).map((row) => ({
    hash: blob(row.hash, "legacy recovery handoff hash"),
    expiresAt: text(row.expires_at, "legacy recovery handoff expires_at"),
    createdAt: text(row.created_at, "legacy recovery handoff created_at"),
  }));
  return {
    createdAt: nowIso,
    sourceSchema: LEGACY_STATE_SCHEMA_VERSION,
    workspaceAuthorizationRevision: Number(
      queryRows(
        database,
        "SELECT revision FROM workspace_authorization_state WHERE id = 1",
      )[0]?.revision ?? 0,
    ),
    workspaces,
    ...(defaultPath === undefined
      ? {}
      : { defaultWorkspaceId: workspaceId(defaultPath) }),
    ...(preferenceRow === undefined
      ? {}
      : {
          preferences: {
            theme: "system",
            locale: "zh-CN",
            defaultSandbox: text(
              preferenceRow.default_sandbox,
              "legacy preference sandbox",
            ),
            defaultApprovalPolicy: text(
              preferenceRow.default_approval_policy,
              "legacy preference approval policy",
            ),
            revision: 0,
            updatedAt: text(
              preferenceRow.updated_at,
              "legacy preference updated_at",
            ),
          },
        }),
    threadPermissionGeneration: permissionGeneration,
    threadPermissions: queryRows(
      database,
      "SELECT thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, updated_at FROM thread_permissions ORDER BY thread_id",
    ).map((row) => {
      const threadId = text(row.thread_id, "legacy thread permission id");
      return {
        threadId,
        approvalPolicyJson: text(
          row.approval_policy_json,
          "legacy approval policy",
        ),
        approvalsReviewer: text(
          row.approvals_reviewer,
          "legacy approvals reviewer",
        ),
        sandboxMode: text(row.sandbox_mode, "legacy sandbox mode"),
        revision: threadObservations.get(threadId) ?? 0,
        updatedAt: text(row.updated_at, "legacy permission updated_at"),
      };
    }),
    threadPermissionObservations: [...threadObservations].map(
      ([threadId, generation]) => ({ threadId, generation }),
    ),
    ...identity,
    recoveryHandoffs,
    mutationReceipts: readLegacyMutationReceipts(database, nowIso),
    queueItems: readLegacyQueueItems(database),
    queueDeliveryClaims: readLegacyQueueClaims(database),
    auditEvents: queryRows(
      database,
      "SELECT id, kind, subject_id, created_at FROM audit_events ORDER BY id",
    ).map((row) => ({
      id: `legacy:${integer(row.id, "legacy audit id")}`,
      kind: text(row.kind, "legacy audit kind"),
      ...(nullableText(row.subject_id, "legacy audit subject") === undefined
        ? {}
        : {
            subjectId: nullableText(row.subject_id, "legacy audit subject")!,
          }),
      createdAt: text(row.created_at, "legacy audit created_at"),
    })),
  };
}

function readLegacyAdminRecords(
  database: Database,
  now: Date,
): AdminStateRecords {
  const nowIso = now.toISOString();
  return {
    createdAt: nowIso,
    sourceSchema: LEGACY_STATE_SCHEMA_VERSION,
    identity: filterValidIdentity(readIdentity(database), nowIso),
    managedUsers: queryRows(
      database,
      "SELECT uid, username, home, status, registered_at, updated_at, revision, remove_after FROM admin_managed_users ORDER BY username",
    ).map((row) => ({
      uid: integer(row.uid, "legacy managed uid"),
      username: text(row.username, "legacy managed username"),
      home: text(row.home, "legacy managed home"),
      status: text(row.status, "legacy managed status"),
      registeredAt: text(row.registered_at, "legacy managed registered_at"),
      updatedAt: text(row.updated_at, "legacy managed updated_at"),
      revision: integer(row.revision, "legacy managed revision"),
      ...(nullableText(row.remove_after, "legacy managed remove_after") ===
      undefined
        ? {}
        : {
            removeAfter: nullableText(
              row.remove_after,
              "legacy managed remove_after",
            )!,
          }),
    })),
    auditEvents: queryRows(
      database,
      "SELECT id, request_id, actor, action, target_username, result, created_at FROM admin_audit_events ORDER BY created_at, id",
    ).map((row) => ({
      id: text(row.id, "legacy admin audit id"),
      requestId: text(row.request_id, "legacy admin audit request id"),
      actor: text(row.actor, "legacy admin audit actor"),
      action: text(row.action, "legacy admin audit action"),
      ...(nullableText(row.target_username, "legacy admin audit target") ===
      undefined
        ? {}
        : {
            targetUsername: nullableText(
              row.target_username,
              "legacy admin audit target",
            )!,
          }),
      result: text(row.result, "legacy admin audit result"),
      createdAt: text(row.created_at, "legacy admin audit created_at"),
    })),
    mutationReceipts: queryRows(
      database,
      "SELECT request_id, result_json, created_at FROM admin_idempotency ORDER BY created_at, request_id",
    ).map((row) => ({
      operationKey: text(row.request_id, "legacy admin operation key"),
      method: "admin/legacy",
      status: "completed",
      resultJson: validateSafeResult(
        text(row.result_json, "legacy admin result"),
      ),
      createdAt: text(row.created_at, "legacy admin mutation created_at"),
      updatedAt: text(row.created_at, "legacy admin mutation created_at"),
    })),
  };
}

function filterValidIdentity(
  identity: ReturnType<typeof readIdentity>,
  nowIso: string,
): ReturnType<typeof readIdentity> {
  return {
    ...identity,
    pairingSessions: identity.pairingSessions.filter(
      (session) => session.expiresAt > nowIso,
    ),
  };
}

function readLegacyMutationReceipts(
  database: Database,
  nowIso: string,
): MutationReceiptStateRecord[] {
  const receipts = new Map<string, MutationReceiptStateRecord>();
  for (const row of queryRows(
    database,
    "SELECT key, result_json, expires_at FROM idempotency_keys WHERE expires_at > ? ORDER BY key",
    [nowIso],
  )) {
    receipts.set(text(row.key, "legacy idempotency key"), {
      operationKey: text(row.key, "legacy idempotency key"),
      method: "legacy/v1",
      status: "completed",
      resultJson: validateSafeResult(
        text(row.result_json, "legacy idempotency result"),
      ),
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: text(row.expires_at, "legacy idempotency expiry"),
    });
  }
  for (const row of queryRows(
    database,
    "SELECT key, method, request_fingerprint, result_json, created_at, completed_at FROM durable_mutation_claims ORDER BY created_at, key",
  )) {
    const completedAt = nullableText(
      row.completed_at,
      "legacy durable completed_at",
    );
    const resultJson = nullableText(row.result_json, "legacy durable result");
    const createdAt = text(row.created_at, "legacy durable created_at");
    receipts.set(text(row.key, "legacy durable key"), {
      operationKey: text(row.key, "legacy durable key"),
      method: text(row.method, "legacy durable method"),
      requestFingerprint: text(
        row.request_fingerprint,
        "legacy durable fingerprint",
      ),
      status:
        resultJson !== undefined
          ? "completed"
          : completedAt === undefined
            ? "pending"
            : "indeterminate",
      ...(resultJson === undefined
        ? {}
        : { resultJson: validateSafeResult(resultJson) }),
      createdAt,
      updatedAt: completedAt ?? createdAt,
    });
  }
  return [...receipts.values()];
}

function readLegacyQueueItems(database: Database): QueueItemStateRecord[] {
  return queryRows(
    database,
    `SELECT q.id, q.workspace_path, q.request_json, q.status AS physical_status,
            q.created_at, q.updated_at, s.status AS logical_status,
            c.outcome AS claim_outcome
       FROM queue_items q
       LEFT JOIN queue_item_states s ON s.queue_item_id = q.id
       LEFT JOIN queue_consumption_claims c ON c.queue_item_id = q.id
      ORDER BY q.created_at, q.id`,
  ).flatMap((row) => {
    if (text(row.physical_status, "legacy Queue physical status") !== "done") {
      throw new StateConversionError(
        "UNSAFE_LEGACY_QUEUE",
        "Legacy Queue rollback barrier is missing",
      );
    }
    const claimOutcome = nullableText(
      row.claim_outcome,
      "legacy Queue outcome",
    );
    if (claimOutcome === "completed" || claimOutcome === "abandoned") return [];
    const logicalStatus = nullableText(
      row.logical_status,
      "legacy Queue logical status",
    );
    const status =
      claimOutcome === "indeterminate" ? "indeterminate" : logicalStatus;
    if (
      status !== "pending" &&
      status !== "paused" &&
      status !== "indeterminate"
    ) {
      return [];
    }
    const requestJson = text(row.request_json, "legacy Queue request");
    const request = parseLegacyQueueJson(requestJson);
    return [
      {
        id: text(row.id, "legacy Queue id"),
        workspacePath: text(row.workspace_path, "legacy Queue workspace"),
        threadId: request.threadId,
        requestJson,
        status,
        revision: 0,
        createdAt: text(row.created_at, "legacy Queue created_at"),
        updatedAt: text(row.updated_at, "legacy Queue updated_at"),
      },
    ];
  });
}

function readLegacyQueueClaims(
  database: Database,
): QueueDeliveryClaimStateRecord[] {
  return queryRows(
    database,
    `SELECT c.queue_item_id, c.operation, c.thread_id,
            c.client_user_message_id, c.outcome, c.turn_id,
            c.created_at, c.completed_at
       FROM queue_consumption_claims c
      WHERE c.outcome = 'indeterminate'
      ORDER BY c.created_at, c.queue_item_id`,
  ).map((row) => ({
    queueItemId: text(row.queue_item_id, "legacy Queue claim id"),
    operation: text(row.operation, "legacy Queue operation"),
    threadId: text(row.thread_id, "legacy Queue claim thread"),
    clientUserMessageId: text(
      row.client_user_message_id,
      "legacy Queue client message",
    ),
    outcome: "indeterminate",
    ...(nullableText(row.turn_id, "legacy Queue turn") === undefined
      ? {}
      : { turnId: nullableText(row.turn_id, "legacy Queue turn")! }),
    createdAt: text(row.created_at, "legacy Queue claim created_at"),
    ...(nullableText(row.completed_at, "legacy Queue completed_at") ===
    undefined
      ? {}
      : {
          completedAt: nullableText(
            row.completed_at,
            "legacy Queue completed_at",
          )!,
        }),
  }));
}

function writeLegacyUserRecords(
  database: Database,
  records: UserStateRecords,
): void {
  for (const workspace of records.workspaces) {
    database.run(
      "INSERT INTO workspace_roots (path, created_at) VALUES (?, ?)",
      [workspace.path, workspace.createdAt],
    );
  }
  if (records.defaultWorkspaceId !== undefined) {
    const selected = records.workspaces.find(
      (workspace) => workspace.id === records.defaultWorkspaceId,
    );
    if (!selected)
      throw new Error("Default Workspace is missing during rollback");
    database.run(
      "INSERT INTO workspace_settings (id, default_path) VALUES (1, ?)",
      [selected.path],
    );
  }
  database.run(
    "UPDATE workspace_authorization_state SET revision = ? WHERE id = 1",
    [records.workspaceAuthorizationRevision],
  );
  if (records.preferences !== undefined) {
    database.run(
      "INSERT INTO user_preferences (id, default_sandbox, default_approval_policy, updated_at) VALUES (1, ?, ?, ?)",
      [
        records.preferences.defaultSandbox,
        records.preferences.defaultApprovalPolicy,
        records.preferences.updatedAt,
      ],
    );
  }
  for (const permission of records.threadPermissions) {
    database.run(
      "INSERT INTO thread_permissions (thread_id, approval_policy_json, approvals_reviewer, sandbox_mode, updated_at) VALUES (?, ?, ?, ?, ?)",
      [
        permission.threadId,
        permission.approvalPolicyJson,
        permission.approvalsReviewer,
        permission.sandboxMode,
        permission.updatedAt,
      ],
    );
  }
  database.run(
    "UPDATE thread_permission_observation_state SET generation = ? WHERE id = 1",
    [records.threadPermissionGeneration],
  );
  for (const observation of records.threadPermissionObservations) {
    database.run(
      "INSERT INTO thread_permission_observations (thread_id, generation) VALUES (?, ?)",
      [observation.threadId, observation.generation],
    );
  }
  insertIdentity(database, records);
  for (const handoff of records.recoveryHandoffs) {
    database.run(
      "INSERT INTO admin_recovery_tickets (hash, expires_at, created_at, used_at) VALUES (?, ?, ?, ?)",
      [
        handoff.hash,
        handoff.expiresAt,
        handoff.createdAt,
        handoff.usedAt ?? null,
      ],
    );
  }
  writeLegacyMutationReceipts(database, records.mutationReceipts);
  for (const item of records.queueItems) {
    if (item.status === "completed") continue;
    parseQueueRequest(item);
    database.run(
      "INSERT INTO queue_items (id, workspace_path, request_json, status, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?)",
      [
        item.id,
        item.workspacePath,
        item.requestJson,
        item.createdAt,
        item.updatedAt,
      ],
    );
    if (item.status === "pending" || item.status === "paused") {
      database.run(
        "INSERT INTO queue_item_states (queue_item_id, status, updated_at) VALUES (?, ?, ?)",
        [item.id, item.status, item.updatedAt],
      );
    }
  }
  for (const claim of records.queueDeliveryClaims) {
    if (claim.outcome !== "indeterminate") continue;
    database.run(
      "INSERT INTO queue_consumption_claims (queue_item_id, operation, thread_id, client_user_message_id, outcome, turn_id, created_at, completed_at) VALUES (?, ?, ?, ?, 'indeterminate', ?, ?, ?)",
      [
        claim.queueItemId,
        claim.operation,
        claim.threadId,
        claim.clientUserMessageId,
        claim.turnId ?? null,
        claim.createdAt,
        claim.completedAt ?? claim.createdAt,
      ],
    );
  }
  for (const audit of records.auditEvents) {
    database.run(
      "INSERT INTO audit_events (kind, subject_id, created_at) VALUES (?, ?, ?)",
      [audit.kind, audit.subjectId ?? null, audit.createdAt],
    );
  }
}

function writeLegacyAdminRecords(
  database: Database,
  records: AdminStateRecords,
): void {
  insertIdentity(database, records.identity);
  for (const user of records.managedUsers) {
    database.run(
      "INSERT INTO admin_managed_users (uid, username, home, status, registered_at, updated_at, revision, remove_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        user.uid,
        user.username,
        user.home,
        user.status,
        user.registeredAt,
        user.updatedAt,
        user.revision,
        user.removeAfter ?? null,
      ],
    );
  }
  for (const audit of records.auditEvents) {
    database.run(
      "INSERT INTO admin_audit_events (id, request_id, actor, action, target_username, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        audit.id,
        audit.requestId,
        audit.actor,
        audit.action,
        audit.targetUsername ?? null,
        audit.result,
        audit.createdAt,
      ],
    );
  }
  for (const receipt of records.mutationReceipts) {
    database.run(
      "INSERT INTO admin_idempotency (request_id, result_json, created_at) VALUES (?, ?, ?)",
      [receipt.operationKey, receipt.resultJson ?? "null", receipt.createdAt],
    );
  }
}

function writeLegacyMutationReceipts(
  database: Database,
  receipts: readonly MutationReceiptStateRecord[],
): void {
  for (const receipt of receipts) {
    const result = receipt.resultJson ?? "null";
    database.run(
      "INSERT OR REPLACE INTO idempotency_keys (key, result_json, expires_at) VALUES (?, ?, ?)",
      [receipt.operationKey, result, receipt.expiresAt ?? PERMANENT_EXPIRY],
    );
    if (DURABLE_LEGACY_METHODS.has(receipt.method)) {
      database.run(
        "INSERT INTO durable_mutation_claims (key, method, request_fingerprint, result_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          receipt.operationKey,
          receipt.method,
          receipt.requestFingerprint!,
          result,
          receipt.createdAt,
          receipt.updatedAt,
        ],
      );
    }
  }
}

function parseLegacyQueueJson(requestJson: string): {
  readonly threadId: string;
  readonly turnPayload: Record<string, unknown>;
} {
  try {
    const value: unknown = JSON.parse(requestJson);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).threadId !== "string" ||
      typeof (value as Record<string, unknown>).turnPayload !== "object" ||
      (value as Record<string, unknown>).turnPayload === null ||
      Array.isArray((value as Record<string, unknown>).turnPayload)
    ) {
      throw new Error("invalid shape");
    }
    return value as {
      readonly threadId: string;
      readonly turnPayload: Record<string, unknown>;
    };
  } catch {
    throw new StateConversionError(
      "CORRUPT_QUEUE_ITEM",
      "A Queue item has an invalid request payload",
    );
  }
}

function parseQueueRequest(item: QueueItemStateRecord): void {
  const request = parseLegacyQueueJson(item.requestJson);
  if (request.threadId !== item.threadId) {
    throw new StateConversionError(
      "UNREPRESENTABLE_V4_STATE",
      "A Queue item thread identity cannot be represented by v0.3",
    );
  }
}

function validateSafeResult(resultJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(resultJson) as unknown;
  } catch {
    throw new StateConversionError(
      "CORRUPT_MUTATION_RECEIPT",
      "A mutation receipt contains invalid JSON",
    );
  }
  if (containsSensitiveResult(value)) {
    throw new StateConversionError(
      "SENSITIVE_MUTATION_RECEIPT",
      "A persistent mutation receipt contains one-time authentication data",
    );
  }
  return resultJson;
}

function containsSensitiveResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveResult);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      [
        "handoffCode",
        "loginResponse",
        "recoveryCodes",
        "registrationResponse",
        "resumeToken",
        "userCode",
      ].includes(key) ||
      containsSensitiveResult(nested)
    ) {
      return true;
    }
  }
  return false;
}

function workspaceId(path: string): string {
  return `workspace:${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
}

function workspaceLabel(path: string): string {
  return basename(path) || path;
}

function rowCount(database: Database, table: string): number {
  return Number(
    queryRows(database, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ??
      0,
  );
}

export async function openLegacyDatabase(bytes: Uint8Array): Promise<Database> {
  const SQL = await loadSqliteRuntime();
  return new SQL.Database(bytes);
}
