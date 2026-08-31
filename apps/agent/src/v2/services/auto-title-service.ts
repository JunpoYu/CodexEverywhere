import { randomUUID } from "node:crypto";

import { Scope, TypedEventBus } from "@codex-everywhere/kernel";
import type { JsonValue } from "@codex-everywhere/protocol/v2";

import { deriveAutomaticTitle } from "./auto-title.js";
import type { ThreadLeaseEvent } from "./thread-lease-manager.js";

export interface AutoTitleLeasePort {
  readonly threadId: string;
  addReference(kind: "effect", id: string): void;
  releaseReference(kind: "effect", id: string): Promise<void>;
  terminalTurnStatus(turnId: string): string | undefined;
  request<Result = unknown>(method: string, params?: unknown): Promise<Result>;
  onEvent(listener: (event: ThreadLeaseEvent) => void): () => void;
}

export interface AutoTitleServicePort {
  schedule(lease: AutoTitleLeasePort, turnId: string, prompt: string): void;
  renameManually(lease: AutoTitleLeasePort, title: string): Promise<void>;
  cancel(threadId: string): Promise<void>;
}

export interface AutoTitleServiceOptions {
  readonly scope: Scope;
  readonly deriveTitle?: (prompt: string) => string | undefined;
}

export interface AutoTitleServiceEvents {
  readonly renamed: { readonly threadId: string };
}

interface PendingAutoTitle {
  readonly lease: AutoTitleLeasePort;
  readonly referenceId: string;
  readonly threadId: string;
  readonly title: string;
  readonly turnId: string;
  unsubscribe: () => void;
  finishing: boolean;
  released: boolean;
  conflictingName?: string;
  readonly unobservedServiceNames: string[];
}

/**
 * Gives unnamed Codex threads one concise local title after a successful turn.
 * The app-server remains authoritative and any explicit name wins.
 */
export class AutoTitleService implements AutoTitleServicePort {
  readonly events = new TypedEventBus<AutoTitleServiceEvents>();
  readonly #scope: Scope;
  readonly #deriveTitle: (prompt: string) => string | undefined;
  readonly #pending = new Map<string, PendingAutoTitle>();

