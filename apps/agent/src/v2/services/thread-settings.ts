import {
  GatewayV2Error,
  type JsonValue,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import { isCodexObject } from "../codex/codex-json.js";
import type { StoredThreadSettings } from "../repositories/thread-settings-repository.js";

export interface RuntimeThreadSettings {
  readonly model?: string;
  readonly effort?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly approvalPolicy?: "untrusted" | "on-request" | "never";
}

type ThreadSettingsView = OutputOf<"thread/settings/update">;

export function threadSettingsView(
  revision: number,
  settings: RuntimeThreadSettings,
): ThreadSettingsView {
  return {
    version: 1,
    revision,
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.effort === undefined ? {} : { effort: settings.effort }),
    ...(settings.sandbox === undefined ? {} : { sandbox: settings.sandbox }),
    ...(settings.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: settings.approvalPolicy }),
  };
}

export function runtimeThreadSettings(
  response: Readonly<Record<string, JsonValue>>,
  stored: StoredThreadSettings,
): RuntimeThreadSettings {
  const model = typeof response.model === "string" ? response.model : undefined;
  const effort =
    typeof response.reasoningEffort === "string"
      ? response.reasoningEffort
      : typeof response.effort === "string"
        ? response.effort
        : undefined;
  const approvalPolicy =
    approvalFromValue(response.approvalPolicy) ?? stored.approvalPolicy;
  const sandbox = sandboxFromValue(response.sandbox) ?? stored.sandbox;
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
  };
}

export function mergeStoredThreadPermissions(
  runtime: RuntimeThreadSettings,
  stored: StoredThreadSettings,
): RuntimeThreadSettings {
  return {
    ...runtime,
    ...(stored.sandbox === undefined ? {} : { sandbox: stored.sandbox }),
    ...(stored.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: stored.approvalPolicy }),
  };
}

export function codexSandboxPolicy(
  value: "read-only" | "workspace-write" | "danger-full-access",
): Readonly<Record<string, JsonValue>> {
  if (value === "read-only") return { type: "readOnly", networkAccess: false };
  if (value === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: "dangerFullAccess" };
}

export function threadSettingsRevisionConflict(): GatewayV2Error {
  return new GatewayV2Error(
    "REVISION_CONFLICT",
    "Task settings changed; refresh before saving",
  );
}

function approvalFromValue(
  value: JsonValue | undefined,
): RuntimeThreadSettings["approvalPolicy"] {
  return value === "untrusted" || value === "on-request" || value === "never"
    ? value
    : undefined;
}

function sandboxFromValue(
  value: JsonValue | undefined,
): RuntimeThreadSettings["sandbox"] {
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  if (!isCodexObject(value)) return undefined;
  if (value.type === "readOnly") return "read-only";
  if (value.type === "workspaceWrite") return "workspace-write";
  if (value.type === "dangerFullAccess") return "danger-full-access";
  return undefined;
}
