import { Scope } from "@codex-everywhere/kernel";

import { CodexAppServerClient } from "../../runtime/codex-app-server-client.js";
import { CodexClientAdapter, type CodexClient } from "./client.js";

export interface CodexClientConnector {
  connect(): Promise<CodexAppServerClient>;
}

/** Creates one app-server JSON-RPC client per lease-owned Scope. */
export class CodexClientFactory {
  readonly #connector: CodexClientConnector;

  constructor(connector: CodexClientConnector) {
    this.#connector = connector;
  }

  async create(scope: Scope): Promise<CodexClient> {
    scope.throwIfClosed();
    const client = new CodexClientAdapter(await this.#connector.connect());
    try {
      scope.defer(() => client.close());
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

export interface CodexClientFactoryPort {
  create(scope: Scope): Promise<CodexClient>;
}