  constructor(options: AutoTitleServiceOptions) {
    this.#scope = options.scope.fork("auto-titles");
    this.#deriveTitle = options.deriveTitle ?? deriveAutomaticTitle;
    this.#scope.defer(() => this.events.clear());
    this.#scope.defer(async () => {
      const pending = [...this.#pending.values()];
      this.#pending.clear();
      await Promise.allSettled(pending.map((entry) => this.#release(entry)));
    });
  }

  schedule(lease: AutoTitleLeasePort, turnId: string, prompt: string): void {
    // Naming is presentation-only. It must never turn an accepted Codex turn
    // into a failed or indeterminate Gateway mutation.
    let referenceId: string | undefined;
    try {
      if (
        this.#scope.signal.aborted ||
        turnId.length === 0 ||
        this.#pending.has(lease.threadId)
      ) {
        return;
      }
      const title = this.#deriveTitle(prompt);
      if (title === undefined) return;
      referenceId = `auto-title:${turnId}:${randomUUID()}`;
      lease.addReference("effect", referenceId);
      const pending: PendingAutoTitle = {
        lease,
        referenceId,
        threadId: lease.threadId,
        title,
        turnId,
        unsubscribe: () => undefined,
        finishing: false,
        released: false,
        unobservedServiceNames: [],
      };
      pending.unsubscribe = lease.onEvent((event) =>
        this.#observe(pending, event),
      );
      this.#pending.set(lease.threadId, pending);
      const terminalStatus = lease.terminalTurnStatus(turnId);
      if (terminalStatus !== undefined) {
        this.#settle(pending, terminalStatus);
      }
    } catch {
      // A title is optional and cannot affect the user message outcome.
      if (referenceId !== undefined) {
        void lease
          .releaseReference("effect", referenceId)
          .catch(() => undefined);
      }
    }
  }

  async renameManually(
    lease: AutoTitleLeasePort,
    title: string,
  ): Promise<void> {
    await this.cancel(lease.threadId);
    await lease.request("thread/name/set", {
      threadId: lease.threadId,
      name: title,
    });
    this.#emitRenamed(lease.threadId);
  }

  async cancel(threadId: string): Promise<void> {
    const pending = this.#pending.get(threadId);
    if (pending === undefined) return;
    this.#pending.delete(threadId);
    await this.#release(pending).catch(() => undefined);
  }

  #observe(pending: PendingAutoTitle, event: ThreadLeaseEvent): void {
    if (this.#pending.get(pending.threadId) !== pending) return;
    if (event.type === "lease/failed") {
      this.#runBackground(() => this.cancel(pending.threadId));
      return;
    }
    const codexEvent = titleRelevantCodexEvent(event);
    if (codexEvent === undefined) return;
    const observedName =
      codexEvent.method === "thread/name/updated"
        ? notificationThreadName(codexEvent.params)
        : undefined;
    if (observedName !== undefined) {
      const serviceNameIndex =
        pending.unobservedServiceNames.indexOf(observedName);
      if (serviceNameIndex >= 0) {
        pending.unobservedServiceNames.splice(serviceNameIndex, 1);
        return;
      }
      if (pending.finishing) {
        if (observedName !== pending.title) {
          pending.conflictingName = observedName;
        }
        return;
      }
      // A TUI or another Web client explicitly named the thread first.
      this.#runBackground(() => this.cancel(pending.threadId));
      return;
    }
    if (codexEvent.method !== "turn/completed") return;
    const completed = completedTurn(codexEvent.params);
    if (completed?.id !== pending.turnId) return;
    this.#settle(pending, completed.status);
  }

  #settle(pending: PendingAutoTitle, status: string): void {
    this.#runBackground(() =>
      status === "completed"
        ? this.#finish(pending)
        : this.cancel(pending.threadId),
    );
  }

  async #finish(pending: PendingAutoTitle): Promise<void> {
    if (this.#pending.get(pending.threadId) !== pending || pending.finishing) {
      return;
    }
    pending.finishing = true;
    try {
      const response = await pending.lease.request("thread/read", {
        threadId: pending.threadId,
        includeTurns: false,
      });
      if (
        this.#pending.get(pending.threadId) !== pending ||
        responseThreadName(response) !== undefined ||
        pending.conflictingName !== undefined
      ) {
        return;
      }
      await this.#writePendingName(pending, pending.title);
      if (this.#pending.get(pending.threadId) !== pending) return;
      let restoredName = pending.conflictingName;
      while (restoredName !== undefined) {
        await this.#writePendingName(pending, restoredName);
        if (this.#pending.get(pending.threadId) !== pending) return;
        if (pending.conflictingName === restoredName) break;
        restoredName = pending.conflictingName;
      }
      this.#emitRenamed(pending.threadId);
    } catch {
      // Naming failure is intentionally contained; a later meaningful turn
      // may schedule another attempt while the thread remains unnamed.
    } finally {
      if (this.#pending.get(pending.threadId) === pending) {
        this.#pending.delete(pending.threadId);
      }
      await this.#release(pending).catch(() => undefined);
    }
  }

  async #release(pending: PendingAutoTitle): Promise<void> {
    if (pending.released) return;
    pending.released = true;
    pending.unsubscribe();
    await pending.lease.releaseReference("effect", pending.referenceId);
  }

  async #writePendingName(
    pending: PendingAutoTitle,
    name: string,
  ): Promise<void> {
    pending.unobservedServiceNames.push(name);
    await pending.lease.request("thread/name/set", {
      threadId: pending.threadId,
      name,
    });
  }

  #runBackground(operation: () => Promise<void>): void {
    void operation().catch(() => undefined);
  }

  #emitRenamed(threadId: string): void {
    try {
      this.events.emit("renamed", { threadId });
    } catch {
      // Task-list refresh subscribers cannot affect an app-server rename.
    }
  }
}

function completedTurn(
  params: JsonValue,
): { readonly id: string; readonly status: string } | undefined {
  if (!isRecord(params) || !isRecord(params.turn)) return undefined;
  return typeof params.turn.id === "string" &&
    typeof params.turn.status === "string"
    ? { id: params.turn.id, status: params.turn.status }
    : undefined;
}

function notificationThreadName(params: JsonValue): string | undefined {
  if (!isRecord(params) || typeof params.threadName !== "string") {
    return undefined;
  }
  const name = params.threadName.trim();
  return name.length === 0 ? undefined : name;
}

function titleRelevantCodexEvent(
  event: ThreadLeaseEvent,
): { readonly method: string; readonly params: JsonValue } | undefined {
  if (event.type === "codex/notification") {
    return { method: event.method, params: event.params };
  }
  if (event.type === "codex/generic") {
    return { method: event.payload.method, params: event.payload.params };
  }
  return undefined;
}

function responseThreadName(response: unknown): string | undefined {
  if (!isRecord(response) || !isRecord(response.thread)) return undefined;
  const name = response.thread.name;
  return typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
