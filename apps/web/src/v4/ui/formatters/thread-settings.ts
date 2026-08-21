export function sandboxSettingLabel(value: string | undefined): string {
  if (value === "read-only") return "只读";
  if (value === "workspace-write") return "工作区可写";
  if (value === "danger-full-access") return "完全访问";
  return "Codex 当前值";
}

export function approvalSettingLabel(value: string | undefined): string {
  if (value === "untrusted") return "严格审批";
  if (value === "on-request") return "按需询问";
  if (value === "never") return "从不询问";
  return "Codex 当前值";
}

export function reasoningEffortLabel(value: string | undefined): string {
  const labels: Readonly<Record<string, string>> = {
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "很高",
    max: "最大",
    ultra: "Ultra",
  };
  return value === undefined ? "Codex 当前值" : (labels[value] ?? value);
}
