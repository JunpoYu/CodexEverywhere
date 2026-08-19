import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import {
  CodexAppServerClient,
  CodexRpcError,
} from "../../runtime/codex-app-server-client.js";
import { GatewayV2Error } from "@codex-everywhere/protocol/v2";

export interface CodexClient {
  request<Result = unknown>(
    method: string,
    params?: unknown,
    options?: { readonly timeoutMs?: number },
  ): Promise<Result>;
  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void;
  onServerRequest(listener: (request: CodexServerRequest) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}

export class CodexClientAdapter implements CodexClient {
  readonly #client: CodexAppServerClient;

  constructor(client: CodexAppServerClient) {
    this.#client = client;
  }

  async request<Result = unknown>(
    method: string,
    params?: unknown,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<Result> {
    try {
      return await this.#client.request(method, params, options);
    } catch (error) {
      if (error instanceof CodexRpcError) {
        // A JSON-RPC error response proves that app-server rejected the
        // request. Keep transport loss distinct so durable mutations only
        // become indeterminate when their side effect really is ambiguous.
        throw new GatewayV2Error(
          "CODEX_REQUEST_REJECTED",
          "Codex app-server rejected the request",
          { cause: error },
        );
      }
      throw error;
    }
  }

  onNotification(
    listener: (notification: CodexNotification) => void,
  ): () => void {
    this.#client.on("notification", listener);
    return () => this.#client.off("notification", listener);
  }

  onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.#client.on("serverRequest", listener);
    return () => this.#client.off("serverRequest", listener);
  }

  onClose(listener: () => void): () => void {
    this.#client.on("close", listener);
    return () => this.#client.off("close", listener);
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}
