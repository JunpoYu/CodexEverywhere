import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runner = resolve(
  import.meta.dirname,
  "../../../scripts/run-v0.4-candidate-checks.mjs",
);

describe("v0.4 candidate check runner", () => {
  it("publishes the complete deterministic gate plan without executing it", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      runner,
      "--",
      "--plan",
    ]);

    expect(JSON.parse(stdout)).toEqual({
      version: 1,
      kind: "codex-everywhere-v0.4-candidate-plan",
      withModel: false,
      steps: [
        "public-repository-hygiene",
        "format",
        "architecture",
        "test-runtime-capabilities",
        "typecheck",
        "unit-and-protocol",
        "build",
        "web-bundle-budget",
        "playwright",
        "app-server-contract",
        "deployment-shell-syntax",
        "working-tree-whitespace",
        "staged-whitespace",
      ],
    });
  });

  it("marks model integration as required when requested", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      runner,
      "--plan",
      "--with-model",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({ withModel: true });
  });
});
