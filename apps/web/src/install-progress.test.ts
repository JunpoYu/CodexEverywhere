import { describe, expect, it } from "vitest";

import {
  CODEX_INSTALL_STEP_COUNT,
  codexInstallProgressPresentation,
} from "./install-progress.js";

describe("Codex install progress", () => {
  it("maps versioned host phases to stable user-facing steps", () => {
    expect(
      codexInstallProgressPresentation({
        version: 1,
        operationId: "install-1",
        phase: "installing",
      }),
    ).toMatchObject({
      operationId: "install-1",
      phase: "installing",
      step: 2,
      label: "正在下载并安装 Codex",
    });
    expect(CODEX_INSTALL_STEP_COUNT).toBe(4);
  });

  it("ignores unknown versions and phases", () => {
    expect(
      codexInstallProgressPresentation({
        version: 2,
        operationId: "install-1",
        phase: "installing",
      }),
    ).toBeUndefined();
    expect(
      codexInstallProgressPresentation({
        version: 1,
        operationId: "install-1",
        phase: "extracting",
      }),
    ).toBeUndefined();
  });
});
