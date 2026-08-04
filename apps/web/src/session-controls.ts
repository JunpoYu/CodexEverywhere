import type {
  McpServerElicitationRequestResponse,
  SandboxMode,
  SandboxPolicy,
  ThreadTokenUsage,
} from "@codex-everywhere/codex-app-server-schema/v2";

export type ApprovalPresentation = {
  title: string;
  summary: string;
  code?: string;
  meta: string[];
};

export function approvalPresentation(
  method: unknown,
  value: unknown,
): ApprovalPresentation {
  const params = isRecord(value) ? value : {};
  const reason = typeof params.reason === "string" ? params.reason : "";
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    const network = isRecord(params.networkApprovalContext)
      ? params.networkApprovalContext
      : undefined;
    if (network && typeof network.host === "string") {
      return {
        title: "允许 Codex 访问网络？",
        summary: reason || "Codex 需要连接外部网络来继续当前任务。",
        meta: [
          `目标：${String(network.protocol ?? "网络")}://${network.host}`,
          ...(typeof params.cwd === "string"
            ? [`工作目录：${params.cwd}`]
            : []),
        ],
      };
    }
    return {
      title: "允许 Codex 执行命令？",
      summary: reason || "该命令超出了当前自动执行权限，需要你的确认。",
      ...(typeof params.command === "string" ? { code: params.command } : {}),
      meta: typeof params.cwd === "string" ? [`工作目录：${params.cwd}`] : [],
    };
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    return {
      title: "允许 Codex 修改文件？",
      summary: reason || "Codex 想应用上方显示的文件修改。",
      meta:
        typeof params.grantRoot === "string"
          ? [`写入范围：${params.grantRoot}`]
          : [],
    };
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = isRecord(params.permissions) ? params.permissions : {};
    const network =
      isRecord(permissions.network) && permissions.network.enabled;
    const fileSystem = isRecord(permissions.fileSystem)
      ? permissions.fileSystem
      : {};
    const roots = [
      ...(Array.isArray(fileSystem.read) ? fileSystem.read : []),
      ...(Array.isArray(fileSystem.write) ? fileSystem.write : []),
    ].filter((item): item is string => typeof item === "string");
    return {
      title: "允许扩大本轮权限？",
      summary: reason || "Codex 请求当前任务所需的额外权限。",
      meta: [
        ...(network ? ["网络：允许访问"] : []),
        ...(roots.length > 0 ? [`文件范围：${roots.join("、")}`] : []),
      ],
    };
  }
  if (method === "mcpServer/elicitation/request") {
    return {
      title: "外部工具请求确认",
      summary:
        typeof params.message === "string"
          ? params.message
          : "连接的 MCP 工具需要你的确认后才能继续。",
      meta:
        typeof params.serverName === "string"
          ? [`工具服务：${params.serverName}`]
          : [],
    };
  }
  return {
    title: "Codex 请求你的确认",
    summary: reason || "请确认是否允许 Codex 继续这项操作。",
    meta: [],
  };
}

export function sandboxModeForPolicy(type: SandboxPolicy["type"]): SandboxMode {
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "readOnly") return "read-only";
  return "workspace-write";
}

export function mcpElicitationResponse(
  accepted: boolean,
): McpServerElicitationRequestResponse {
  return {
    action: accepted ? "accept" : "decline",
    content: null,
    _meta: null,
  };
}

export type ContextUsagePresentation = {
  label: string;
  percent: number | null;
  detail: string;
};

export function contextUsagePresentation(
  usage: ThreadTokenUsage | undefined,
): ContextUsagePresentation {
  if (!usage) {
    return { label: "等待数据", percent: null, detail: "尚未收到 token usage" };
  }
  const used = usage.last.totalTokens;
  const window = usage.modelContextWindow;
  if (!window || window <= 0) {
    return {
      label: formatTokenCount(used),
      percent: null,
      detail: `累计 ${formatTokenCount(usage.total.totalTokens)}`,
    };
  }
  const percent = Math.max(0, Math.min(100, (used / window) * 100));
  return {
    label: `${formatTokenCount(used)} / ${formatTokenCount(window)}`,
    percent,
    detail: `${percent.toFixed(1)}% · 累计 ${formatTokenCount(usage.total.totalTokens)}`,
  };
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000)
    return `${stripTrailingZero((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000)
    return `${stripTrailingZero((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function stripTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
