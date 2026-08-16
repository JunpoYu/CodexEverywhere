import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { GatewayV2Error } from "@codex-everywhere/protocol/v2";

import {
  browseWorkspaceDirectories,
  isWithin,
  resolveWorkspacePath,
} from "../../host/workspaces.js";
import {
  WorkspaceInUseError,
  type WorkspaceRecord,
  type WorkspaceRepository,
  WorkspaceRevisionConflictError,
} from "../repositories/workspace-repository.js";

export interface WorkspaceView {
  readonly version: 1;
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly revision: number;
}

export class WorkspaceService {
  readonly #repository: WorkspaceRepository;
  readonly #home: string;

  constructor(
    repository: WorkspaceRepository,
    options: { readonly home?: string } = {},
  ) {
    this.#repository = repository;
    this.#home = options.home ?? homedir();
  }

  async list(): Promise<WorkspaceView[]> {
    return (await this.#repository.list()).map(workspaceView);
  }

  async get(id: string): Promise<WorkspaceView> {
    const workspace = (await this.#repository.list()).find(
      (candidate) => candidate.id === id,
    );
    if (workspace === undefined) {
      throw new GatewayV2Error("WORKSPACE_NOT_FOUND", "Workspace not found");
    }
    return workspaceView(workspace);
  }

  async add(path: string, label?: string): Promise<WorkspaceView> {
    const canonical = await existingDirectory(path);
    const workspace = await this.#repository.add({
      path: canonical,
      label: label ?? (basename(canonical) || canonical),
    });
    return workspaceView(workspace);
  }

  async remove(id: string, expectedRevision: number): Promise<boolean> {
    try {
      return await this.#repository.remove(id, expectedRevision);
    } catch (error) {
      if (error instanceof WorkspaceRevisionConflictError) {
        throw new GatewayV2Error(
          "REVISION_CONFLICT",
          "Workspace changed; refresh before removing it",
        );
      }
      if (error instanceof WorkspaceInUseError) {
        throw new GatewayV2Error(
          "WORKSPACE_IN_USE",
          "Workspace has unfinished Queue items",
        );
      }
      throw error;
    }
  }

  defaultId(): Promise<string | undefined> {
    return this.#repository.defaultId();
  }

  setDefault(id: string): Promise<string> {
    return this.#repository.setDefault(id).catch((error: unknown) => {
      if (error instanceof WorkspaceRevisionConflictError) {
        throw new GatewayV2Error("WORKSPACE_NOT_FOUND", "Workspace not found");
      }
      throw error;
    });
  }

  async browse(path?: string): Promise<{
    readonly path: string;
    readonly parent?: string;
    readonly entries: {
      readonly version: 1;
      readonly name: string;
      readonly path: string;
      readonly kind: "directory";
      readonly selectable: true;
    }[];
  }> {
    const snapshot = await this.#repository.authorizationSnapshot();
    const result = await browseWorkspaceDirectories(
      snapshot.roots,
      path,
      this.#home,
    );
    return {
      path: result.path,
      ...(result.parent === undefined ? {} : { parent: result.parent }),
      entries: result.directories.map((directory) => ({
        version: 1,
        name: directory.name,
        path: directory.path,
        kind: "directory" as const,
        selectable: true as const,
      })),
    };
  }

  async resolve(path: string): Promise<string> {
    while (true) {
      const snapshot = await this.#repository.authorizationSnapshot();
      const canonical = await resolveWorkspacePath(snapshot.roots, path);
      const current = await this.#repository.authorizationSnapshot();
      if (current.revision === snapshot.revision) return canonical;
    }
  }

  async workspaceForPath(path: string): Promise<WorkspaceView> {
    const canonical = await this.resolve(path);
    const workspaces = await this.#repository.list();
    const matching = workspaces
      .filter((workspace) => isWithin(workspace.path, canonical))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (matching === undefined) {
      throw new GatewayV2Error(
        "WORKSPACE_NOT_AUTHORIZED",
        "Task path is outside registered workspaces",
      );
    }
    return workspaceView(matching);
  }
}

function workspaceView(record: WorkspaceRecord): WorkspaceView {
  return {
    version: 1,
    id: record.id,
    path: record.path,
    label: record.label,
    isDefault: record.isDefault,
    revision: record.revision,
  };
}

async function existingDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) {
    throw new GatewayV2Error(
      "INVALID_WORKSPACE",
      "Workspace path is not a directory",
    );
  }
  return canonical;
}
