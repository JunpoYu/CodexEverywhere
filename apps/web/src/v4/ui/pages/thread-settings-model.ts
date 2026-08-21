import {
  GatewayRemoteError,
  type InputOf,
  type OutputOf,
} from "@codex-everywhere/protocol/v2";

import { MutationNeedsReviewError } from "../../gateway/durable-mutation.js";

export type ThreadSettings = OutputOf<"thread/open">["settings"];
export type ThreadSettingsPatch = InputOf<"thread/settings/update">["patch"];

export interface ThreadSettingsDraft {
  readonly model: string;
  readonly effort: string;
  readonly sandbox: string;
  readonly approvalPolicy: string;
}

export function changedThreadSettings(
  current: ThreadSettings,
  draft: ThreadSettingsDraft,
): ThreadSettingsPatch {
  const model = draft.model.trim();
  return {
    ...(model.length > 0 && model !== current.model ? { model } : {}),
    ...(draft.effort.length > 0 && draft.effort !== current.effort
      ? { effort: draft.effort }
      : {}),
    ...(isSandbox(draft.sandbox) && draft.sandbox !== current.sandbox
      ? { sandbox: draft.sandbox }
      : {}),
    ...(isApprovalPolicy(draft.approvalPolicy) &&
    draft.approvalPolicy !== current.approvalPolicy
      ? { approvalPolicy: draft.approvalPolicy }
      : {}),
  };
}

export function threadSettingsDraft(
  current: ThreadSettings,
  patch: ThreadSettingsPatch = {},
): ThreadSettingsDraft {
  return {
    model: patch.model ?? current.model ?? "",
    effort: patch.effort ?? current.effort ?? "",
    sandbox: patch.sandbox ?? current.sandbox ?? "",
    approvalPolicy: patch.approvalPolicy ?? current.approvalPolicy ?? "",
  };
}

export function resolveThreadSettingsConflict(
  current: ThreadSettings,
  patch: ThreadSettingsPatch | undefined,
): {
  readonly draft: ThreadSettingsDraft;
  readonly remainingPatch: ThreadSettingsPatch | undefined;
} {
  const draft = threadSettingsDraft(current, patch);
  if (patch === undefined) return { draft, remainingPatch: undefined };
  const remainingPatch = changedThreadSettings(current, draft);
  return {
    draft,
    remainingPatch: hasThreadSettingsChanges(remainingPatch)
      ? remainingPatch
      : undefined,
  };
}

export function settingsFailureRecovery(
  reason: unknown,
): "none" | "refresh" | "rebase" {
  if (
    reason instanceof GatewayRemoteError &&
    reason.code === "REVISION_CONFLICT"
  ) {
    return "rebase";
  }
  if (
    reason instanceof MutationNeedsReviewError ||
    (reason instanceof GatewayRemoteError &&
      reason.code === "CODEX_REQUEST_REJECTED")
  ) {
    return "refresh";
  }
  return "none";
}

export function settingsErrorMessage(reason: unknown): string {
  if (reason instanceof MutationNeedsReviewError) {
    return "无法自动确认本次保存结果。CE 正在重新读取任务设置，请核对后再重试。";
  }
  if (
    reason instanceof GatewayRemoteError &&
    reason.code === "CODEX_REQUEST_REJECTED"
  ) {
    return "Codex 未接受这组设置。CE 已重新读取当前值；请调整组合后重试。";
  }
  return reason instanceof Error ? reason.message : "任务设置保存失败";
}

export function hasThreadSettingsChanges(patch: ThreadSettingsPatch): boolean {
  return Object.keys(patch).length > 0;
}

function isSandbox(
  value: string,
): value is "read-only" | "workspace-write" | "danger-full-access" {
  return (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  );
}

function isApprovalPolicy(
  value: string,
): value is "untrusted" | "on-request" | "never" {
  return value === "untrusted" || value === "on-request" || value === "never";
}
