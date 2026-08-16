export const USER_STATE_APPLICATION_ID = 0x43455534;
export const ADMIN_STATE_APPLICATION_ID = 0x43454134;
export const V4_STATE_SCHEMA_VERSION = 1;

const COMMON_IDENTITY_SCHEMA = `
CREATE TABLE trusted_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key BLOB NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE pairing_sessions (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE passkeys (
  credential_id BLOB PRIMARY KEY,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL CHECK (sign_count >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE recovery_codes (
  hash BLOB PRIMARY KEY,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE web_password (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  registration_record TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const COMMON_MUTATION_SCHEMA = `
CREATE TABLE mutation_receipts (
  operation_key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  request_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'indeterminate')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX mutation_receipts_expiry ON mutation_receipts(expires_at);
`;

export const USER_STATE_SCHEMA = `
PRAGMA application_id = ${USER_STATE_APPLICATION_ID};
PRAGMA user_version = ${V4_STATE_SCHEMA_VERSION};
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kind TEXT NOT NULL CHECK (kind = 'user'),
  created_at TEXT NOT NULL,
  source_schema INTEGER NOT NULL,
  workspace_authorization_revision INTEGER NOT NULL CHECK (workspace_authorization_revision >= 0),
  thread_permission_generation INTEGER NOT NULL CHECK (thread_permission_generation >= 0),
  default_workspace_id TEXT
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
CREATE TABLE preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  theme TEXT NOT NULL CHECK (theme IN ('system', 'light', 'dark')),
  locale TEXT NOT NULL,
  default_sandbox TEXT NOT NULL,
  default_approval_policy TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE thread_permissions (
  thread_id TEXT PRIMARY KEY,
  approval_policy_json TEXT NOT NULL,
  approvals_reviewer TEXT NOT NULL,
  sandbox_mode TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
CREATE TABLE thread_permission_observations (
  thread_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
${COMMON_IDENTITY_SCHEMA}
CREATE TABLE recovery_handoffs (
  hash BLOB PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
${COMMON_MUTATION_SCHEMA}
CREATE TABLE queue_items (
  id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paused', 'delivering', 'completed', 'indeterminate')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX queue_items_dispatch ON queue_items(status, created_at, id);
CREATE TABLE queue_delivery_claims (
  queue_item_id TEXT PRIMARY KEY REFERENCES queue_items(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  client_user_message_id TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('completed', 'indeterminate', 'abandoned')),
  turn_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_events_created_at ON audit_events(created_at DESC);
`;

export const ADMIN_STATE_SCHEMA = `
PRAGMA application_id = ${ADMIN_STATE_APPLICATION_ID};
PRAGMA user_version = ${V4_STATE_SCHEMA_VERSION};
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;
CREATE TABLE metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kind TEXT NOT NULL CHECK (kind = 'admin'),
  created_at TEXT NOT NULL,
  source_schema INTEGER NOT NULL
);
${COMMON_IDENTITY_SCHEMA}
${COMMON_MUTATION_SCHEMA}
CREATE TABLE managed_users (
  uid INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  home TEXT NOT NULL,
  status TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  remove_after TEXT
);
CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_username TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_created_at ON admin_audit(created_at DESC);
`;

export const USER_STATE_TABLES = [
  "metadata",
  "workspaces",
  "preferences",
  "thread_permissions",
  "thread_permission_observations",
  "trusted_devices",
  "pairing_sessions",
  "passkeys",
  "recovery_codes",
  "recovery_handoffs",
  "web_password",
  "mutation_receipts",
  "queue_items",
  "queue_delivery_claims",
  "audit_events",
] as const;

export const ADMIN_STATE_TABLES = [
  "metadata",
  "trusted_devices",
  "pairing_sessions",
  "passkeys",
  "recovery_codes",
  "web_password",
  "mutation_receipts",
  "managed_users",
  "admin_audit",
] as const;
