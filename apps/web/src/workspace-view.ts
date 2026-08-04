export const ALL_WORKSPACES = "__all_workspaces__";

export type WorkspaceThread = {
  cwd: string;
};

export type WorkspaceThreadGroup<T extends WorkspaceThread> = {
  cwd: string;
  threads: T[];
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

export function groupThreadsByCwd<T extends WorkspaceThread>(
  threads: readonly T[],
): WorkspaceThreadGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const thread of threads) {
    const group = groups.get(thread.cwd) ?? [];
    group.push(thread);
    groups.set(thread.cwd, group);
  }
  return Array.from(groups, ([cwd, groupedThreads]) => ({
    cwd,
    threads: groupedThreads,
  }));
}

export function workspaceRelativeCwd(root: string, cwd: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedCwd = normalizePath(cwd);
  if (!workspaceContainsCwd(normalizedRoot, normalizedCwd))
    return normalizedCwd;
  if (normalizedRoot === normalizedCwd) return pathName(normalizedCwd);
  return normalizedCwd.slice(
    normalizedRoot === "/" ? 1 : normalizedRoot.length + 1,
  );
}

function normalizePath(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/u, "");
}

function pathName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "/";
}
