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
const architectureEntrypoints = [
  "apps/agent/src/admin/self-provision.ts",
  "apps/agent/src/cli.ts",
  "apps/agent/src/runtime/admin-controller-process-service.ts",
  "apps/agent/src/runtime/admin-controller-service-v2.ts",
  "apps/agent/src/runtime/agent-process-service.ts",
  "apps/agent/src/runtime/agent-service-v2.ts",
  "apps/agent/src/runtime/tui-permission-proxy.ts",
  "apps/web/src/entry.ts",
];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const files = [
  ...new Set([
    ...architectureRoots.flatMap((root) => collectSourceFiles(root)),
    ...architectureEntrypoints,
  ]),
].sort();
const uiStyleFiles = collectStyleFiles("apps/web/src/v4/ui");
const fileSet = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
const failures = [];
for (const file of files) {
  if (
    file.startsWith("apps/agent/src/v2/migration/") ||
    file === "apps/agent/src/v2/repositories/legacy-state-conversion.ts"
  ) {
    failures.push(`${file}: v0.4 must use fresh CE state, not v0.3 conversion`);
  }
}
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
      if (
        /\/(?:main|admin-main|gateway-client|legacy)(?:\.[cm]?[jt]sx?)?$/u.test(
          specifier,
        )
      ) {
        failures.push(`${file}: v0.4 Web must not import the legacy monolith`);
      }
      if (specifier.includes("apps/agent") || specifier.includes("sql.js")) {
        failures.push(`${file}: Web crossed the Agent or repository boundary`);
      }
    }
    for (const specifier of imports) {
      if (
        file.startsWith("apps/web/src/v4/ui/") &&
        specifier.startsWith(".") &&
        specifier.endsWith(".css") &&
        !specifier.endsWith(".module.css")
      ) {
        failures.push(
          `${file}: feature styles must use a colocated CSS Module`,
        );
      }
      if (
        file !== "apps/web/src/v4/bootstrap.tsx" &&
        specifier.endsWith("styles/global.css")
      ) {
        failures.push(`${file}: only the Web bootstrap may import global.css`);
      }
    }
    if (
      file !== "apps/web/src/v4/gateway/gateway-port.ts" &&
      /\bGatewayV2Client\b/u.test(content)
    ) {
      failures.push(
        `${file}: GatewayV2Client construction is restricted to GatewayPort`,
      );
    }
    if (
      (file === "apps/web/src/v4/admin-runtime.ts" ||
        file === "apps/web/src/v4/ui/pages/AdminPage.tsx") &&
      imports.some((specifier) =>
        /(?:actors\/(?:composer|onboarding|queue|task-list|thread)-actor|\.\.\/runtime\.js|pages\/(?:Queue|Settings|Setup|Task|Tasks|Workspaces)Page)/u.test(
          specifier,
        ),
      )
    ) {
      failures.push(
        `${file}: administrator Web imported a user business module`,
      );
    }
    if (
      file === "apps/web/src/v4/runtime.ts" &&
      imports.some((specifier) => specifier.includes("admin-actor"))
    ) {
      failures.push(
        `${file}: user Web runtime imported the administrator actor`,
      );
    }
  }

  if (
    file === "apps/agent/src/v2/gateway/agent-composition-root.ts" &&
    /\brouter\.register\s*\(/u.test(content)
  ) {
    failures.push(
      `${file}: composition root must delegate business handler registration`,
    );
  }

  if (
    file === "apps/agent/src/v2/services/thread-service.ts" &&
    (/#runtimeSettings|#resumedLeases|#settings\b/u.test(content) ||
      !imports.some((specifier) =>
        specifier.endsWith("/thread-session-coordinator.js"),
      ))
  ) {
    failures.push(
      `${file}: per-thread resume and permission consistency must stay in ThreadSessionCoordinator`,
    );
  }

  if (
    file === "apps/agent/src/v2/services/thread-session-coordinator.ts" &&
    (imports.some((specifier) =>
      /(?:client-factory|thread-projection|interaction-broker|gateway\/|queue-service)/u.test(
        specifier,
      ),
    ) ||
      /new Map\s*<\s*string\s*,\s*RuntimeThreadSettings/u.test(content))
  ) {
    failures.push(
      `${file}: thread session consistency crossed into transport, presentation, or Queue orchestration`,
    );
  }

  if (
    file === "apps/web/src/v4/actors/thread-actor.ts" &&
    /\bopenedThreadId\b/u.test(content)
  ) {
    failures.push(
      `${file}: server-side thread ownership must be carried by generation-bound effects, not mutable shadow state`,
    );
  }

  if (
    file === "apps/web/src/v4/ui/pages/thread-settings-model.ts" &&
    imports.some(
      (specifier) =>
        specifier === "react" ||
        specifier.includes("runtime-context") ||
        specifier.includes("ThreadSettingsPanel"),
    )
  ) {
    failures.push(
      `${file}: task settings conflict model must remain independent of React and page runtime state`,
    );
  }

  if (
    file === "apps/web/src/v4/ui/timeline/conversation-outline-model.ts" &&
    imports.some(
      (specifier) =>
        specifier === "react" ||
        /(?:gateway|runtime|actors\/thread-actor)/u.test(specifier),
    )
  ) {
    failures.push(
      `${file}: conversation outline must remain a pure projection of typed timeline items`,
    );
  }

  if (
    file.startsWith("apps/web/src/v4/ui/timeline/") &&
    /\bMutationObserver\b/u.test(content)
  ) {
    failures.push(
      `${file}: timeline navigation must derive entries from actor data, not DOM mutations`,
    );
  }

  if (
    file === "apps/agent/src/v2/adapters/direct-discovery.ts" &&
    imports.some(
      (specifier) =>
        specifier === "@codex-everywhere/crypto" ||
        /(?:gateway\/transport-contract|services\/|repositories\/|protocol\/v2)/u.test(
          specifier,
        ),
    )
  ) {
    failures.push(
      `${file}: public Host Discovery crossed into authenticated business state`,
    );
  }

  if (
    file === "apps/agent/src/v2/adapters/direct-transport.ts" &&
    imports.some(
      (specifier) =>
        specifier.startsWith("@codex-everywhere/protocol") ||
        specifier === "@codex-everywhere/crypto" ||
        /(?:gateway\/transport-contract|services\/|repositories\/)/u.test(
          specifier,
        ),
    )
  ) {
    failures.push(
      `${file}: Direct listener crossed into Noise protocol or business state`,
    );
  }

  if (
    file === "apps/agent/src/v2/adapters/gateway-socket-connection.ts" &&
    imports.some(
      (specifier) =>
        specifier === "node:http" ||
        /(?:direct-discovery|services\/|repositories\/|composition-root)/u.test(
          specifier,
        ),
    )
  ) {
    failures.push(
      `${file}: encrypted socket lifecycle crossed into listener, discovery, or business state`,
    );
  }

  if (
    file === "apps/agent/src/v2/adapters/gateway-peer-authentication.ts" &&
    imports.some(
      (specifier) =>
        specifier === "@codex-everywhere/crypto" ||
        specifier.startsWith("@codex-everywhere/protocol/v2") ||
        /(?:direct-discovery|gateway-socket-connection|services\/|repositories\/|composition-root)/u.test(
          specifier,
        ),
    )
  ) {
    failures.push(
      `${file}: peer authentication policy crossed into Noise, listener, or business state`,
    );
  }

  if (file.startsWith("apps/agent/src/runtime/") && file.endsWith("-v2.ts")) {
    for (const specifier of imports) {
      if (
        /\/(?:agent-service|admin-controller-service|direct-gateway)\.js$/u.test(
          specifier,
        )
      ) {
        failures.push(`${file}: v0.4 runtime imported a v0.3 service path`);
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
    file.startsWith("apps/agent/src/v2/") ||
    architectureEntrypoints.includes(file)
  ) {
    for (const specifier of imports) {
      if (
        /\/host\/(?:devices|idempotency|passkeys|queue|state-store|thread-permissions|user-preferences)\.js$/u.test(
          specifier,
        )
      ) {
        failures.push(
          `${file}: v0.4 runtime imported legacy state ${specifier}`,
        );
      }
    }
    if (/\bHostStateStore\b/u.test(content)) {
      failures.push(`${file}: v0.4 runtime referenced HostStateStore`);
    }
  }

  if (
    (file.startsWith("apps/agent/src/v2/") ||
      file.startsWith("apps/web/src/v4/")) &&
    !file.includes("/gateway/") &&
    /\b(?:RequestEnvelope|requestEnvelope)\b/u.test(content)
  ) {
    failures.push(`${file}: raw Gateway envelopes are restricted to adapters`);
  }

  if (
    (file.startsWith("apps/agent/src/v2/") ||
      file.startsWith("apps/web/src/v4/") ||
      file.startsWith("packages/protocol/src/v2/")) &&
    /(["'`])(?:side\/[^"'`]*|thread\/fork|setup\/codex\/auth\/import)\1/u.test(
      content,
    )
  ) {
    failures.push(`${file}: removed Gateway v1 method leaked into v0.4 source`);
  }
}

for (const file of uiStyleFiles) {
  if (!file.endsWith(".module.css")) {
    failures.push(`${file}: feature styles must use a colocated CSS Module`);
  }
}

const globalStylePath = "apps/web/src/v4/styles/global.css";
const globalStyles = readFileSync(
  join(repositoryRoot, globalStylePath),
  "utf8",
);
for (const selector of [
  ".task-context-",
  ".task-list-",
  ".task-grid",
  ".task-card",
  ".task-dot",
  ".task-workspace-",
  ".settings-",
  ".preference-form",
  ".identity-actions",
  ".password-form",
]) {
  if (globalStyles.includes(selector)) {
    failures.push(
      `${globalStylePath}: ${selector} is owned by a task feature CSS Module`,
    );
  }
}

checkWebEntrypoint();
checkAgentEntrypoint();
checkForbiddenDependencies();

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

function checkWebEntrypoint() {
  const entryPath = "apps/web/src/entry.ts";
  const entry = readFileSync(join(repositoryRoot, entryPath), "utf8");
  if (!/import\(["']\.\/v4\/bootstrap\.js["']\)/u.test(entry)) {
    failures.push(
      `${entryPath}: production entrypoint must load v0.4 bootstrap`,
    );
  }
  if (
    /(?:import|from)\s*\(?["']\.\/(?:main|admin-main|gateway-client)\.js["']/u.test(
      entry,
    )
  ) {
    failures.push(`${entryPath}: production entrypoint imports v0.3 Web code`);
  }
}

function checkAgentEntrypoint() {
  const entryPath = "apps/agent/src/cli.ts";
  const entry = readFileSync(join(repositoryRoot, entryPath), "utf8");
  for (const forbidden of [
    "./runtime/agent-service.js",
    "./runtime/admin-controller-service.js",
    "./gateway/direct-gateway.js",
  ]) {
    if (entry.includes(forbidden)) {
      failures.push(`${entryPath}: production CLI imports ${forbidden}`);
    }
  }
  if (!entry.includes("runAgentServiceV2 as runAgentService")) {
    failures.push(`${entryPath}: Agent serve command is not bound to v0.4`);
  }
  if (
    !entry.includes("runAdminControllerServiceV2 as runAdminControllerService")
  ) {
    failures.push(
      `${entryPath}: Administrator serve command is not bound to v0.4`,
    );
  }
  if (
    /\.command\(["'](?:upgrade|state)["']\)|migration-finalize|state migrate/u.test(
      entry,
    )
  ) {
    failures.push(`${entryPath}: v0.3 state migration CLI was reintroduced`);
  }
}

function checkForbiddenDependencies() {
  const packagePath = "apps/web/package.json";
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, packagePath), "utf8"),
  );
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  for (const name of ["redux", "@reduxjs/toolkit", "xstate", "tailwindcss"]) {
    if (name in dependencies) {
      failures.push(`${packagePath}: v0.4 Web must not depend on ${name}`);
    }
  }
}

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

function collectStyleFiles(root) {
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
      } else if (entry.isFile() && entry.name.endsWith(".css")) {
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
