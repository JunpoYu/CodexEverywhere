export const ALL_WORKSPACES = "__all_workspaces__";

export type WorkspaceThread = {
  cwd: string;
};

export function workspaceContainsCwd(root: string, cwd: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCwd = normalizePath(cwd);
  if (normalizedRoot === "/") return normalizedCwd.startsWith("/");
  return (
    normalizedCwd === normalizedRoot ||
    normalizedCwd.startsWith(`${normalizedRoot}/`)
  );
}

export function workspaceForCwd(
  roots: readonly string[],
  cwd: string,
): string | undefined {
  return roots
    .filter((root) => workspaceContainsCwd(root, cwd))
    .sort((left, right) => right.length - left.length)[0];
}

export function threadsInWorkspace<T extends WorkspaceThread>(
  threads: readonly T[],
  scope: string,
): T[] {
  if (scope === ALL_WORKSPACES) return [...threads];
  return threads.filter((thread) => workspaceContainsCwd(scope, thread.cwd));
}

function normalizePath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/u, "");
}
