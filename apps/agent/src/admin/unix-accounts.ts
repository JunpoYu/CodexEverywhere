import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UNIX_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}\$?$/u;
const NON_LOGIN_SHELLS = new Set([
  "false",
  "halt",
  "nologin",
  "shutdown",
  "sync",
]);

export type UnixAccount = {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
};

export type UnixAccountEligibility =
  | { eligible: true; account: UnixAccount }
  | { eligible: false; reason: string; account?: UnixAccount };

export type GetentRunner = (username: string) => Promise<string | undefined>;

export async function inspectSshUnixAccount(
  username: string,
  runGetent: GetentRunner = systemGetent,
): Promise<UnixAccountEligibility> {
  if (!UNIX_NAME.test(username))
    return { eligible: false, reason: "invalid Unix username" };
  const line = await runGetent(username);
  if (!line)
    return { eligible: false, reason: "Unix account not found in NSS" };
  const account = parsePasswdEntry(line);
  if (account.username !== username)
    return { eligible: false, reason: "NSS returned a different Unix account" };
  if (account.uid === 0)
    return {
      eligible: false,
      reason: "root cannot use CodexEverywhere",
      account,
    };
  if (!account.home.startsWith("/") || account.home === "/")
    return {
      eligible: false,
      reason: "Unix account has no private home",
      account,
    };
  if (!isLoginShell(account.shell))
    return {
      eligible: false,
      reason: "Unix account has no login shell",
      account,
    };
  return { eligible: true, account };
}

export async function inspectSshUnixAccountByUid(
  uid: number,
  runGetent: GetentRunner = systemGetent,
): Promise<UnixAccountEligibility> {
  if (!Number.isSafeInteger(uid) || uid <= 0)
    return { eligible: false, reason: "invalid Unix UID" };
  const line = await runGetent(String(uid));
  if (!line)
    return { eligible: false, reason: "Unix account not found in NSS" };
  const account = parsePasswdEntry(line);
  if (account.uid !== uid)
    return { eligible: false, reason: "NSS returned a different Unix UID" };
  return inspectSshUnixAccount(account.username, async () => line);
}

export function parsePasswdEntry(line: string): UnixAccount {
  const entries = line.trimEnd().split("\n");
  if (entries.length !== 1) throw new Error("Ambiguous NSS account result");
  const fields = entries[0]?.split(":");
  if (!fields || fields.length !== 7)
    throw new Error("Invalid NSS passwd entry");
  const [username, , uidText, gidText, , home, shell] = fields;
  const uid = Number(uidText);
  const gid = Number(gidText);
  if (
    !username ||
    !UNIX_NAME.test(username) ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    !home ||
    !shell
  ) {
    throw new Error("Invalid NSS passwd entry");
  }
  return { username, uid, gid, home, shell };
}

async function systemGetent(username: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("getent", ["passwd", username], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      timeout: 5_000,
    });
    return result.stdout || undefined;
  } catch (error) {
    if (isExitCode(error, 2)) return undefined;
    throw new Error("Cannot query the host NSS account directory", {
      cause: error,
    });
  }
}

function isLoginShell(shell: string): boolean {
  if (!shell.startsWith("/")) return false;
  const basename = shell.slice(shell.lastIndexOf("/") + 1);
  return !NON_LOGIN_SHELLS.has(basename);
}

function isExitCode(error: unknown, code: number): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return (error as unknown as { code?: unknown }).code === code;
}
