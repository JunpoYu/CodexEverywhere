export type SlashCommandSupport = "web" | "tui" | "platform";

export type SlashCommand = {
  name: string;
  description: string;
  supportsInlineArgs: boolean;
  availableDuringTask: boolean;
  support: SlashCommandSupport;
  aliases?: readonly string[];
  usage?: string;
};

const command = (
  name: string,
  description: string,
  options: Partial<Omit<SlashCommand, "name" | "description">> = {},
): SlashCommand => ({
  name,
  description,
  supportsInlineArgs: false,
  availableDuringTask: true,
  support: "tui",
  ...options,
});

/**
 * Codex 0.144.1 built-ins in the same presentation order as the official TUI.
 * Platform-specific commands stay in the registry so pasted commands always
 * receive an explicit response instead of accidentally becoming model input.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  command("model", "选择模型和推理强度", { support: "web" }),
  command("ide", "加入 IDE 当前选择、打开文件等上下文", {
    supportsInlineArgs: true,
  }),
  command("permissions", "选择 Codex 的沙箱和审批权限", { support: "web" }),
  command("keymap", "配置 TUI 快捷键", { supportsInlineArgs: true }),
  command("vim", "切换 TUI Vim 输入模式"),
  command("setup-default-sandbox", "配置 Windows 提权沙箱", {
    availableDuringTask: false,
    support: "platform",
  }),
  command("sandbox-add-read-dir", "为 Windows 沙箱添加只读目录", {
    availableDuringTask: false,
    support: "platform",
    supportsInlineArgs: true,
    usage: "/sandbox-add-read-dir <absolute_path>",
  }),
  command("experimental", "管理实验性功能", { availableDuringTask: false }),
  command("approve", "批准一次最近被自动审查拒绝的重试"),
  command("memories", "配置记忆的使用和生成", { availableDuringTask: false }),
  command("skills", "查看当前工作目录可用的 Skills", { support: "web" }),
  command("import", "从 Claude Code 导入设置、项目和最近会话", {
    availableDuringTask: false,
  }),
  command("hooks", "查看和管理生命周期 Hooks"),
  command("review", "审查当前修改并查找问题", {
    availableDuringTask: false,
    support: "web",
    supportsInlineArgs: true,
    usage: "/review [自定义审查说明]",
  }),
  command("rename", "重命名当前会话", {
    support: "web",
    supportsInlineArgs: true,
    usage: "/rename [新名称]",
  }),
  command("new", "新建会话", { availableDuringTask: false, support: "web" }),
  command("archive", "归档当前会话", {
    availableDuringTask: false,
    support: "web",
  }),
  command("delete", "永久删除当前会话", {
    availableDuringTask: false,
    support: "web",
  }),
  command("resume", "恢复已保存的会话", {
    support: "web",
    supportsInlineArgs: true,
    usage: "/resume [会话 ID 或名称]",
  }),
  command("fork", "从当前会话创建分支", {
    availableDuringTask: false,
    support: "web",
  }),
  command("app", "在 Codex Desktop 中继续当前会话", {
    support: "platform",
  }),
  command("init", "生成仓库级 AGENTS.md 指南", {
    availableDuringTask: false,
    support: "web",
  }),
  command("compact", "压缩上下文以避免达到限制", {
    availableDuringTask: false,
    support: "web",
  }),
  command("plan", "切换到 Plan 模式", {
    availableDuringTask: false,
    supportsInlineArgs: true,
    usage: "/plan [任务说明]",
  }),
  command("goal", "设置或查看长任务目标", {
    support: "web",
    supportsInlineArgs: true,
    usage: "/goal [目标|edit|pause|resume|clear]",
  }),
  command("agent", "切换当前 Agent 会话"),
  command("side", "在临时分支中开始支线对话", {
    supportsInlineArgs: true,
  }),
  command("btw", "在临时分支中开始支线对话", {
    supportsInlineArgs: true,
  }),
  command("copy", "复制最近一条完整回复的 Markdown", { support: "web" }),
  command("raw", "切换 TUI 原始回滚模式", {
    supportsInlineArgs: true,
    usage: "/raw [on|off]",
  }),
  command("diff", "显示 Git diff（包括未跟踪文件）"),
  command("mention", "提及文件"),
  command("status", "显示当前会话配置和上下文用量", { support: "web" }),
  command("usage", "查看 Codex 账号用量", {
    support: "web",
    supportsInlineArgs: true,
    usage: "/usage [daily|weekly|cumulative]",
  }),
  command("debug-config", "显示配置层和要求来源"),
  command("title", "配置 TUI 终端标题"),
  command("statusline", "配置 TUI 状态栏"),
  command("theme", "选择界面主题", {
    availableDuringTask: false,
    support: "web",
  }),
  command("pets", "选择或隐藏 TUI 宠物", {
    aliases: ["pet"],
    availableDuringTask: false,
    supportsInlineArgs: true,
  }),
  command("mcp", "列出已配置的 MCP 服务", {
    support: "web",
    supportsInlineArgs: true,
    usage: "/mcp [verbose]",
  }),
  command("apps", "管理 Apps"),
  command("plugins", "浏览 Plugins"),
  command("logout", "退出当前 Codex 账号", {
    availableDuringTask: false,
    support: "web",
  }),
  command("quit", "退出 Codex TUI", { support: "web" }),
  command("exit", "退出 Codex TUI", { support: "web" }),
  command("feedback", "向 Codex 维护者发送日志"),
  command("ps", "列出 TUI 后台终端"),
  command("stop", "停止所有 TUI 后台终端", { aliases: ["clean"] }),
  command("clear", "清空界面并开始新会话", {
    availableDuringTask: false,
    support: "web",
  }),
  command("personality", "选择 Codex 沟通风格"),
  command("subagents", "切换当前 Agent 会话"),
];

export type ParsedSlashCommand = {
  command: SlashCommand;
  invokedName: string;
  args: string;
};

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (!input.startsWith("/") || input.includes("\n")) return null;
  const match = /^\/([^\s/]*)\s*(.*)$/u.exec(input);
  if (!match || !match[1]) return null;
  const invokedName = match[1].toLocaleLowerCase();
  const found = SLASH_COMMANDS.find(
    (item) =>
      item.name === invokedName || item.aliases?.includes(invokedName) === true,
  );
  if (!found) return null;
  return { command: found, invokedName, args: match[2]?.trim() ?? "" };
}

export function slashCommandQuery(input: string): string | null {
  if (!input.startsWith("/") || input.includes("\n")) return null;
  const token = input.slice(1);
  if (/\s/u.test(token)) return null;
  return token.toLocaleLowerCase();
}

export function slashCommandSuggestions(input: string): SlashCommand[] {
  const query = slashCommandQuery(input);
  if (query === null) return [];
  const prefix: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const item of SLASH_COMMANDS) {
    const names = [item.name, ...(item.aliases ?? [])];
    if (names.some((name) => name.startsWith(query))) prefix.push(item);
    else if (query && names.some((name) => name.includes(query)))
      contains.push(item);
  }
  return [...prefix, ...contains];
}

export function slashCommandCompletion(command: SlashCommand): string {
  return `/${command.name}${command.supportsInlineArgs ? " " : ""}`;
}
