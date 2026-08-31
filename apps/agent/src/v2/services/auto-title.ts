import type { JsonValue } from "@codex-everywhere/protocol/v2";

const MAX_TITLE_WIDTH = 56;
const GENERIC_REQUESTS = new Set([
  "好",
  "好的",
  "可以",
  "开始",
  "继续",
  "继续处理",
  "继续推进",
  "处理",
  "处理一下",
  "修复",
  "修复一下",
  "优化",
  "优化一下",
  "实现",
  "实现一下",
  "检查",
  "检查一下",
  "看看",
  "看一下",
  "提交",
  "提交推送",
  "发布",
  "部署",
  "部署一下",
  "continue",
  "continueworking",
  "doit",
  "fixit",
  "goahead",
  "proceed",
]);

export function hasExplicitThreadName(thread: JsonValue): boolean {
  if (!isRecord(thread)) return false;
  return typeof thread.name === "string" && thread.name.trim().length > 0;
}

export function deriveAutomaticTitle(prompt: string): string | undefined {
  let candidate = prompt
    .normalize("NFKC")
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/```[\s\S]*$/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/https?:\/\/\S+/giu, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s{0,3}(?:[-*+>]|\d+[.)])\s+/gmu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (candidate.length === 0) return undefined;

  candidate = candidate
    .replace(/^(?:请求|任务|需求|问题|task|request)\s+/iu, "")
    .trim();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const withoutCourtesy = candidate
      .replace(
        /^(?:请|麻烦(?:你)?|帮我|我(?:想|希望|需要)(?:你)?|能否|是否可以|可以(?:帮我)?|please\b|could you\b|can you\b|would you\b)\s*/iu,
        "",
      )
      .trim();
    if (withoutCourtesy === candidate) break;
    candidate = withoutCourtesy;
  }

  candidate = (candidate.split(/[，,。！？!?；;\r\n]/u)[0] ?? "")
    .replace(/^(修复|优化|检查|实现|处理)一下/u, "$1")
    .replace(/[\s:：,，;；\-—]+$/gu, "")
    .trim();
  if (candidate.length > 4) candidate = candidate.replace(/[吗么呢]$/u, "");
  if (!/[\p{L}\p{N}]/u.test(candidate)) return undefined;

  const genericKey = candidate
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  if (GENERIC_REQUESTS.has(genericKey)) return undefined;
  return truncateTitle(candidate, MAX_TITLE_WIDTH);
}

function truncateTitle(value: string, maximumWidth: number): string {
  if (displayWidth(value) <= maximumWidth) return value;
  const result: string[] = [];
  let width = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth + 2 > maximumWidth) break;
    result.push(character);
    width += characterWidth;
  }
  return `${result.join("").trimEnd()}…`;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += /^[\u0000-\u00ff]$/u.test(character) ? 1 : 2;
  }
  return width;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
