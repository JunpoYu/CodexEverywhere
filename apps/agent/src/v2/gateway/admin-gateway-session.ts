import { randomUUID } from "node:crypto";

import { Scope } from "@codex-everywhere/kernel";
import type {
  GatewayAccess,
  GatewayRequestContext,
} from "@codex-everywhere/protocol/v2";

import type {
  GatewayDeviceBinding,
  IdentityGatewayContext,
  IdentityGatewaySession,
} from "./identity-gateway-context.js";

export interface AdminGatewaySessionOptions {
  readonly parentScope: Scope;
  readonly id?: string;
  readonly access?: GatewayAccess;
  readonly principalId?: string;
  readonly temporary?: boolean;
  readonly device?: GatewayDeviceBinding;
  readonly assertDeviceCurrent?: () => void | Promise<void>;
}

/** Admin sessions deliberately expose no user task, Queue or Workspace state. */
export class AdminGatewaySession implements IdentityGatewaySession {
  readonly id: string;
  readonly scope: Scope;
  readonly device: GatewayDeviceBinding | undefined;
  readonly #assertDeviceCurrent: (() => void | Promise<void>) | undefined;
  #access: GatewayAccess;
  #principalId: string;
  #temporary: boolean;

  constructor(input: AdminGatewaySessionOptions) {
    this.id = input.id ?? randomUUID();
    this.scope = input.parentScope.fork(`admin-gateway-session-${this.id}`);
    this.device = input.device;
    this.#assertDeviceCurrent = input.assertDeviceCurrent;
    this.#access = input.access ?? "pre-auth";
    this.#principalId = input.principalId ?? `pre-auth:${this.id}`;
    this.#temporary = input.temporary ?? true;
  }

  get access(): GatewayAccess {
    return this.#access;
  }

  get principalId(): string {
    return this.#principalId;
  }

  get temporary(): boolean {
    return this.#temporary;
  }

  async assertCurrent(): Promise<void> {
    this.scope.throwIfClosed();
    if (this.#access === "admin" && !this.#temporary) {
      await this.#assertDeviceCurrent?.();
    }
  }

  authenticate(input: {
    readonly access: "user" | "admin";
    readonly principalId: string;
    readonly temporary: boolean;
  }): void {
    this.scope.throwIfClosed();
    if (input.access !== "admin") {
      throw new Error("Administrator session cannot authenticate a user");
    }
    this.#access = "admin";
    this.#principalId = input.principalId;
    this.#temporary = input.temporary;
  }

  close(): Promise<void> {
    return this.scope.close("admin-gateway-session-closed");
  }
}

export interface AdminGatewayContext extends IdentityGatewayContext {
  readonly session: AdminGatewaySession;
}

export function adminGatewayContext(input: {
  readonly session: AdminGatewaySession;
  readonly capabilities?: ReadonlySet<string>;
}): AdminGatewayContext {
  return {
    get access() {
      return input.session.access;
    },
    get principalId() {
      return input.session.principalId;
    },
    capabilities: input.capabilities ?? new Set(),
    signal: input.session.scope.signal,
    assertCurrent: () => input.session.assertCurrent(),
    session: input.session,
    get temporary() {
      return input.session.temporary;
    },
  } satisfies GatewayRequestContext & AdminGatewayContext;
}
