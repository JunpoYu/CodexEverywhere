import { EventEmitter } from "node:events";
import { createConnection } from "node:net";

import WebSocket from "ws";

export type JsonRpcId = number | string;

export type CodexNotification<T = unknown> = {
  method: string;
  params: T;
};

export type CodexServerRequest<T = unknown> = {
  id: JsonRpcId;
  method: string;
  params: T;
  respond: (result: unknown) => void;
  reject: (error: { code: number; message: string; data?: unknown }) => void;
};

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
};

type RpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type ClientEvents = {
  close: [];
  notification: [CodexNotification];
  serverRequest: [CodexServerRequest];
};

export type InitializeOptions = {
  name?: string;
  title?: string;
  version?: string;
  experimentalApi?: boolean;
  timeoutMs?: number;
};

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcError) {
    super(error.message);
    this.name = "CodexRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class CodexAppServerClient extends EventEmitter<ClientEvents> {
  readonly #socket: WebSocket;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextRequestId = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    super();
    this.#socket = socket;
    socket.on("message", (data) => this.#handleMessage(data.toString()));
    socket.on("close", () => this.#handleClose());
    socket.on("error", (error) => this.#handleTransportError(error));
  }

  static async connectUnix(
    socketPath: string,
    options: InitializeOptions = {},
  ): Promise<CodexAppServerClient> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = new WebSocket("ws://localhost", {
      createConnection: () => createConnection({ path: socketPath }),
      perMessageDeflate: false,
    });
    const client = new CodexAppServerClient(socket);
    try {
      await waitForWebSocketOpen(socket, timeoutMs);
      await withTimeout(
        client.request("initialize", {
          clientInfo: {
            name: options.name ?? "codex_everywhere_agent",
            title: options.title ?? "CodexEverywhere Agent",
            version: options.version ?? "0.0.0",
          },
          capabilities: { experimentalApi: options.experimentalApi ?? false },
        }),
        timeoutMs,
        "initialize Codex app-server",
      );
    } catch (error) {
      client.#socket.terminate();
      throw error;
    }
    client.notify("initialized", {});
    return client;
  }

  get closed(): boolean {
    return this.#closed;
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.#closed)
      return Promise.reject(new Error("Codex app-server connection is closed"));

    const id = this.#nextRequestId++;
    const message =
      params === undefined ? { id, method } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: (result) => resolve(result as T),
        reject,
      };
      if (options.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          reject(
            new Error(
              `Timed out waiting for Codex app-server response: ${method}`,
            ),
          );
        }, options.timeoutMs);
      }
      this.#pending.set(id, pending);
      try {
        this.#send(message);
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const message = params === undefined ? { method } : { method, params };
    this.#send(message);
  }

  waitForNotification<T = unknown>(
    predicate: (notification: CodexNotification<T>) => boolean,
    timeoutMs = 30_000,
  ): Promise<CodexNotification<T>> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("notification", handleNotification);
        reject(
          new Error(
            `Timed out waiting for Codex notification after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const handleNotification = (notification: CodexNotification) => {
        const typed = notification as CodexNotification<T>;
        if (!predicate(typed)) return;
        clearTimeout(timeout);
        this.off("notification", handleNotification);
        resolve(typed);
      };

      this.on("notification", handleNotification);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const closed = new Promise<void>((resolve) => this.once("close", resolve));
    this.#socket.close();
    await closed;
  }

  #send(message: unknown): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server connection is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }

  #handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (isJsonRpcId(message.id) && typeof message.method !== "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (isRpcError(message.error))
        pending.reject(new CodexRpcError(message.error));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    const params = message.params;

    if (isJsonRpcId(message.id)) {
      const request: CodexServerRequest = {
        id: message.id,
        method: message.method,
        params,
        respond: (result) => this.#send({ id: message.id, result }),
        reject: (error) => this.#send({ id: message.id, error }),
      };
      this.emit("serverRequest", request);
      return;
    }

    this.emit("notification", { method: message.method, params });
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Codex app-server connection closed");
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("close");
  }

  #handleTransportError(error: Error): void {
    if (this.#closed) return;
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function waitForWebSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
      if (error) reject(error);
      else resolve();
    };
    const handleOpen = () => finish();
    const handleError = (error: Error) => finish(error);
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Timed out connecting to Codex app-server after ${timeoutMs}ms`,
        ),
      );
      // CodexAppServerClient installs its transport error listener before this
      // timer starts. Terminating a CONNECTING ws can therefore never emit an
      // unhandled "closed before the connection was established" error.
      socket.terminate();
    }, timeoutMs);
    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out trying to ${operation} after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function isRpcError(value: unknown): value is RpcError {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string"
  );
}
