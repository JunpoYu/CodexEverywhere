import type {
  ModelListParams,
  ModelListResponse,
  ThreadArchiveParams,
  ThreadArchiveResponse,
  ThreadDeleteParams,
  ThreadDeleteResponse,
  ThreadListParams,
  ThreadListResponse,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadSetNameParams,
  ThreadSetNameResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "@codex-everywhere/codex-app-server-schema/v2";

import {
  CodexAppServerClient,
  type CodexNotification,
  type CodexServerRequest,
} from "./codex-app-server-client.js";

export class CodexRuntime {
  readonly #client: CodexAppServerClient;

  constructor(client: CodexAppServerClient) {
    this.#client = client;
  }

  get closed(): boolean {
    return this.#client.closed;
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

  listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return this.#client.request("thread/list", params);
  }

  readThread(params: ThreadReadParams): Promise<ThreadReadResponse> {
    return this.#client.request("thread/read", params);
  }

  startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.#client.request("thread/start", params);
  }

  resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.#client.request("thread/resume", params);
  }

  nameThread(params: ThreadSetNameParams): Promise<ThreadSetNameResponse> {
    return this.#client.request("thread/name/set", params);
  }

  archiveThread(params: ThreadArchiveParams): Promise<ThreadArchiveResponse> {
    return this.#client.request("thread/archive", params);
  }

  deleteThread(params: ThreadDeleteParams): Promise<ThreadDeleteResponse> {
    return this.#client.request("thread/delete", params);
  }

  startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.#client.request("turn/start", params);
  }

  steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
    return this.#client.request("turn/steer", params);
  }

  interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
    return this.#client.request("turn/interrupt", params);
  }

  listModels(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.#client.request("model/list", params);
  }

  waitForNotification<T = unknown>(
    predicate: (notification: CodexNotification<T>) => boolean,
    timeoutMs?: number,
  ): Promise<CodexNotification<T>> {
    return this.#client.waitForNotification(predicate, timeoutMs);
  }

  close(): Promise<void> {
    return this.#client.close();
  }
}
