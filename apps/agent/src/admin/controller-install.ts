import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { AdminControllerConfig } from "./controller-config.js";

const execFileAsync = promisify(execFile);
export const ADMIN_HELPER_PATH = "/usr/local/libexec/ce-admin-helper";
export const ADMIN_SUDOERS_PATH = "/etc/sudoers.d/codex-everywhere-admin";
export const ADMIN_CRON_PATH = "/etc/cron.d/codex-everywhere-admin";

export async function installAdminSystemIntegration(
  config: AdminControllerConfig,
): Promise<void> {
  if (process.getuid?.() !== 0)
    throw new Error("Administrator system integration requires root");
  await writeAtomic(
    ADMIN_HELPER_PATH,
    '#!/bin/sh\nset -eu\nif [ "$#" -ne 0 ]; then exit 64; fi\nexec /usr/local/bin/ce admin helper\n',
    0o755,
  );
  const sudoers = `${config.runAsUser} ALL=(root) NOPASSWD: ${ADMIN_HELPER_PATH}\n`;
  await writeValidatedSudoers(ADMIN_SUDOERS_PATH, sudoers);
  const cron = [
    "SHELL=/bin/sh",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `* * * * * ${config.runAsUser} CE_ADMIN_HOME=${shellQuote(config.home)} /usr/local/bin/ce admin web start >/dev/null 2>&1`,
    "* * * * * root /usr/local/bin/ce admin maintenance >/dev/null 2>&1",
    "",
  ].join("\n");
  await writeAtomic(ADMIN_CRON_PATH, cron, 0o644);
}

async function writeValidatedSudoers(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o440);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await execFileAsync("/usr/sbin/visudo", ["-cf", temporary], {
      encoding: "utf8",
      timeout: 5_000,
    });
    await rename(temporary, path);
    await chmod(path, 0o440);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeAtomic(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
