import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const trackedFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const failures = [];
const forbiddenNames = new Set([
  "auth.json",
  ".env",
  ".env.local",
  ".env.production",
]);
const forbiddenExtensions = /\.(?:pem|key|p12|pfx|crt|csr|sqlite3?|db)$/i;
const allowedExampleUsers = new Set([
  "alice",
  "bob",
  "codexeverywhere",
  "demo",
  "runner",
  "user",
]);
const privateKeyPattern = new RegExp(
  `^${"-----" + "BEGIN "}[A-Z0-9 ]*${"PRIVATE " + "KEY-----"}$`,
  "m",
);
const unixHomePattern = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/g;
const windowsHomePattern = /[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g;
const ipv4Pattern = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g;

function isAllowedAddress(address) {
  const octets = address.split(".").map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function inspectMatchUsers(file, content, pattern) {
  for (const match of content.matchAll(pattern)) {
    const user = match[1];
    if (user && !allowedExampleUsers.has(user)) {
      failures.push(`${file}: contains a non-example home directory (${user})`);
    }
  }
}

for (const file of trackedFiles) {
  const name = basename(file);
  if (
    forbiddenNames.has(name) ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    forbiddenExtensions.test(name) ||
    file
      .split("/")
      .some((segment) =>
        [".codex", ".codex-everywhere", "node_modules"].includes(segment),
      )
  ) {
    failures.push(
      `${file}: runtime, credential, or secret-like file is tracked`,
    );
    continue;
  }

  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\0")) continue;
  if (privateKeyPattern.test(content)) {
    failures.push(`${file}: contains a private-key marker`);
  }
  inspectMatchUsers(file, content, unixHomePattern);
  inspectMatchUsers(file, content, windowsHomePattern);
  for (const match of content.matchAll(ipv4Pattern)) {
    const address = match[1];
    if (address && !isAllowedAddress(address)) {
      failures.push(`${file}: contains a public IPv4 address (${address})`);
    }
  }
}

const requiredPlaceholders = new Map([
  ["deploy/nginx/codex-everywhere.conf", ["__PUBLIC_HOST__"]],
  [
    "deploy/nginx/direct-host.conf",
    ["__DIRECT_HOST__", "__AGENT_PORT__", "__PWA_ROOT__"],
  ],
]);
for (const [file, placeholders] of requiredPlaceholders) {
  const content = readFileSync(file, "utf8");
  for (const placeholder of placeholders) {
    if (!content.includes(placeholder)) {
      failures.push(`${file}: missing deployment placeholder ${placeholder}`);
    }
  }
}

for (const workflow of [
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
]) {
  const content = readFileSync(workflow, "utf8");
  if (/\b(?:scp|ssh|rsync)\b/.test(content)) {
    failures.push(`${workflow}: public CI must not deploy to a real host`);
  }
}

if (failures.length > 0) {
  console.error("Public repository hygiene check failed:\n");
  for (const failure of [...new Set(failures)].sort()) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Public repository hygiene check passed (${trackedFiles.length} files).`,
);
