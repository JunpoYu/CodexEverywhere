import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const MAX_CODEX_AUTH_BYTES = 256 * 1024;

export type CodexAuthImportOutcome = {
  replacedExisting: boolean;
};

export async function importCodexAuthFile(options: {
  userHome: string;
  content: string;
}): Promise<CodexAuthImportOutcome> {
  const normalized = normalizeCodexAuth(options.content);
  const canonicalHome = await realpath(options.userHome);
  const codexDirectory = join(canonicalHome, ".codex");

  await mkdir(codexDirectory, { recursive: true, mode: 0o700 });
  const directoryState = await lstat(codexDirectory);
  if (directoryState.isSymbolicLink() || !directoryState.isDirectory()) {
    throw new Error("Codex configuration path must be a regular directory");
  }
  if ((await realpath(codexDirectory)) !== codexDirectory) {
    throw new Error("Codex configuration path escapes the user home");
  }
  const processUid = process.getuid?.();
  if (processUid !== undefined && directoryState.uid !== processUid) {
    throw new Error("Codex configuration directory is not owned by this user");
  }
  await chmod(codexDirectory, 0o700);

  const authPath = join(codexDirectory, "auth.json");
  let replacedExisting = false;
  try {
    const current = await lstat(authPath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new Error("Existing Codex auth path is not a regular file");
    }
    if (processUid !== undefined && current.uid !== processUid) {
      throw new Error("Existing Codex auth file is not owned by this user");
    }
    replacedExisting = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const temporary = join(
    codexDirectory,
    `.auth.json.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(normalized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, authPath);
    await chmod(authPath, 0o600);
    const directoryHandle = await open(codexDirectory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { replacedExisting };
}

export function normalizeCodexAuth(content: string): string {
  if (Buffer.byteLength(content, "utf8") > MAX_CODEX_AUTH_BYTES) {
    throw new Error("Codex auth file exceeds the 256 KiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Selected file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Codex auth file must contain a JSON object");
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
