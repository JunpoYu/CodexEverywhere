export type TuiLaunchOptions = {
  socketPath: string;
  workspacePath: string;
  thread?: string;
  newThread?: boolean;
};

export function tuiExitGuidance(): string {
  return [
    "安全离开 TUI：输入 /quit 或 /exit 只会关闭这个 TUI 客户端，宿主机上的当前任务会继续运行。",
    "不要按 Esc；Esc 会中断当前任务。",
  ].join("\n");
}

export function tuiArguments(options: TuiLaunchOptions): string[] {
  const thread = options.thread?.trim();
  if (options.newThread && thread) {
    throw new Error("--new and --thread cannot be used together");
  }

  const connection = [
    "--remote",
    `unix://${options.socketPath}`,
    "-C",
    options.workspacePath,
  ];
  if (options.newThread) return connection;
  return [
    "resume",
    "--include-non-interactive",
    ...connection,
    ...(thread ? [thread] : []),
  ];
}
