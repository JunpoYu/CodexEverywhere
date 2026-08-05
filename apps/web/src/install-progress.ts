import type {
  CodexInstallProgressPayload,
  CodexInstallProgressPhase,
} from "@codex-everywhere/protocol";

export const CODEX_INSTALL_STEP_COUNT = 4;

export type CodexInstallProgressPresentation = {
  operationId: string;
  phase: CodexInstallProgressPhase;
  label: string;
  detail: string;
  step?: number;
};

const phasePresentation: Record<
  CodexInstallProgressPhase,
  Omit<CodexInstallProgressPresentation, "operationId" | "phase">
> = {
  preparing: {
    label: "正在准备 Codex",
    detail: "检查并准备当前用户的 ~/.local 目录",
    step: 1,
  },
  installing: {
    label: "正在下载并安装 Codex",
    detail: "下载速度取决于宿主机网络，通常这是耗时最长的一步",
    step: 2,
  },
  verifying: {
    label: "正在验证 Codex",
    detail: "检查版本以及 ~/.local/bin/codex 是否可以执行",
    step: 3,
  },
  completed: {
    label: "Codex 已是最新安装",
    detail: "版本验证已通过；如果服务正在运行，下一步会安全重启",
    step: 4,
  },
  failed: {
    label: "Codex 安装或更新失败",
    detail: "请查看下方错误后重试；已完成的下载不会暴露到浏览器",
  },
};

export function codexInstallProgressPresentation(
  value: unknown,
): CodexInstallProgressPresentation | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (typeof value.operationId !== "string" || value.operationId.length === 0)
    return undefined;
  if (!isPhase(value.phase)) return undefined;
  const payload = value as CodexInstallProgressPayload;
  return {
    operationId: payload.operationId,
    phase: payload.phase,
    ...phasePresentation[payload.phase],
  };
}

function isPhase(value: unknown): value is CodexInstallProgressPhase {
  return (
    value === "preparing" ||
    value === "installing" ||
    value === "verifying" ||
    value === "completed" ||
    value === "failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
