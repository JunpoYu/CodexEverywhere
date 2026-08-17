import { katex } from "@mdit/plugin-katex";
import DOMPurify, { type Config } from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import MarkdownIt from "markdown-it";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
}).use(katex, {
  delimiters: "all",
  mathFence: true,
  output: "htmlAndMathml",
  throwOnError: false,
  trust: false,
  strict: "ignore",
});

markdown.renderer.rules.image = (tokens, index) => {
  const alt = markdown.utils.escapeHtml(tokens[index]?.content || "图片");
  return `<span class="markdown-image-placeholder">🖼 ${alt}</span>`;
};

// KaTeX uses a small inline SVG to draw stretchy radicals. Raw Markdown HTML
// remains disabled and KaTeX trust remains false, so keep this exception
// limited to the tags and attributes emitted by KaTeX's radical renderer.
export const messageSanitizerConfig = {
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: { html: true, mathMl: true },
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "d"],
} satisfies Config;

export type UnifiedDiffLine = {
  type: "header" | "meta" | "hunk" | "addition" | "deletion" | "context";
  marker: string;
  content: string;
  oldLine?: number;
  newLine?: number;
};

export type UnifiedDiffStats = {
  additions: number;
  deletions: number;
};

export function markdownToHtml(text: string): string {
  return markdown.render(text);
}

export function parseUnifiedDiff(diff: string): UnifiedDiffLine[] {
  const normalized = diff.replace(/\r\n?/gu, "\n");
  const sourceLines = normalized.split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();

  const result: UnifiedDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const line of sourceLines) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      result.push({ type: "hunk", marker: "", content: line });
      continue;
    }

    if (oldLine === undefined || newLine === undefined) {
      result.push({
        type: /^(?:diff --git|---\s|\+\+\+\s)/u.test(line) ? "header" : "meta",
        marker: "",
        content: line,
      });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({
        type: "addition",
        marker: "+",
        content: line.slice(1),
        newLine,
      });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      result.push({
        type: "deletion",
        marker: "−",
        content: line.slice(1),
        oldLine,
      });
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      result.push({
        type: "context",
        marker: " ",
        content: line.slice(1),
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    result.push({ type: "meta", marker: "", content: line });
  }

  return result;
}

export function unifiedDiffStats(diff: string): UnifiedDiffStats {
  return parseUnifiedDiff(diff).reduce<UnifiedDiffStats>(
    (stats, line) => {
      if (line.type === "addition") stats.additions += 1;
      if (line.type === "deletion") stats.deletions += 1;
      return stats;
    },
    { additions: 0, deletions: 0 },
  );
}

export function renderMessageContent(
  container: HTMLElement,
  text: string,
): void {
  const fragment = DOMPurify.sanitize(
    markdownToHtml(text),
    messageSanitizerConfig,
  );
  container.replaceChildren(fragment);
  container.classList.add("rich-message");
  for (const display of Array.from(
    container.querySelectorAll<HTMLElement>(".katex-display"),
  )) {
    const wrapper = document.createElement("div");
    wrapper.className = "math-display-wrap";
    display.replaceWith(wrapper);
    wrapper.append(display);
  }
  for (const pre of Array.from(container.querySelectorAll("pre"))) {
    const code = pre.querySelector(":scope > code");
    if (!code) continue;
    const source = code.textContent ?? "";
    const language = normalizeLanguage(
      Array.from(code.classList)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length),
    );
    code.innerHTML = highlightCode(source, language);
    code.classList.add("hljs");
    const block = document.createElement("div");
    block.className = "message-code-block";
    const toolbar = document.createElement("div");
    toolbar.className = "message-code-toolbar";
    const label = document.createElement("span");
    label.textContent = language ?? "代码";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-code-copy";
    copy.textContent = "复制";
    copy.addEventListener("click", () => void copyCode(copy, source));
    toolbar.append(label, copy);
    pre.replaceWith(block);
    block.append(toolbar, pre);
  }
  for (const code of container.querySelectorAll("code")) {
    if (!code.closest("pre") && !code.closest(".katex"))
      code.classList.add("inline-code");
  }
  for (const table of Array.from(container.querySelectorAll("table"))) {
    if (table.closest(".katex")) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-wrap";
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  for (const anchor of Array.from(container.querySelectorAll("a"))) {
    prepareMarkdownLink(anchor);
  }
}

/** Returns escaped Highlight.js markup using only the task-page lazy chunk. */
export function highlightCode(source: string, language?: string): string {
  if (language !== undefined && hljs.getLanguage(language) !== undefined) {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  }
  return hljs.highlightAuto(source).value;
}

export function renderUnifiedDiff(diff: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "diff-view";
  pre.setAttribute("aria-label", "文件差异");
  const code = document.createElement("code");
  for (const line of parseUnifiedDiff(diff)) {
    const row = document.createElement("span");
    row.className = `diff-line diff-${line.type}`;
    const oldNumber = document.createElement("span");
    oldNumber.className = "diff-line-number";
    oldNumber.textContent =
      line.oldLine === undefined ? "" : String(line.oldLine);
    const newNumber = document.createElement("span");
    newNumber.className = "diff-line-number";
    newNumber.textContent =
      line.newLine === undefined ? "" : String(line.newLine);
    const marker = document.createElement("span");
    marker.className = "diff-marker";
    marker.textContent = line.marker;
    const content = document.createElement("span");
    content.className = "diff-content";
    content.textContent = line.content || " ";
    row.append(oldNumber, newNumber, marker, content);
    code.append(row);
  }
  pre.append(code);
  return pre;
}

function prepareMarkdownLink(anchor: HTMLAnchorElement): void {
  const href = anchor.getAttribute("href") ?? "";
  if (/^(?:https?:|mailto:|\/\/)/iu.test(href)) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    return;
  }
  if (href.startsWith("#")) return;
  const reference = document.createElement("code");
  reference.className = "file-reference";
  reference.textContent = anchor.textContent || href;
  reference.title = href;
  anchor.replaceWith(reference);
}

async function copyCode(
  button: HTMLButtonElement,
  code: string,
): Promise<void> {
  const original = button.textContent ?? "复制";
  try {
    await navigator.clipboard.writeText(code);
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  window.setTimeout(() => {
    button.textContent = original;
  }, 1_500);
}

function normalizeLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[^0-9a-z+#._-]/gu, "");
  return normalized || undefined;
}
