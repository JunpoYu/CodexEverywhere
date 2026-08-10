import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateStaticKeyPair } from "@codex-everywhere/crypto";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { HostStateStore } from "../host/state-store.js";
import {
  RelayConnector,
  type RelayConnectorOptions,
} from "./relay-connector.js";

const temporaryDirectories: string[] = [];
const openServers: WebSocketServer[] = [];
const openConnectors: RelayConnector[] = [];
const openStates: HostStateStore[] = [];

afterEach(async () => {
  await Promise.all(
    openConnectors.splice(0).map((connector) => connector.close()),
  );
  await Promise.all(openStates.splice(0).map((state) => state.close()));
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RelayConnector", () => {
  it("tolerates four unanswered control pings before reconnecting", async () => {
    const server = await relayServer({ autoPong: false });
    let control: WebSocket | undefined;
    let pings = 0;
    server.on("connection", (socket) => {
      control = socket;
      socket.on("ping", () => {
        pings += 1;
      });
      socket.once("message", () => registered(socket));
    });
    const connector = await RelayConnector.start({
      ...(await connectorOptions(server)),
      relayControlHeartbeatMs: 20,
      relayControlHeartbeatMissLimit: 4,
    });
    openConnectors.push(connector);

    await delay(50);
    expect(pings).toBeGreaterThanOrEqual(2);
    expect(control?.readyState).toBe(WebSocket.OPEN);
    await closed(control!);
    expect(pings).toBeGreaterThanOrEqual(4);
  });

  it("closes a candidate control socket when registration parsing fails", async () => {
    const server = await relayServer();
    let candidate: WebSocket | undefined;
    const candidateClosed = new Promise<void>((resolve) => {
      server.on("connection", (socket) => {
        candidate = socket;
        socket.once("close", () => resolve());
        socket.once("message", () => socket.send("not-json"));
      });
    });

    await expect(
      RelayConnector.start(await connectorOptions(server)),
    ).rejects.toThrow();
    await candidateClosed;
    expect(candidate?.readyState).toBe(WebSocket.CLOSED);
  });

  it("closes a failed incoming tunnel instead of leaking it", async () => {
    const server = await relayServer();
    let control: WebSocket | undefined;
    let tunnel: WebSocket | undefined;
    const tunnelClosed = new Promise<void>((resolve) => {
      server.on("connection", (socket) => {
        if (!control) {
          control = socket;
          socket.once("message", () => registered(socket));
          return;
        }
        tunnel = socket;
        socket.once("close", () => resolve());
        socket.once("message", () => socket.send("invalid-acceptance"));
      });
    });
    const connector = await RelayConnector.start(
      await connectorOptions(server),
    );
    openConnectors.push(connector);
    control!.send(
      JSON.stringify({
        type: "relay/incoming",
        version: 1,
        connectionId: "connection-1",
      }),
    );

    await tunnelClosed;
    expect(tunnel?.readyState).toBe(WebSocket.CLOSED);
  });

  it("rotates the control capability without interrupting active tunnels", async () => {
    const server = await relayServer();
    const controls: WebSocket[] = [];
    const tunnels: WebSocket[] = [];
    const acceptedCapabilities: string[] = [];
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "relay/register") {
          const previous = controls.at(-1);
          controls.push(socket);
          if (previous?.readyState === WebSocket.OPEN) {
            previous.close(1008, "route registered elsewhere");
            // Let the old close schedule reconnect before the candidate is
            // committed. The queued reconnect must observe the new control
            // and avoid opening a third socket with stale capability.
            setTimeout(() => registered(socket), 60);
          } else {
            registered(socket);
          }
          return;
        }
        if (message.type === "relay/accept") {
          tunnels.push(socket);
          acceptedCapabilities.push(String(message.capability));
          socket.send(JSON.stringify({ type: "relay/accepted", version: 1 }));
        }
      });
    });
    const connector = await RelayConnector.start({
      ...(await connectorOptions(server)),
      relayReconnectDelayMs: 20,
    });
    openConnectors.push(connector);
    controls[0]!.send(incoming("connection-before-rotation"));
    await waitUntil(() => acceptedCapabilities.length === 1);
    expect(acceptedCapabilities).toEqual(["capability-1"]);
    expect(tunnels[0]?.readyState).toBe(WebSocket.OPEN);

    await connector.rotateRouteCapability("capability-2");
    await delay(40);
    expect(controls).toHaveLength(2);
    expect(tunnels[0]?.readyState).toBe(WebSocket.OPEN);
    controls[1]!.send(incoming("connection-after-rotation"));
    await waitUntil(() => acceptedCapabilities.length === 2);
    expect(acceptedCapabilities).toEqual(["capability-1", "capability-2"]);
    expect(tunnels[0]?.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a superseded control even when the Relay does not", async () => {
    const server = await relayServer();
    const controls: WebSocket[] = [];
    const tunnels: WebSocket[] = [];
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "relay/register") {
          controls.push(socket);
          registered(socket);
          return;
        }
        if (message.type === "relay/accept") {
          tunnels.push(socket);
          socket.send(JSON.stringify({ type: "relay/accepted", version: 1 }));
        }
      });
    });
    const connector = await RelayConnector.start(
      await connectorOptions(server),
    );
    openConnectors.push(connector);
    controls[0]!.send(incoming("connection-before-rotation"));
    await waitUntil(() => tunnels.length === 1);

    await connector.rotateRouteCapability("capability-2");

    await closed(controls[0]!);
    expect(controls).toHaveLength(2);
    expect(controls[1]?.readyState).toBe(WebSocket.OPEN);
    expect(tunnels[0]?.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps the old control and capability when rotation registration fails", async () => {
    const server = await relayServer();
    const controls: WebSocket[] = [];
    const acceptedCapabilities: string[] = [];
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "relay/register") {
          controls.push(socket);
          if (message.capability === "capability-1") registered(socket);
          else socket.send("invalid-registration");
          return;
        }
        if (message.type === "relay/accept") {
          acceptedCapabilities.push(String(message.capability));
          socket.send(JSON.stringify({ type: "relay/accepted", version: 1 }));
        }
      });
    });
    const connector = await RelayConnector.start(
      await connectorOptions(server),
    );
    openConnectors.push(connector);

    await expect(
      connector.rotateRouteCapability("rejected-capability"),
    ).rejects.toThrow();
    await closed(controls[1]!);
    expect(controls[0]?.readyState).toBe(WebSocket.OPEN);
    controls[0]!.send(incoming("connection-after-rejection"));
    await waitUntil(() => acceptedCapabilities.length === 1);
    expect(acceptedCapabilities).toEqual(["capability-1"]);
  });

  it("does not commit or reconnect a capability rotation after close", async () => {
    const server = await relayServer();
    const controls: WebSocket[] = [];
    server.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type !== "relay/register") return;
        controls.push(socket);
        if (controls.length === 1) {
          registered(socket);
        } else {
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) registered(socket);
          }, 60);
        }
      });
    });
    const connector = await RelayConnector.start({
      ...(await connectorOptions(server)),
      relayReconnectDelayMs: 20,
    });
    openConnectors.push(connector);
    const rotating = connector.rotateRouteCapability("capability-2");
    await waitUntil(() => controls.length === 2);

    await connector.close();
    await expect(rotating).rejects.toThrow();
    await delay(80);
    expect(controls).toHaveLength(2);
    expect(
      controls.every((socket) => socket.readyState === WebSocket.CLOSED),
    ).toBe(true);
  });
});

