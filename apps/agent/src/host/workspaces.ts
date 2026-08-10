import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { HostStateStore } from "./state-store.js";

export type WorkspaceProfile = {
  roots: string[];
  defaultRoot?: string;
};

export type WorkspaceBrowseResponse = {
  path: string;
  home: string;
  parent?: string;
  directories: Array<{ name: string; path: string }>;
  truncated: boolean;
};

const MAX_BROWSE_DIRECTORIES = 250;
const AUTHORIZATION_REVISION_CACHE_MS = 250;

type WorkspaceAuthorizationCache = { revision: number; checkedAt: number };
const authorizationCaches = new WeakMap<
  HostStateStore,
  WorkspaceAuthorizationCache
>();

export class WorkspaceRegistry {
  readonly #state: HostStateStore;

  constructor(state: HostStateStore) {
    this.#state = state;
  }

  async add(inputPath: string): Promise<{ root: string; added: boolean }> {
    const root = await resolveExistingDirectory(inputPath);
    const result = await this.#state.transaction((database) => {
      database.run(
        "INSERT OR IGNORE INTO workspace_roots(path, created_at) VALUES (?, ?)",
        [root, new Date().toISOString()],
      );
      const added = database.getRowsModified() > 0;
      if (!readDefaultRoot(database)) {
        database.run(
          "INSERT OR REPLACE INTO workspace_settings (id, default_path) VALUES (1, ?)",
          [root],
        );
      }
      if (added) incrementAuthorizationRevision(database);
      return { added, revision: readAuthorizationRevision(database) };
    });
    cacheAuthorizationRevision(this.#state, result.revision);
    return { root, added: result.added };
  }

  async remove(inputPath: string): Promise<{ root: string; removed: boolean }> {
    const absolute = resolve(inputPath);
    const exactStoredRoot =
      isAbsolute(inputPath) &&
      inputPath === absolute &&
      (await this.list()).includes(absolute)
        ? absolute
        : undefined;
    // Revocation must remain possible after a registered root disappears,
    // becomes unreadable, or is replaced by a symlink. Only the exact canonical
    // absolute path previously stored in the registry may bypass realpath.
    const root = exactStoredRoot ?? (await realpath(absolute));
    const result = await this.#state.transaction((database) => {
      database.run("DELETE FROM workspace_roots WHERE path = ?", [root]);
      const removed = database.getRowsModified() > 0;
      if (removed && readDefaultRoot(database) === root) {
        const next = readRoots(database)[0];
        if (next) {
          database.run(
            "INSERT OR REPLACE INTO workspace_settings (id, default_path) VALUES (1, ?)",
            [next],
          );
        } else {
          database.run("DELETE FROM workspace_settings WHERE id = 1");
        }
      }
      if (removed) incrementAuthorizationRevision(database);
      return { removed, revision: readAuthorizationRevision(database) };
    });
    cacheAuthorizationRevision(this.#state, result.revision);
    return { root, removed: result.removed };
  }

  list(): Promise<string[]> {
    return this.#state.read(readRoots);
  }

  profile(): Promise<WorkspaceProfile> {
    return this.#state.read((database) => {
      const roots = readRoots(database);
      const configuredDefault = readDefaultRoot(database);
      const defaultRoot = roots.includes(configuredDefault ?? "")
        ? configuredDefault
        : roots[0];
      return {
        roots,
        ...(defaultRoot ? { defaultRoot } : {}),
      };
    });
  }

  async setDefault(inputPath: string): Promise<{ defaultRoot: string }> {
    const root = await resolveExistingDirectory(inputPath);
    await this.#state.transaction((database) => {
      if (!readRoots(database).includes(root))
        throw new Error(`Workspace root is not registered: ${root}`);
      database.run(
        "INSERT OR REPLACE INTO workspace_settings (id, default_path) VALUES (1, ?)",
        [root],
      );
    });
    return { defaultRoot: root };
  }

  async resolve(inputPath: string): Promise<string> {
    return resolveWorkspacePath(await this.list(), inputPath);
  }

  async resolveWithRevision(
    inputPath: string,
  ): Promise<{ path: string; revision: number }> {
    while (true) {
      const snapshot = await this.#state.read((database) => ({
        roots: readRoots(database),
        revision: readAuthorizationRevision(database),
      }));
      cacheAuthorizationRevision(this.#state, snapshot.revision);
      const path = await resolveWorkspacePath(snapshot.roots, inputPath);
      if (
        snapshot.revision ===
        (await this.authorizationRevision({ fresh: true }))
      ) {
        return { path, revision: snapshot.revision };
      }
    }
  }

  async authorizationRevision(
    options: { fresh?: boolean } = {},
  ): Promise<number> {
    const cached = authorizationCaches.get(this.#state);
    if (
      options.fresh !== true &&
      cached &&
      Date.now() - cached.checkedAt < AUTHORIZATION_REVISION_CACHE_MS
    ) {
      return cached.revision;
    }
    const revision = await this.#state.read(readAuthorizationRevision);
    cacheAuthorizationRevision(this.#state, revision);
    return revision;
  }

  async allowedPaths(inputPaths: readonly string[]): Promise<Set<string>> {
    return (await this.allowedPathsWithRevision(inputPaths)).paths;
  }

  async allowedPathsWithRevision(
    inputPaths: readonly string[],
  ): Promise<{ paths: Set<string>; revision: number }> {
    while (true) {
      const snapshot = await this.#state.read((database) => ({
        roots: readRoots(database),
        revision: readAuthorizationRevision(database),
      }));
      cacheAuthorizationRevision(this.#state, snapshot.revision);
      const allowed = new Set<string>();
      await Promise.all(
        [...new Set(inputPaths)].map(async (inputPath) => {
          try {
            await resolveWorkspacePath(snapshot.roots, inputPath);
            allowed.add(inputPath);
          } catch {
            // A history listing silently excludes missing, unreadable, or
            // out-of-workspace paths without weakening the path boundary.
          }
        }),
      );
      if (
        snapshot.revision ===
        (await this.authorizationRevision({ fresh: true }))
      ) {
        return { paths: allowed, revision: snapshot.revision };
      }
    }
  }

  async browse(inputPath?: string): Promise<WorkspaceBrowseResponse> {
    return browseWorkspaceDirectories(await this.list(), inputPath, homedir());
  }
}

