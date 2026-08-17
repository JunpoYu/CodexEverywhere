import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = resolve(import.meta.dirname, "..");
const destination = join(
  repository,
  "apps/agent/src/v2/codex/generated/server-notification.schema.json",
);
const temporary = await mkdtemp(join(tmpdir(), "ce-codex-schema-"));

try {
  await run(
    "codex",
    ["app-server", "generate-json-schema", "--out", temporary],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(temporary, "ServerNotification.json"), destination);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
