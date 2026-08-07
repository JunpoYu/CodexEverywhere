import { describe, expect, it } from "vitest";

import {
  codexVersionFromCliOutput,
  codexVersionPresentation,
} from "./codex-version.js";

describe("Codex version presentation", () => {
  it("shows installed and latest versions with an update action", () => {
    expect(
      codexVersionPresentation({
        version: 1,
        installed: true,
        installedVersion: "0.151.0",
        binary: "/home/alice/.local/bin/codex",
        latestVersion: "0.152.0",
        relation: "older",
      }),
    ).toEqual({
      installedLabel: "v0.151.0",
      latestLabel: "v0.152.0",
      binaryLabel: "/home/alice/.local/bin/codex",
      state: "发现可用更新。安装完成后可自行决定何时重启服务。",
      actionLabel: "更新到 v0.152.0",
      actionHidden: false,
    });
  });

  it("hides the update action when the current version is latest", () => {
    const result = codexVersionPresentation({
      version: 1,
      installed: true,
      installedVersion: "0.152.0",
      binary: "codex",
      latestVersion: "0.152.0",
      relation: "current",
    });

    expect(result.state).toContain("已经是 npm 最新稳定版");
    expect(result.actionHidden).toBe(true);
  });

  it("keeps the installed version visible when latest lookup fails", () => {
    const result = codexVersionPresentation({
      version: 1,
      installed: true,
      installedVersion: "0.151.0",
      binary: "codex",
      relation: "unknown",
    });

    expect(result.installedLabel).toBe("v0.151.0");
    expect(result.latestLabel).toBe("暂时无法获取");
    expect(result.actionHidden).toBe(false);
  });

  it("extracts a semantic version from codex --version output", () => {
    expect(codexVersionFromCliOutput("codex-cli 0.152.0\n")).toBe("0.152.0");
  });
});
