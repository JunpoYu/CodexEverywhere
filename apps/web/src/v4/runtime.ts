import { Scope } from "@codex-everywhere/kernel";
import { parseGatewayEventPayload } from "@codex-everywhere/protocol/v2";

import type { SavedHost } from "../storage.js";
import { createComposerActor } from "./actors/composer-actor.js";
import { createConnectionActor } from "./actors/connection-actor.js";
import { createOnboardingActor } from "./actors/onboarding-actor.js";
import { createQueueActor } from "./actors/queue-actor.js";
import { createTaskListActor } from "./actors/task-list-actor.js";
import { createThreadActor } from "./actors/thread-actor.js";
import type { GatewayPort } from "./gateway/gateway-port.js";

/** User composition root. Administrator routes never instantiate this class. */
export class UserWebRuntime {
  readonly scope = new Scope("web-v0.4");
  readonly connection = createConnectionActor(this.scope);
  readonly onboarding;
  readonly tasks;
  readonly thread;
  readonly composer;
  readonly queue;
  readonly gateway: GatewayPort;
  readonly host: SavedHost;
  #threadRefreshScope: Scope | undefined;

  constructor(input: {
    readonly gateway: GatewayPort;
    readonly host: SavedHost;
  }) {
    if (input.host.kind === "admin") {
      throw new Error("User runtime cannot connect an administrator host");
    }
    this.gateway = input.gateway;
    this.host = input.host;
    this.onboarding = createOnboardingActor(this.scope, input.gateway);
    this.tasks = createTaskListActor(this.scope, input.gateway);
    this.thread = createThreadActor(this.scope, input.gateway);
    this.composer = createComposerActor(this.scope, input.gateway);
    this.queue = createQueueActor(this.scope, input.gateway);
    this.scope.defer(
      input.gateway.onConnectionLost((error) => {
        this.connection.dispatch({ type: "LOST", message: error.message });
        if (error.name === "GatewayUpgradeRequiredError") {
          this.connection.dispatch({
            type: "UPGRADE_REQUIRED",
            message: error.message,
          });
          return;
        }
        if (error.name === "GatewayReauthenticationRequiredError") {
          return;
        }
        this.connection.dispatch({ type: "RECONNECTING" });
        this.thread.dispatch({ type: "RECONNECTING" });
      }),
    );
    this.scope.defer(
      input.gateway.onConnectionRestored(() =>
        this.#restoreAuthoritativeState(),
      ),
    );
    this.scope.defer(
      input.gateway.onEvent((event) => {
        this.thread.dispatch({ type: "GATEWAY_EVENT", event });
        if (event.type === "queue/changed") {
          this.queue.dispatch({
            type: "CHANGED",
            item: parseGatewayEventPayload("queue/changed", event.payload).item,
          });
        } else if (event.type === "queue/removed") {
          this.queue.dispatch({
            type: "REMOVED",
            itemId: parseGatewayEventPayload("queue/removed", event.payload)
              .itemId,
          });
        } else if (event.type === "setup/codex/login/completed") {
          this.onboarding.dispatch({
            type: "LOGIN_COMPLETED",
            completion: parseGatewayEventPayload(event.type, event.payload),
          });
          this.onboarding.dispatch({ type: "INSPECT" });
        } else if (event.type === "setup/codex/install/progress") {
          const progress = parseGatewayEventPayload(
            "setup/codex/install/progress",
            event.payload,
          );
          this.onboarding.dispatch({ type: "INSTALL_PROGRESS", progress });
          if (progress.phase === "completed" || progress.phase === "failed") {
            this.onboarding.dispatch({ type: "INSPECT" });
          }
        }
        const payload = event.payload as Record<string, unknown>;
        if (
          (event.type === "codex/notification" ||
            event.type === "codex/generic") &&
          payload.threadId === this.thread.getSnapshot().threadId
        ) {
          this.#scheduleThreadRefresh(String(payload.threadId));
        }
      }),
    );
  }

  start(): void {
    this.connection.dispatch({ type: "CONNECTED", hostName: this.host.name });
    this.onboarding.dispatch({ type: "INSPECT" });
    this.tasks.dispatch({ type: "LOAD" });
    this.queue.dispatch({ type: "LOAD" });
  }

  async close(): Promise<void> {
    await this.#threadRefreshScope?.close("web-runtime-closed");
    this.#threadRefreshScope = undefined;
    await this.gateway.close();
    await this.scope.close("web-runtime-closed");
  }

  #scheduleThreadRefresh(threadId: string): void {
    if (this.#threadRefreshScope !== undefined) return;
    const refreshScope = this.scope.fork("thread-refresh");
    this.#threadRefreshScope = refreshScope;
    refreshScope.setTimeout(() => {
      if (this.#threadRefreshScope === refreshScope) {
        this.#threadRefreshScope = undefined;
      }
      this.thread.dispatch({ type: "OPEN", threadId });
      void refreshScope.close("thread-refresh-complete");
    }, 100);
  }

  #restoreAuthoritativeState(): void {
    this.connection.dispatch({ type: "CONNECTED", hostName: this.host.name });
    this.onboarding.dispatch({ type: "INSPECT" });
    this.tasks.dispatch({ type: "LOAD" });
    this.queue.dispatch({ type: "LOAD" });
    const threadId = this.thread.getSnapshot().threadId;
    if (threadId !== undefined) {
      this.thread.dispatch({ type: "OPEN", threadId });
    }
    const operationKey = this.composer.getSnapshot().operationKey;
    if (operationKey !== undefined) {
      this.composer.dispatch({ type: "RECONCILE", operationKey });
    }
  }
}
