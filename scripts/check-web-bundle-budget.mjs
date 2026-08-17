#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

const DEFAULT_JS_BUDGET_KIB = 250;
const DEFAULT_CSS_BUDGET_KIB = 40;
const MARKDOWN_SOURCE = "src/v4/ui/timeline/MarkdownContent.tsx";
const CODE_RENDERER_SOURCE = "src/code-renderer.ts";

const options = parseArguments(
  process.argv.slice(2).filter((argument) => argument !== "--"),
);

try {
  const result = await inspectBundle(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "Web bundle budget passed.",
        `Initial JS: ${formatKib(result.initialJsGzipBytes)} / ${result.jsBudgetKib.toFixed(2)} KiB gzip`,
        `Initial CSS: ${formatKib(result.initialCssGzipBytes)} / ${result.cssBudgetKib.toFixed(2)} KiB gzip`,
        "Markdown, KaTeX, and code highlighting remain behind the task-page lazy boundary.",
      ].join("\n") + "\n",
    );
  }
} catch (error) {
  process.stderr.write(
    `Web bundle budget failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}

async function inspectBundle({ dist, jsBudgetKib, cssBudgetKib }) {
  const realDist = await realpath(dist);
  const manifestPath = await realpath(resolve(realDist, "asset-manifest.json"));
  assertWithinDist(realDist, manifestPath);
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const entryKeys = Object.entries(manifest)
    .filter(([, item]) => item.isEntry === true)
    .map(([key]) => key);
  if (entryKeys.length !== 1) {
    throw new Error(
      `expected exactly one Web entry in ${manifestPath}, found ${entryKeys.length}`,
    );
  }

  const entryKey = entryKeys[0];
  const entry = manifest[entryKey];
  const bootstrapKeys = (entry.dynamicImports ?? []).filter(
    (key) => manifest[key]?.name === "bootstrap",
  );
  if (bootstrapKeys.length !== 1) {
    throw new Error(
      `expected the Web entry to load exactly one bootstrap chunk, found ${bootstrapKeys.length}`,
    );
  }

  const initialKeys = collectStaticImports(manifest, [
    entryKey,
    bootstrapKeys[0],
  ]);
  const markdownKey = findSourceKey(manifest, MARKDOWN_SOURCE);
  const codeRendererKey = findSourceKey(manifest, CODE_RENDERER_SOURCE);
  if (initialKeys.has(markdownKey) || initialKeys.has(codeRendererKey)) {
    throw new Error(
      "Markdown or code highlighting entered the initial route instead of remaining lazy",
    );
  }
  if (
    !(manifest[bootstrapKeys[0]].dynamicImports ?? []).includes(markdownKey)
  ) {
    throw new Error("Markdown is no longer a direct task-page lazy import");
  }
  if (!(manifest[markdownKey].dynamicImports ?? []).includes(codeRendererKey)) {
    throw new Error("code highlighting is no longer lazy behind Markdown");
  }

  const jsFiles = new Set();
  const cssFiles = new Set();
  for (const key of initialKeys) {
    const item = manifest[key];
    if (item.file.endsWith(".js")) jsFiles.add(item.file);
    for (const cssFile of item.css ?? []) cssFiles.add(cssFile);
  }

  const initialJsGzipBytes = await sumGzipBytes(realDist, jsFiles);
  const initialCssGzipBytes = await sumGzipBytes(realDist, cssFiles);
  assertWithinBudget("Initial user-route JS", initialJsGzipBytes, jsBudgetKib);
  assertWithinBudget(
    "Initial user-route CSS",
    initialCssGzipBytes,
    cssBudgetKib,
  );

  return {
    version: 1,
    initialJsGzipBytes,
    initialCssGzipBytes,
    jsBudgetKib,
    cssBudgetKib,
    initialJsFiles: [...jsFiles].sort(),
    initialCssFiles: [...cssFiles].sort(),
  };
}

function parseArguments(arguments_) {
  let dist = "apps/web/dist";
  let jsBudgetKib = DEFAULT_JS_BUDGET_KIB;
  let cssBudgetKib = DEFAULT_CSS_BUDGET_KIB;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dist") {
      dist = requireValue(arguments_, ++index, argument);
    } else if (argument === "--js-kib") {
      jsBudgetKib = parseBudget(requireValue(arguments_, ++index, argument));
    } else if (argument === "--css-kib") {
      cssBudgetKib = parseBudget(requireValue(arguments_, ++index, argument));
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { dist: resolve(dist), jsBudgetKib, cssBudgetKib, json };
}

function requireValue(arguments_, index, flag) {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseBudget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid bundle budget: ${value}`);
  }
  return parsed;
}

function parseManifest(serialized) {
  const value = JSON.parse(serialized);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("asset manifest must be an object");
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.file !== "string"
    ) {
      throw new Error(`invalid asset manifest entry: ${key}`);
    }
  }
  return value;
}

function collectStaticImports(manifest, roots) {
  const pending = [...roots];
  const collected = new Set();
  while (pending.length > 0) {
    const key = pending.pop();
    if (collected.has(key)) continue;
    const item = manifest[key];
    if (item === undefined)
      throw new Error(`manifest import is missing: ${key}`);
    collected.add(key);
    for (const imported of item.imports ?? []) pending.push(imported);
  }
  return collected;
}

function findSourceKey(manifest, source) {
  const matches = Object.entries(manifest)
    .filter(([key, item]) => key === source || item.src === source)
    .map(([key]) => key);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one manifest entry for ${source}`);
  }
  return matches[0];
}

async function sumGzipBytes(dist, files) {
  let total = 0;
  for (const file of files) {
    const declaredPath = resolve(dist, file);
    assertWithinDist(dist, declaredPath);
    const actualPath = await realpath(declaredPath);
    assertWithinDist(dist, actualPath);
    const bytes = await readFile(actualPath);
    total += gzipSync(bytes).byteLength;
  }
  return total;
}

function assertWithinDist(dist, path) {
  if (path === dist || !path.startsWith(`${dist}${sep}`)) {
    throw new Error("asset manifest path escapes the Web dist directory");
  }
}

function assertWithinBudget(label, bytes, budgetKib) {
  const budgetBytes = budgetKib * 1024;
  if (bytes > budgetBytes) {
    throw new Error(
      `${label} is ${formatKib(bytes)}, exceeding ${budgetKib.toFixed(2)} KiB gzip`,
    );
  }
}

function formatKib(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB gzip`;
}
