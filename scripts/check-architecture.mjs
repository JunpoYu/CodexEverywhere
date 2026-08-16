import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const architectureRoots = [
  "packages/kernel/src",
  "packages/protocol/src/v2",
  "apps/agent/src/v2",
  "apps/web/src/v4",
];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const files = architectureRoots.flatMap((root) => collectSourceFiles(root));
const fileSet = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
const failures = [];

for (const file of files) {
  const content = readFileSync(join(repositoryRoot, file), "utf8");
  const imports = parseImports(content);
  for (const specifier of imports) {
    if (specifier.startsWith(".")) {
      const target = resolveRelativeImport(file, specifier);
      if (target !== undefined && fileSet.has(target)) {
        graph.get(file)?.push(target);
      }
    }
  }

  if (file.startsWith("packages/kernel/src/")) {
    for (const specifier of imports) {
      if (specifier.startsWith("@codex-everywhere/")) {
        failures.push(`${file}: kernel must not depend on ${specifier}`);
      }
    }
  }

  if (file.startsWith("apps/web/src/v4/")) {
    for (const specifier of imports) {
      if (/\/(?:main|legacy)(?:\.[cm]?[jt]sx?)?$/u.test(specifier)) {
        failures.push(`${file}: v0.4 Web must not import the legacy monolith`);
      }
      if (specifier.includes("apps/agent") || specifier.includes("sql.js")) {
        failures.push(`${file}: Web crossed the Agent or repository boundary`);
      }
    }
  }

  if (
    file.startsWith("apps/agent/src/v2/") &&
    !file.includes("/repositories/") &&
    imports.some((specifier) => specifier === "sql.js")
  ) {
    failures.push(`${file}: SQL is only allowed inside v0.4 repositories`);
  }

  if (
    (file.startsWith("apps/agent/src/v2/") ||
      file.startsWith("apps/web/src/v4/")) &&
    !file.includes("/gateway/") &&
    /\b(?:RequestEnvelope|requestEnvelope)\b/u.test(content)
  ) {
    failures.push(`${file}: raw Gateway envelopes are restricted to adapters`);
  }
}

for (const cycle of findCycles(graph)) {
  failures.push(`dependency cycle: ${cycle.join(" -> ")}`);
}

if (failures.length > 0) {
  console.error("Architecture check failed:\n");
  for (const failure of [...new Set(failures)].sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Architecture check passed (${files.length} v0.4 source files).`);

function collectSourceFiles(root) {
  const absoluteRoot = join(repositoryRoot, root);
  try {
    if (!statSync(absoluteRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        entry.isFile() &&
        sourceExtensions.has(extname(entry.name)) &&
        !entry.name.includes(".test.")
      ) {
        result.push(relative(repositoryRoot, absolute));
      }
    }
  };
  visit(absoluteRoot);
  return result.sort();
}

function parseImports(content) {
  const imports = [];
  const pattern =
    /(?:\bimport\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?|\bexport\s+(?:type\s+)?[^"']*?\s+from\s+|\bimport\s*\()["']([^"']+)["']/gu;
  for (const match of content.matchAll(pattern)) {
    if (match[1] !== undefined) imports.push(match[1]);
  }
  return imports;
}

function resolveRelativeImport(fromFile, specifier) {
  const withoutQuery = specifier.split("?", 1)[0];
  if (withoutQuery === undefined) return undefined;
  const imported = normalize(join(dirname(fromFile), withoutQuery));
  const candidates = [];
  if (sourceExtensions.has(extname(imported))) {
    candidates.push(imported);
  } else if (/\.js$/u.test(imported)) {
    candidates.push(imported.replace(/\.js$/u, ".ts"));
    candidates.push(imported.replace(/\.js$/u, ".tsx"));
  } else {
    for (const extension of sourceExtensions)
      candidates.push(imported + extension);
    for (const extension of sourceExtensions) {
      candidates.push(join(imported, `index${extension}`));
    }
  }
  return candidates.find((candidate) => fileSet.has(candidate));
}

function findCycles(dependencyGraph) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];

  const visit = (file) => {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dependency of dependencyGraph.get(file) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of dependencyGraph.keys()) visit(file);
  return cycles;
}
