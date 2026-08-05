import type { CodexVersionStatus } from "@codex-everywhere/protocol";

export type CodexVersionPresentation = {
  installedLabel: string;
  latestLabel: string;
  binaryLabel: string;
  state: string;
  actionLabel: string;
  actionHidden: boolean;
};

export function codexVersionPresentation(
  status: CodexVersionStatus,
): CodexVersionPresentation {
  const installedLabel = status.installed
    ? (versionLabel(status.installedVersion) ?? "版本未知")
    : "未安装";
  const latestLabel = versionLabel(status.latestVersion) ?? "暂时无法获取";
  const binaryLabel = status.binary ?? "未检测到可运行文件";

  if (!status.installed) {
    return {
      installedLabel,
      latestLabel,
      binaryLabel,
      state: status.latestVersion
        ? "当前尚未安装，可以安装最新稳定版本。"
        : "当前尚未安装；暂时无法从 npm 获取最新稳定版本。",
      actionLabel: status.latestVersion
        ? `安装 ${versionLabel(status.latestVersion)}`
        : "安装最新版",
      actionHidden: false,
    };
  }

  switch (status.relation) {
    case "older":
      return {
        installedLabel,
        latestLabel,
        binaryLabel,
        state: "发现可用更新。安装完成后可自行决定何时重启服务。",
        actionLabel: `更新到 ${versionLabel(status.latestVersion) ?? "最新版"}`,
        actionHidden: false,
      };
    case "current":
      return {
        installedLabel,
        latestLabel,
        binaryLabel,
        state: "当前安装版本已经是 npm 最新稳定版。",
        actionLabel: "已是最新版本",
        actionHidden: true,
      };
    case "newer":
      return {
        installedLabel,
        latestLabel,
        binaryLabel,
        state: "当前安装版本高于 npm 最新稳定版，不会自动降级。",
        actionLabel: "无需更新",
        actionHidden: true,
      };
    case "unknown":
      return {
        installedLabel,
        latestLabel,
        binaryLabel,
        state: status.latestVersion
          ? "已获取最新稳定版，但无法可靠比较当前安装版本。"
          : "当前版本可用，但暂时无法从 npm 获取最新稳定版本。",
        actionLabel: status.latestVersion
          ? `安装 ${versionLabel(status.latestVersion) ?? "最新版"}`
          : "安装或更新到最新版",
        actionHidden: false,
      };
  }
}

export function codexVersionFromCliOutput(
  output: string | undefined,
): string | undefined {
  return output?.match(
    /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/u,
  )?.[1];
}

function versionLabel(version: string | undefined): string | undefined {
  return version ? `v${version}` : undefined;
}