async function connectorOptions(
  server: WebSocketServer,
): Promise<RelayConnectorOptions> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  const directory = await mkdtemp(join(tmpdir(), "ce-relay-connector-test-"));
  temporaryDirectories.push(directory);
  const state = await HostStateStore.open(join(directory, "state.sqlite"));
  openStates.push(state);
  return {
    host: "127.0.0.1",
    port: 0,
    endpoint: `ws://127.0.0.1:${address.port}`,
    routeId: "route-1",
    routeCapability: "capability-1",
    nodeId: "node-1",
    userId: "unix:1000",
    identity: generateStaticKeyPair(),
    hostFingerprint: `sha256:${"A".repeat(43)}`,
    state,
    createSession: () => ({ request: async () => undefined }),
  };
}

async function relayServer(
  options: { autoPong?: boolean } = {},
): Promise<WebSocketServer> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    autoPong: options.autoPong ?? true,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  openServers.push(server);
  return server;
}

function registered(socket: WebSocket): void {
  socket.send(
    JSON.stringify({
      type: "relay/registered",
      version: 1,
      routeId: "route-1",
    }),
  );
}

function incoming(connectionId: string): string {
  return JSON.stringify({
    type: "relay/incoming",
    version: 1,
    connectionId,
  });
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await delay(5);
  }
}
