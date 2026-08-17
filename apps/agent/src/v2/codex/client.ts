import type {
  CodexNotification,
  CodexServerRequest,
} from "../../runtime/codex-app-server-client.js";
import { CodexAppServerClient } from "../../runtime/codex-app-server-client.js";

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

  request<Result = unknown>(
    method: string,
    params?: unknown,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<Result> {
    return this.#client.request(method, params, options);
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
