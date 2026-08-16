import { Scope } from "@codex-everywhere/kernel";

import type { SavedHost } from "../storage.js";
import { createAdminActor } from "./actors/admin-actor.js";
import { createConnectionActor } from "./actors/connection-actor.js";
import type { GatewayPort } from "./gateway/gateway-port.js";

/**
 * Administrator composition root. It deliberately has no dependency on task,
 * Queue, Workspace, onboarding, Composer, or thread actors.
 */
export class AdminWebRuntime {
  readonly scope = new Scope("web-v0.4-admin");
  readonly connection = createConnectionActor(this.scope);
  readonly admin;
  readonly gateway: GatewayPort;
  readonly host: SavedHost;

  constructor(input: {
    readonly gateway: GatewayPort;
    readonly host: SavedHost;
  }) {
    if (input.host.kind !== "admin") {
      throw new Error("Administrator runtime requires an administrator host");
    }
    this.gateway = input.gateway;
    this.host = input.host;
    this.admin = createAdminActor(this.scope, input.gateway);
    this.scope.defer(
      input.gateway.onConnectionLost((error) => {
        this.connection.dispatch({ type: "LOST", message: error.message });
        if (error.name === "GatewayUpgradeRequiredError") {
          this.connection.dispatch({
            type: "UPGRADE_REQUIRED",
            message: error.message,
          });
        } else if (error.name !== "GatewayReauthenticationRequiredError") {
          this.connection.dispatch({ type: "RECONNECTING" });
        }
        this.admin.dispatch({ type: "FAILED", message: error.message });
      }),
    );
    this.scope.defer(
      input.gateway.onConnectionRestored(() => {
        this.connection.dispatch({
          type: "CONNECTED",
          hostName: this.host.name,
        });
        this.admin.dispatch({ type: "LOAD" });
      }),
    );
  }

  start(): void {
    this.connection.dispatch({ type: "CONNECTED", hostName: this.host.name });
    this.admin.dispatch({ type: "LOAD" });
  }

  async close(): Promise<void> {
    await this.gateway.close();
    await this.scope.close("admin-web-runtime-closed");
  }
}
