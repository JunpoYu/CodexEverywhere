import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import {
  markdownToHtml,
  parseUnifiedDiff,
  unifiedDiffStats,
} from "./code-renderer.js";

const rendererStyles = readFileSync(
  new URL("./style.css", import.meta.url),
  "utf8",
);

function packageVersion(packageJsonPath: string): string {
  const manifest: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(`Package manifest has no version: ${packageJsonPath}`);
  }
  return manifest.version;
}

describe("message Markdown rendering", () => {
  it("uses matching KaTeX versions for rendering and styles", () => {
    const webRequire = createRequire(import.meta.url);
    const pluginRequire = createRequire(
      webRequire.resolve("@mdit/plugin-katex"),
    );
    const stylesheetVersion = packageVersion(
      webRequire.resolve("katex/package.json"),
    );
    const rendererVersion = packageVersion(
      pluginRequire.resolve("katex/package.json"),
    );

    expect(stylesheetVersion).toBe(rendererVersion);
  });

  it("renders headings, emphasis, lists, quotes, tables, and code", () => {
    const html = markdownToHtml(
      [
        "## 结果",
        "",
        "**完成**并保留`itemId`。",
        "",
        "- 第一项",
        "- 第二项",
        "",
        "> 注意事项",
        "",
        "| 文件 | 状态 |",
        "| --- | --- |",
        "| app.ts | 已修改 |",
        "",
        "```ts",
        "const value = 1;",
        "```",
      ].join("\n"),
    );
    expect(html).toContain("<h2>结果</h2>");
    expect(html).toContain("<strong>完成</strong>");
    expect(html).toContain("<code>itemId</code>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
    expect(html).toContain('<code class="language-ts">');
  });

  it("keeps an unfinished streaming fence visible as code", () => {
    expect(markdownToHtml("```python\nprint('working')\n")).toContain(
      "<code class=\"language-python\">print('working')\n</code>",
    );
  });

  it("renders inline and display LaTeX without interpreting code as math", () => {
    const html = markdownToHtml(
      [
        "Euler 恒等式 $e^{i\\pi}+1=0$。",
        "",
        "$$",
        "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
        "$$",
        "",
        "`$not_math$`",
      ].join("\n"),
    );
    expect(html.match(/class="katex"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("katex-display");
    expect(html).toContain("<code>$not_math$</code>");
  });

  it("supports bracket-style LaTeX delimiters", () => {
    const html = markdownToHtml(
      "行内 \\(a^2+b^2=c^2\\) 与块级：\n\n\\[\\sum_{i=1}^n i\\]",
    );
    expect(html.match(/class="katex"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("katex-display");
  });

  it("escapes raw HTML and rejects unsafe Markdown links", () => {
    const html = markdownToHtml(
      "<script>globalThis.pwned = true</script>\n\n[x](javascript:alert(1))",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
  });
});

describe("message code styling", () => {
  it("does not inherit the light inline-code background in fenced blocks", () => {
    expect(rendererStyles).toMatch(
      /\.message-code-block pre code\s*\{[^}]*background:\s*transparent;/su,
    );
  });
});

describe("unified diff rendering", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -2,3 +2,4 @@",
    " const before = true;",
    "-const oldValue = 1;",
    "+const newValue = 2;",
    "+const extra = 3;",
    " return before;",
  ].join("\n");

  it("distinguishes metadata, hunks, additions, deletions, and context", () => {
    const lines = parseUnifiedDiff(diff);
    expect(lines.map((line) => line.type)).toEqual([
      "header",
      "header",
      "header",
      "hunk",
      "context",
      "deletion",
      "addition",
      "addition",
      "context",
    ]);
    expect(lines[4]).toMatchObject({ oldLine: 2, newLine: 2 });
    expect(lines[5]).toMatchObject({ oldLine: 3 });
    expect(lines[5]).not.toHaveProperty("newLine");
    expect(lines[6]).toMatchObject({ newLine: 3 });
    expect(lines[6]).not.toHaveProperty("oldLine");
    expect(lines[8]).toMatchObject({ oldLine: 4, newLine: 5 });
  });

  it("does not count +++ and --- file headers as changed lines", () => {
    expect(unifiedDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});
