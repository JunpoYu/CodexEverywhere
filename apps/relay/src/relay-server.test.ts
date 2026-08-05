import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
  issueProvisionedRouteCapability,
  issueRouteCapability,
} from "./capability.js";
import { RelayServer } from "./relay-server.js";

describe("RelayServer", () => {
  let relay: RelayServer | undefined;

  afterEach(async () => relay?.close());

  it("routes opaque frames without persistent route state", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, {
      loginName: "alice",
    });
    relay = await RelayServer.start({ host: "127.0.0.1", port: 0, signingKey });
    const endpoint = `ws://127.0.0.1:${relay.port}`;

    const control = await open(endpoint);
    control.send(
      JSON.stringify({
        type: "relay/register",
        version: 1,
        capability: route.capability,
        profile: {
          nodeId: "node-1",
          userId: "unix:1003",
          hostPublicKey: "A".repeat(43),
          hostFingerprint: `sha256:${"B".repeat(43)}`,
          directEndpoint: "wss://hpc.example/gateway",
        },
      }),
    );
    expect(JSON.parse(await next(control))).toMatchObject({
      type: "relay/registered",
      routeId: route.payload.routeId,
    });

    const lookup = await open(endpoint);
    lookup.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    expect(JSON.parse(await next(lookup))).toEqual({
      type: "relay/profile",
      version: 1,
      routeId: route.payload.routeId,
      nodeId: "node-1",
      userId: "unix:1003",
      hostPublicKey: "A".repeat(43),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      directEndpoint: "wss://hpc.example/gateway",
    });
    lookup.close();

    const browser = await open(endpoint);
    browser.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: route.payload.routeId,
      }),
    );
    const incoming = JSON.parse(await next(control)) as {
      connectionId: string;
    };
    expect(incoming).toMatchObject({ type: "relay/incoming", version: 1 });

    const tunnel = await open(endpoint);
    tunnel.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: route.capability,
        connectionId: incoming.connectionId,
      }),
    );
    expect(JSON.parse(await next(tunnel))).toEqual({
      type: "relay/accepted",
      version: 1,
    });
    tunnel.send(JSON.stringify({ type: "relay/tunnel-ready", version: 1 }));
    expect(JSON.parse(await next(browser))).toEqual({
      type: "relay/ready",
      version: 1,
    });

    browser.send("browser-ciphertext");
    expect(await next(tunnel)).toBe("browser-ciphertext");
    tunnel.send("agent-ciphertext");
    expect(await next(browser)).toBe("agent-ciphertext");

    browser.terminate();
    await closed(tunnel);
    expect(control.readyState).toBe(WebSocket.OPEN);
    control.close();
  });

  it("discovers a self-provisioned Unix user by login name", async () => {
    const signingKey = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(signingKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const route = issueProvisionedRouteCapability(provisioner, {
      loginName: "bob",
    });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const control = await open(endpoint);
    control.send(
      JSON.stringify({
        type: "relay/register",
        version: 1,
        capability: route.capability,
        profile: {
          nodeId: "node-shao",
          userId: "unix:2025",
          hostPublicKey: "A".repeat(43),
          hostFingerprint: `sha256:${"B".repeat(43)}`,
        },
      }),
    );
    expect(JSON.parse(await next(control))).toMatchObject({
      type: "relay/registered",
      routeId: route.payload.routeId,
    });

    const lookup = await open(endpoint);
    lookup.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "bob",
      }),
    );
    expect(JSON.parse(await next(lookup))).toMatchObject({
      type: "relay/profile",
      nodeId: "node-shao",
      userId: "unix:2025",
    });
    lookup.close();
    control.close();
  });

  it("only returns an administrator route for administrator lookup", async () => {
    const signingKey = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(signingKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const route = issueProvisionedAdminRouteCapability(provisioner, {
      adminHandle: "admin",
    });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const control = await open(endpoint);
    control.send(
      JSON.stringify({
        type: "relay/register",
        version: 1,
        capability: route.capability,
        profile: {
          principal: "host-admin",
          nodeId: "admin-node",
          userId: "admin:hpc-cluster-1",
          hostPublicKey: "A".repeat(43),
          hostFingerprint: `sha256:${"B".repeat(43)}`,
        },
      }),
    );
    await next(control);

    const lookup = await open(endpoint);
    lookup.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        principal: "host-admin",
        loginName: "admin",
      }),
    );
    expect(JSON.parse(await next(lookup))).toMatchObject({
      type: "relay/profile",
      principal: "host-admin",
      nodeId: "admin-node",
      userId: "admin:hpc-cluster-1",
    });
    lookup.close();
    control.close();
  });
});

function open(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { perMessageDeflate: false });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket: WebSocket): Promise<string> {
  return new Promise((resolve) =>
    socket.once("message", (data: RawData) => resolve(data.toString())),
  );
}

function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}
