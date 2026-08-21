import { Scope } from "@codex-everywhere/kernel";
import type { InputOf, OutputOf } from "@codex-everywhere/protocol/v2";

import {
  parseCodexObject,
  requireCodexObject,
  type CodexObject,
} from "../codex/codex-json.js";
import {
  type StoredThreadSettings,
  type ThreadSettingsRepository,
  ThreadSettingsRevisionConflictError,
} from "../repositories/thread-settings-repository.js";
import type {
  AuthoritativeThreadState,
  ThreadLease,
  ThreadLeaseHandle,
} from "./thread-lease-manager.js";
import {
  codexSandboxPolicy,
  mergeStoredThreadPermissions,
  runtimeThreadSettings,
  threadSettingsRevisionConflict,
  threadSettingsView,
  type RuntimeThreadSettings,
} from "./thread-settings.js";
import type { WorkspaceService } from "./workspace-service.js";

type ThreadSettingsView = OutputOf<"thread/settings/update">;

export interface ThreadSessionCoordinatorOptions {
  readonly scope: Scope;
  readonly settings: ThreadSettingsRepository;
  readonly workspaces: WorkspaceService;
}

export interface OpenThreadSessionSnapshot {
  readonly thread: CodexObject;
  readonly state: AuthoritativeThreadState;
  readonly settings: ThreadSettingsView;
}

/** Owns the per-thread resume and permission consistency boundary. */
export class ThreadSessionCoordinator {
  readonly #scope: Scope;
  readonly #settings: ThreadSettingsRepository;
  readonly #workspaces: WorkspaceService;
  readonly #runtimeSettings = new WeakMap<ThreadLease, RuntimeThreadSettings>();
  readonly #resumedLeases = new WeakSet<ThreadLease>();

  constructor(options: ThreadSessionCoordinatorOptions) {
    this.#scope = options.scope.fork("thread-sessions");
    this.#settings = options.settings;
    this.#workspaces = options.workspaces;
  }

  async open(handle: ThreadLeaseHandle): Promise<OpenThreadSessionSnapshot> {
    return this.#withMutation(handle.threadId, async () => {
      const stored = await this.#settings.read(handle.threadId);
      let runtime = this.#runtimeSettings.get(handle.lease);
      let thread: CodexObject;
      let state: AuthoritativeThreadState;
      if (!this.#resumedLeases.has(handle.lease) || runtime === undefined) {
        const response = parseCodexObject(
          await handle.lease.request("thread/resume", {
            threadId: handle.threadId,
            ...(stored.approvalPolicy === undefined
              ? {}
              : { approvalPolicy: stored.approvalPolicy }),
            ...(stored.sandbox === undefined
              ? {}
              : { sandbox: stored.sandbox }),
          }),
          "thread/resume response",
        );
        thread = requireCodexObject(response.thread, "resumed thread");
        state = handle.lease.adoptAuthoritativeThread(thread);
        runtime = mergeStoredThreadPermissions(
          runtimeThreadSettings(response, stored),
          stored,
        );
        this.#runtimeSettings.set(handle.lease, runtime);
        this.#resumedLeases.add(handle.lease);
      } else {
        runtime = mergeStoredThreadPermissions(runtime, stored);
        this.#runtimeSettings.set(handle.lease, runtime);
        state = await handle.lease.synchronize(true);
        thread = requireCodexObject(state.thread, "thread");
      }
      return {
        thread,
        state,
        settings: threadSettingsView(stored.revision, runtime),
      };
    });
  }

  async rememberStarted(input: {
    readonly threadId: string;
    readonly started: CodexObject;
    readonly sandbox: NonNullable<RuntimeThreadSettings["sandbox"]>;
    readonly approvalPolicy: NonNullable<
      RuntimeThreadSettings["approvalPolicy"]
    >;
    readonly model?: string;
    readonly effort?: RuntimeThreadSettings["effort"];
  }): Promise<RuntimeThreadSettings> {
    const stored = await this.#settings.save(input.threadId, 0, {
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
    });
    return {
      ...runtimeThreadSettings(input.started, stored),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
    };
  }

  markResumed(lease: ThreadLease, runtime?: RuntimeThreadSettings): void {
    this.#resumedLeases.add(lease);
    if (runtime !== undefined) this.#runtimeSettings.set(lease, runtime);
  }

  async updateSettings(
    handle: ThreadLeaseHandle,
    input: InputOf<"thread/settings/update">,
  ): Promise<ThreadSettingsView> {
    return this.#withMutation(handle.threadId, async () => {
      const stored = await this.#settings.read(handle.threadId);
      if (stored.revision !== input.expectedRevision) {
        throw threadSettingsRevisionConflict();
      }
      const state = await handle.lease.synchronize(false);
      await this.#workspaces.resolve(state.workspacePath);
      let runtime = this.#runtimeSettings.get(handle.lease);
      if (runtime === undefined) {
        const resumed = parseCodexObject(
          await handle.lease.request("thread/resume", {
            threadId: handle.threadId,
            ...(stored.approvalPolicy === undefined
              ? {}
              : { approvalPolicy: stored.approvalPolicy }),
            ...(stored.sandbox === undefined
              ? {}
              : { sandbox: stored.sandbox }),
          }),
          "thread/resume response",
        );
        runtime = runtimeThreadSettings(resumed, stored);
        this.#resumedLeases.add(handle.lease);
      }
      runtime = mergeStoredThreadPermissions(runtime, stored);
      const next: RuntimeThreadSettings = {
        ...runtime,
        ...(input.patch.model === undefined
          ? {}
          : { model: input.patch.model }),
        ...(input.patch.effort === undefined
          ? {}
          : { effort: input.patch.effort }),
        ...(input.patch.sandbox === undefined
          ? {}
          : { sandbox: input.patch.sandbox }),
        ...(input.patch.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: input.patch.approvalPolicy }),
      };
      await handle.lease.request("thread/settings/update", {
        threadId: handle.threadId,
        ...(input.patch.model === undefined
          ? {}
          : { model: input.patch.model }),
        ...(input.patch.effort === undefined
          ? {}
          : { effort: input.patch.effort }),
        ...(input.patch.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: input.patch.approvalPolicy }),
        ...(input.patch.sandbox === undefined
          ? {}
          : { sandboxPolicy: codexSandboxPolicy(input.patch.sandbox) }),
      });
      let saved: StoredThreadSettings;
      try {
        saved = await this.#settings.save(handle.threadId, stored.revision, {
          ...(next.sandbox === undefined ? {} : { sandbox: next.sandbox }),
          ...(next.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: next.approvalPolicy }),
        });
      } catch (error) {
        if (error instanceof ThreadSettingsRevisionConflictError) {
          throw threadSettingsRevisionConflict();
        }
        throw error;
      }
      this.#runtimeSettings.set(handle.lease, next);
      return threadSettingsView(saved.revision, next);
    });
  }

  async remove(threadId: string): Promise<void> {
    await this.#settings.remove(threadId);
  }

  async #withMutation<Result>(
    threadId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const mutation = await this.#settings.acquireMutation(threadId, {
      signal: this.#scope.signal,
    });
    try {
      return await operation();
    } finally {
      await mutation.release();
    }
  }
}