function readRoots(database: import("sql.js").Database): string[] {
  const statement = database.prepare(
    "SELECT path FROM workspace_roots ORDER BY path",
  );
  try {
    const roots: string[] = [];
    while (statement.step()) roots.push(String(statement.get()[0]));
    return roots;
  } finally {
    statement.free();
  }
}

function readDefaultRoot(
  database: import("sql.js").Database,
): string | undefined {
  const result = database.exec(
    "SELECT default_path FROM workspace_settings WHERE id = 1",
  );
  const value = result[0]?.values[0]?.[0];
  return typeof value === "string" ? value : undefined;
}

function readAuthorizationRevision(
  database: import("sql.js").Database,
): number {
  const result = database.exec(
    "SELECT revision FROM workspace_authorization_state WHERE id = 1",
  );
  const revision = Number(result[0]?.values[0]?.[0] ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Invalid workspace authorization revision");
  }
  return revision;
}

function incrementAuthorizationRevision(
  database: import("sql.js").Database,
): void {
  database.run(
    `UPDATE workspace_authorization_state
        SET revision = revision + 1
      WHERE id = 1`,
  );
  if (database.getRowsModified() !== 1) {
    throw new Error("Workspace authorization revision is unavailable");
  }
}

function cacheAuthorizationRevision(
  state: HostStateStore,
  revision: number,
): void {
  authorizationCaches.set(state, { revision, checkedAt: Date.now() });
}

export async function resolveWorkspacePath(
  workspaceRoots: readonly string[],
  inputPath: string,
): Promise<string> {
  const candidate = await resolveExistingDirectory(inputPath);
  const allowed = workspaceRoots.some((root) => isWithin(root, candidate));
  if (!allowed) {
    throw new Error(`Path is outside registered workspace roots: ${candidate}`);
  }
  return candidate;
}

export function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function browseWorkspaceDirectories(
  workspaceRoots: readonly string[],
  inputPath: string | undefined,
  homePath: string,
): Promise<WorkspaceBrowseResponse> {
  const home = await resolveExistingDirectory(homePath);
  const anchors = [...new Set([home, ...workspaceRoots])];
  const current = await resolveExistingDirectory(inputPath ?? home);
  if (!anchors.some((anchor) => isWithin(anchor, current))) {
    throw new Error(`Path is outside browsable directories: ${current}`);
  }

  const entries = (await readdir(current, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories: Array<{ name: string; path: string }> = [];
  for (const entry of entries.slice(0, MAX_BROWSE_DIRECTORIES)) {
    try {
      const candidate = await resolveExistingDirectory(
        join(current, entry.name),
      );
      if (!anchors.some((anchor) => isWithin(anchor, candidate))) continue;
      directories.push({ name: entry.name, path: candidate });
    } catch {
      // Skip unreadable entries, broken links, and non-directory symlinks.
    }
  }

  const parentCandidate = dirname(current);
  const parent =
    parentCandidate !== current &&
    anchors.some((anchor) => isWithin(anchor, parentCandidate))
      ? parentCandidate
      : undefined;
  return {
    path: current,
    home,
    ...(parent ? { parent } : {}),
    directories,
    truncated: entries.length > MAX_BROWSE_DIRECTORIES,
  };
}

async function resolveExistingDirectory(inputPath: string): Promise<string> {
  const canonical = await realpath(resolve(inputPath));
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${canonical}`);
  }
  return canonical;
}
