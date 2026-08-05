import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ADMIN_STATE_FILE = "/var/lib/codex-everywhere/admin/state.sqlite";
export const ADMIN_POLICY_DIRECTORY = "/etc/codex-everywhere-access";

export function disabledMarkerPath(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid <= 0)
    throw new Error("Invalid Unix UID");
  return join(ADMIN_POLICY_DIRECTORY, `${uid}.disabled`);
}

export async function assertUserAccessEnabled(
  uid = process.getuid?.(),
): Promise<void> {
  if (uid === undefined || uid <= 0) return;
  try {
    await readFile(disabledMarkerPath(uid));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(
    "CodexEverywhere Web access is disabled for this Unix account; SSH and Codex TUI are unaffected",
  );
}

export async function setUserAccessDisabled(
  uid: number,
  disabled: boolean,
): Promise<void> {
  const path = disabledMarkerPath(uid);
  if (!disabled) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(ADMIN_POLICY_DIRECTORY, { recursive: true, mode: 0o755 });
  const directory = await lstat(ADMIN_POLICY_DIRECTORY);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== 0 ||
    (directory.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Administrator access-policy directory must be root-owned and not group/world writable",
    );
  }
  await writeFile(path, `${new Date().toISOString()}\n`, {
    encoding: "utf8",
    mode: 0o644,
    flag: "w",
  });
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
