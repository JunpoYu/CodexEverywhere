#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const options = parseArguments(
  process.argv.slice(2).filter((argument) => argument !== "--"),
);
const project = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const receiptPath = resolve(
  options.receipt ??
    join(
      tmpdir(),
      `codex-everywhere-v0.4-candidate-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
    ),
);
const shellFiles = await deploymentShellFiles();
const steps = [
  command("public-repository-hygiene", "pnpm", ["check:public"]),
  command("format", "pnpm", ["format:check"]),
  command("architecture", "pnpm", ["check:architecture"]),
  command("test-runtime-capabilities", "pnpm", ["check:test-runtime"]),
  command("typecheck", "pnpm", ["typecheck"]),
  command("unit-and-protocol", "pnpm", ["test"]),
  command("build", "pnpm", ["build"]),
  command("web-bundle-budget", "pnpm", ["check:web-budget"]),
  command("playwright", "pnpm", ["test:e2e"]),
  command("app-server-contract", "pnpm", ["test:app-server"], {
    CE_RUN_MODEL_INTEGRATION: options.withModel ? "1" : "0",
  }),
  command("deployment-shell-syntax", "sh", ["-n", ...shellFiles]),
  command("working-tree-whitespace", "git", ["diff", "--check"]),
  command("staged-whitespace", "git", ["diff", "--cached", "--check"]),
];

if (options.plan) {
  process.stdout.write(
    `${JSON.stringify(
      {
        version: 1,
        kind: "codex-everywhere-v0.4-candidate-plan",
        withModel: options.withModel,
        steps: steps.map(({ name }) => name),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

const commit = (await capture("git", ["rev-parse", "HEAD"])).trim();
const dirty = (await capture("git", ["status", "--porcelain"])).trim() !== "";
const receipt = {
  version: 1,
  kind: "codex-everywhere-v0.4-candidate-checks",
  runId: randomUUID(),
  projectVersion: project.version,
  commit,
  dirty,
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  modelIntegration: options.withModel ? "required" : "not-requested",
  startedAt: new Date().toISOString(),
  completedAt: null,
  status: "running",
  checks: [],
  remainingExternalGates: [
    ...(options.withModel ? [] : ["subscription-model-integration"]),
    "multi-user-fresh-install-staging",
  ],
};
let receiptCreated = false;

try {
  if (dirty && !options.allowDirty) {
    throw new Error(
      "the candidate worktree is dirty; commit the candidate or pass --allow-dirty for a non-release development run",
    );
  }
  await persistReceipt();
  for (const step of steps) await runStep(step);
  receipt.status = "passed";
  receipt.completedAt = new Date().toISOString();
  await persistReceipt();
  process.stdout.write(`\nCandidate checks passed.\nReceipt: ${receiptPath}\n`);
} catch (error) {
  receipt.status = "failed";
  receipt.completedAt = new Date().toISOString();
  receipt.failure = sanitizeFailure(error);
  await persistReceipt().catch(() => undefined);
  process.stderr.write(
    `\nCandidate checks failed: ${sanitizeFailure(error)}\nReceipt: ${receiptPath}\n`,
  );
  process.exitCode = 1;
}

async function runStep(step) {
  const result = {
    name: step.name,
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: null,
    status: "running",
  };
  receipt.checks.push(result);
  await persistReceipt();
  const started = performance.now();
  process.stdout.write(`\n== ${step.name} ==\n`);
  const exitCode = await execute(
    step.executable,
    step.arguments,
    step.environment,
  );
  result.durationMs = Math.round(performance.now() - started);
  result.completedAt = new Date().toISOString();
  result.status = exitCode === 0 ? "passed" : "failed";
  await persistReceipt();
  if (exitCode !== 0) {
    throw new Error(`${step.name} exited with code ${exitCode}`);
  }
}

async function persistReceipt() {
  await mkdir(dirname(receiptPath), { recursive: true });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (!receiptCreated) {
    await writeFile(receiptPath, serialized, { flag: "wx", mode: 0o600 });
    receiptCreated = true;
    return;
  }
  const temporaryPath = `${receiptPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, receiptPath);
}

function command(name, executable, arguments_, extraEnvironment = {}) {
  return {
    name,
    executable,
    arguments: arguments_,
    environment: extraEnvironment,
  };
}

async function execute(executable, arguments_, extraEnvironment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`${executable} terminated by ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

async function capture(executable, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${executable} exited with code ${code ?? 1}`));
    });
  });
}

async function deploymentShellFiles() {
  const directories = ["deploy/hpc", "deploy/release"];
  const files = [];
  for (const directory of directories) {
    const names = await readdir(join(repositoryRoot, directory));
    for (const name of names.sort()) {
      if (name.endsWith(".sh")) files.push(join(directory, name));
    }
  }
  if (files.length === 0) throw new Error("no deployment shell scripts found");
  return files;
}

function parseArguments(arguments_) {
  let receipt;
  let withModel = false;
  let allowDirty = false;
  let plan = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--receipt") {
      receipt = requireValue(arguments_, ++index, argument);
    } else if (argument === "--with-model") {
      withModel = true;
    } else if (argument === "--allow-dirty") {
      allowDirty = true;
    } else if (argument === "--plan") {
      plan = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { receipt, withModel, allowDirty, plan };
}

function requireValue(arguments_, index, flag) {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function sanitizeFailure(error) {
  if (!(error instanceof Error)) return "unknown failure";
  return error.message.replaceAll(repositoryRoot, "<repository>").slice(0, 500);
}
