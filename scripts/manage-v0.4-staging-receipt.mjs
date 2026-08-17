#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const project = JSON.parse(
  await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
);
const REQUIRED_CHECKS = [
  "transport.direct",
  "transport.relay",
  "viewport.desktop",
  "viewport.mobile-390",
  "device.first-use",
  "device.saved",
  "device.temporary",
  "identity.passkey",
  "identity.password",
  "identity.recovery",
  "onboarding.fresh-install",
  "onboarding.ready-user",
  "task.idle",
  "task.running-stream",
  "task.waiting-input",
  "task.approval-race",
  "task.user-question",
  "task.mcp-elicitation",
  "task.interrupt",
  "task.tui-handoff",
  "recovery.browser-disconnect",
  "recovery.agent-restart",
  "recovery.app-server-restart",
  "queue.add-remove-steer",
  "queue.crash-indeterminate-acknowledge",
  "pwa.outcome-unknown-update-guard",
  "protocol.version-mismatch",
  "admin.inspect",
  "admin.disable-enable",
  "admin.recovery-handoff",
  "admin.removal",
  "admin.audit",
  "isolation.two-users",
  "isolation.workspace",
  "isolation.admin-user-runtime",
  "migration.preflight",
  "migration.forward",
  "migration.v0.4-writes",
  "migration.reverse",
  "migration.artifact-rollback",
  "migration.v0.3-semantics",
  "migration.forward-again",
  "migration.backups-retained",
  "security.logs-sanitized",
  "model.real-subscription-call",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OPERATOR_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;

try {
  const [command, path, ...rest] = process.argv
    .slice(2)
    .filter((argument) => argument !== "--");
  if (rest.length > 0 || !["init", "validate"].includes(command) || !path) {
    throw new Error(
      "usage: manage-v0.4-staging-receipt.mjs <init|validate> <receipt.json>",
    );
  }
  if (command === "init") await initialize(resolve(path));
  else await validate(resolve(path));
} catch (error) {
  process.stderr.write(
    `Staging receipt failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}

async function initialize(path) {
  const commit = (await capture("git", ["rev-parse", "HEAD"])).trim();
  const receipt = {
    version: 1,
    kind: "codex-everywhere-v0.4-staging",
    runId: randomUUID(),
    projectVersion: project.version,
    releaseCommit: commit,
    operatorAlias: "",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "in-progress",
    environment: {
      os: "centos",
      osMajor: 7,
      nodeMajor: 20,
      glibc: "2.17",
      testUserCount: 0,
      adminControlPlane: false,
    },
    evidence: {
      manifestSha256: "",
      candidateReceiptSha256: "",
      sourceBackupSha256s: [],
      forwardReceiptSha256s: [],
      reverseReceiptSha256s: [],
      secondForwardReceiptSha256s: [],
    },
    checks: Object.fromEntries(REQUIRED_CHECKS.map((check) => [check, false])),
  };
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `Initialized private staging receipt: ${path}\nComplete it outside the source repository, then run the validate command.\n`,
  );
}

async function validate(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("staging receipt must be a regular file, not a symlink");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("staging receipt must have mode 0600");
  }
  const receipt = JSON.parse(await readFile(path, "utf8"));
  assertExactKeys(
    receipt,
    [
      "version",
      "kind",
      "runId",
      "projectVersion",
      "releaseCommit",
      "operatorAlias",
      "startedAt",
      "completedAt",
      "status",
      "environment",
      "evidence",
      "checks",
    ],
    "receipt",
  );
  if (
    receipt.version !== 1 ||
    receipt.kind !== "codex-everywhere-v0.4-staging"
  ) {
    throw new Error("unsupported staging receipt kind or version");
  }
  if (receipt.projectVersion !== project.version) {
    throw new Error(
      `receipt project version ${String(receipt.projectVersion)} does not match ${project.version}`,
    );
  }
  const currentCommit = (await capture("git", ["rev-parse", "HEAD"])).trim();
  if (receipt.releaseCommit !== currentCommit) {
    throw new Error(
      "receipt releaseCommit does not match the current checkout",
    );
  }
  assertPattern(receipt.runId, UUID_PATTERN, "runId");
  assertPattern(receipt.releaseCommit, COMMIT_PATTERN, "releaseCommit");
  assertPattern(receipt.operatorAlias, OPERATOR_PATTERN, "operatorAlias");
  const startedAt = parseTimestamp(receipt.startedAt, "startedAt");
  const completedAt = parseTimestamp(receipt.completedAt, "completedAt");
  if (completedAt < startedAt)
    throw new Error("completedAt precedes startedAt");
  if (receipt.status !== "passed")
    throw new Error("receipt status is not passed");

  validateEnvironment(receipt.environment);
  validateEvidence(receipt.evidence, receipt.environment.testUserCount);
  assertExactKeys(receipt.checks, REQUIRED_CHECKS, "checks");
  const incomplete = REQUIRED_CHECKS.filter(
    (check) => receipt.checks[check] !== true,
  );
  if (incomplete.length > 0) {
    throw new Error(`incomplete staging checks: ${incomplete.join(", ")}`);
  }
  process.stdout.write(
    `Staging receipt passed (${receipt.runId}, commit ${receipt.releaseCommit}).\n`,
  );
}

function validateEnvironment(environment) {
  assertExactKeys(
    environment,
    [
      "os",
      "osMajor",
      "nodeMajor",
      "glibc",
      "testUserCount",
      "adminControlPlane",
    ],
    "environment",
  );
  if (
    environment.os !== "centos" ||
    environment.osMajor !== 7 ||
    environment.nodeMajor !== 20 ||
    environment.glibc !== "2.17"
  ) {
    throw new Error(
      "staging environment does not match the first compatibility target",
    );
  }
  if (
    !Number.isInteger(environment.testUserCount) ||
    environment.testUserCount < 2
  ) {
    throw new Error("staging requires at least two test users");
  }
  if (environment.adminControlPlane !== true) {
    throw new Error("staging requires the admin control plane");
  }
}

function validateEvidence(evidence, testUserCount) {
  assertExactKeys(
    evidence,
    [
      "manifestSha256",
      "candidateReceiptSha256",
      "sourceBackupSha256s",
      "forwardReceiptSha256s",
      "reverseReceiptSha256s",
      "secondForwardReceiptSha256s",
    ],
    "evidence",
  );
  assertPattern(evidence.manifestSha256, SHA256_PATTERN, "manifestSha256");
  assertPattern(
    evidence.candidateReceiptSha256,
    SHA256_PATTERN,
    "candidateReceiptSha256",
  );
  const minimumStateFiles = testUserCount + 1;
  validateHashList(
    evidence.sourceBackupSha256s,
    minimumStateFiles,
    "sourceBackupSha256s",
  );
  validateHashList(
    evidence.forwardReceiptSha256s,
    minimumStateFiles,
    "forwardReceiptSha256s",
  );
  validateHashList(
    evidence.reverseReceiptSha256s,
    minimumStateFiles,
    "reverseReceiptSha256s",
  );
  validateHashList(
    evidence.secondForwardReceiptSha256s,
    minimumStateFiles,
    "secondForwardReceiptSha256s",
  );
}

function validateHashList(value, minimum, label) {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${label} requires at least ${minimum} hashes`);
  }
  for (const hash of value) assertPattern(hash, SHA256_PATTERN, label);
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} contains duplicate hashes`);
  }
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function assertPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== "string")
    throw new Error(`${label} must be a timestamp`);
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function capture(executable, arguments_) {
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
