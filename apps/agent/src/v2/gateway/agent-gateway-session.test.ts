import { Scope } from "@codex-everywhere/kernel";
import { afterEach, describe, expect, it } from "vitest";

import type { CodexClient } from "../codex/client.js";
import type { CodexClientFactoryPort } from "../codex/client-factory.js";
import { ThreadLeaseManager } from "../services/thread-lease-manager.js";
import { AgentGatewaySession } from "./agent-gateway-session.js";

const scopes: Scope[] = [];

afterEach(async () => {
  await Promise.allSettled(
    scopes.splice(0).map((scope) => scope.close("test-complete")),
  );
});

describe("AgentGatewaySession", () => {
  it("shares one in-flight thread open within a Gateway session", async () => {
    const { factory, manager, session } = createSession();

    const first = session.openThread("thread-1");
    await factory.creationRequested;
    const second = session.openThread("thread-1");
    factory.allowCreation();

    const [firstHandle, secondHandle] = await Promise.all([first, second]);

    expect(firstHandle).toBe(secondHandle);
    expect(firstHandle.lease.referenceCount).toBe(1);
    expect(factory.clients).toHaveLength(1);

    await session.closeThread("thread-1");
    await eventually(() => manager.size === 0 && factory.clients[0]!.closed);
  });

  it("waits for an in-flight open before closing the thread", async () => {
    const { factory, manager, session } = createSession();

    const opening = session.openThread("thread-1");
    await factory.creationRequested;
    const closing = session.closeThread("thread-1");
    factory.allowCreation();

    await Promise.all([opening, closing]);
    await eventually(() => manager.size === 0 && factory.clients[0]!.closed);
    expect(() => session.requireThread("thread-1")).toThrow(
      "Task must be opened",
    );
  });

  it("waits for an in-flight close before reopening the thread", async () => {
    const { factory, session } = createSession();
    const opening = session.openThread("thread-1");
    await factory.creationRequested;
    factory.allowCreation();
    const first = await opening;
    const allowClose = factory.clients[0]!.deferClose();

    const closing = session.closeThread("thread-1");
    await eventually(() => factory.clients[0]!.closeRequested);
    let reopened = false;
    const reopening = session.openThread("thread-1").then((handle) => {
      reopened = true;
      return handle;
    });
    await Promise.resolve();

    expect(reopened).toBe(false);
    expect(factory.clients).toHaveLength(1);
    allowClose();
    await closing;
    const second = await reopening;

    expect(second).not.toBe(first);
    expect(factory.clients).toHaveLength(2);
  });

  it("replaces a dead lease on the next thread open", async () => {
    const { factory, manager, session } = createSession();
    const opening = session.openThread("thread-1");
    await factory.creationRequested;
    factory.allowCreation();
    const first = await opening;

    factory.clients[0]!.disconnect();
    await eventually(() => first.lease.closed && manager.size === 0);
    const second = await session.openThread("thread-1");

    expect(second).not.toBe(first);
    expect(second.lease.closed).toBe(false);
    expect(factory.clients).toHaveLength(2);
  });
});

class GatedFactory implements CodexClientFactoryPort {
  readonly clients: FakeCodexClient[] = [];
  readonly creationRequested: Promise<void>;
  readonly #gate: Promise<void>;
  readonly #allowCreation: () => void;

  constructor() {
    let markRequested: (() => void) | undefined;
    let allowCreation: (() => void) | undefined;
    this.creationRequested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    this.#gate = new Promise<void>((resolve) => {
      allowCreation = resolve;
    });
    this.#allowCreation = () => allowCreation?.();
    this.#markRequested = () => markRequested?.();
  }

  readonly #markRequested: () => void;

  allowCreation(): void {
    this.#allowCreation();
  }

  async create(scope: Scope): Promise<CodexClient> {
    this.#markRequested();
    await this.#gate;
    const client = new FakeCodexClient();
    this.clients.push(client);
    scope.defer(() => client.close());
    return client;
  }
}

class FakeCodexClient implements CodexClient {
  closed = false;
  closeRequested = false;
  #closeGate: Promise<void> = Promise.resolve();
  readonly #closeListeners = new Set<() => void>();

  request<Result = unknown>(): Promise<Result> {
    return Promise.resolve({} as Result);
  }

  onNotification(): () => void {
    return () => undefined;
  }

  onServerRequest(): () => void {
    return () => undefined;
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  deferClose(): () => void {
    let allow: (() => void) | undefined;
    this.#closeGate = new Promise<void>((resolve) => {
      allow = resolve;
    });
    return () => allow?.();
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    await this.#closeGate;
    this.closed = true;
    for (const listener of [...this.#closeListeners]) listener();
  }

  disconnect(): void {
    this.closed = true;
    for (const listener of [...this.#closeListeners]) listener();
  }
}

function createSession(): {
  readonly factory: GatedFactory;
  readonly manager: ThreadLeaseManager;
  readonly session: AgentGatewaySession;
} {
  const scope = new Scope("agent-gateway-session-test");
  scopes.push(scope);
  const factory = new GatedFactory();
  const manager = new ThreadLeaseManager({
    scope,
    clientFactory: factory,
  });
  const session = new AgentGatewaySession({
    parentScope: scope,
    leases: manager,
  });
  return { factory, manager, session };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met");
}
