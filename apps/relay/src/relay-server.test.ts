import { createHmac } from "node:crypto";

import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  generateRelaySigningKey,
  issueHostProvisionerCredential,
  issueProvisionedAdminRouteCapability,
  issueProvisionedRouteCapability,
  issueRouteCapability,
} from "./capability.js";
import { RelayServer, type RelayExpirationClock } from "./relay-server.js";

describe("RelayServer", () => {
  let relay: RelayServer | undefined;
  const installationId = "hpc-cluster-1";

  afterEach(async () => relay?.close());

  it("routes opaque frames without persistent route state", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, {
      loginName: "alice",
    });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
    });
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
    const lookupClosed = closeCode(lookup);
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
    expect(await lookupClosed).toBe(1000);

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

  it("expires every route-bound socket and leaves other routes untouched", async () => {
    const signingKey = generateRelaySigningKey();
    const clock = new ManualExpirationClock();
    const expiringProvisioner = issueHostProvisionerCredential(signingKey, {
      installationId,
      expiresAt: clock.dateAfter(1_000),
    });
    const expiringRoute = issueProvisionedRouteCapability(
      expiringProvisioner,
      { loginName: "alice" },
      clock.dateAfter(0),
    );
    const otherRoute = issueRouteCapability(signingKey, {
      loginName: "bob",
    });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      expirationClock: clock.relayClock,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const expiringControl = await registerRoute(
      endpoint,
      expiringRoute.capability,
    );
    const otherControl = await registerRoute(endpoint, otherRoute.capability);
    const expiringActive = await openTunnel(
      endpoint,
      expiringControl,
      expiringRoute.capability,
      expiringRoute.payload.routeId,
    );
    const otherActive = await openTunnel(
      endpoint,
      otherControl,
      otherRoute.capability,
      otherRoute.payload.routeId,
    );

    const pendingBrowser = await open(endpoint);
    pendingBrowser.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: expiringRoute.payload.routeId,
      }),
    );
    await next(expiringControl);

    const setupBrowser = await open(endpoint);
    setupBrowser.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: expiringRoute.payload.routeId,
      }),
    );
    const setupIncoming = JSON.parse(await next(expiringControl)) as {
      connectionId: string;
    };
    const setupAgent = await open(endpoint);
    setupAgent.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: expiringRoute.capability,
        connectionId: setupIncoming.connectionId,
      }),
    );
    await next(setupAgent);

    const expiredClosures = [
      expiringControl,
      expiringActive.browser,
      expiringActive.tunnel,
      pendingBrowser,
      setupBrowser,
      setupAgent,
    ].map(closeDetails);
    clock.advanceBy(1_000);

    await expect(Promise.all(expiredClosures)).resolves.toEqual(
      Array.from({ length: expiredClosures.length }, () => ({
        code: 1008,
        reason: "route authorization expired",
      })),
    );

    const expiredLookup = await open(endpoint);
    const expiredLookupClosed = closeDetails(expiredLookup);
    expiredLookup.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    await expect(expiredLookupClosed).resolves.toEqual({
      code: 1013,
      reason: "login unavailable",
    });

    expect(otherControl.readyState).toBe(WebSocket.OPEN);
    expect(otherActive.browser.readyState).toBe(WebSocket.OPEN);
    expect(otherActive.tunnel.readyState).toBe(WebSocket.OPEN);
    otherActive.browser.send("other-route-browser-frame");
    expect(await next(otherActive.tunnel)).toBe("other-route-browser-frame");
    otherActive.tunnel.send("other-route-agent-frame");
    expect(await next(otherActive.browser)).toBe("other-route-agent-frame");

    otherActive.browser.terminate();
    await closed(otherActive.tunnel);
    otherControl.close();
  });

  it("extends a route in place when the same owner renews its capability", async () => {
    const signingKey = generateRelaySigningKey();
    const clock = new ManualExpirationClock();
    const provisioner = issueHostProvisionerCredential(signingKey, {
      installationId,
      expiresAt: clock.dateAfter(2_000),
    });
    const initial = issueProvisionedRouteCapability(
      provisioner,
      {
        loginName: "alice",
        expiresAt: clock.dateAfter(1_000),
      },
      clock.dateAfter(0),
    );
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      expirationClock: clock.relayClock,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const initialControl = await registerRoute(endpoint, initial.capability);
    const firstActive = await openTunnel(
      endpoint,
      initialControl,
      initial.capability,
      initial.payload.routeId,
    );

    clock.advanceBy(500);
    const renewedProvisioner = issueHostProvisionerCredential(signingKey, {
      installationId,
      expiresAt: clock.dateAfter(4_500),
    });
    const renewed = issueProvisionedRouteCapability(
      renewedProvisioner,
      {
        loginName: "alice",
        routeId: initial.payload.routeId,
        expiresAt: clock.dateAfter(2_500),
      },
      clock.dateAfter(0),
    );
    const oldControlClosed = closeDetails(initialControl);
    const renewedControl = await registerRoute(endpoint, renewed.capability);
    await expect(oldControlClosed).resolves.toEqual({
      code: 1008,
      reason: "route registered elsewhere",
    });

    const staleControl = await open(endpoint);
    const staleControlClosed = closeDetails(staleControl);
    sendRegistration(staleControl, initial.capability, "stale-node");
    await expect(staleControlClosed).resolves.toEqual({
      code: 1008,
      reason: "invalid relay handshake",
    });
    expect(renewedControl.readyState).toBe(WebSocket.OPEN);
    firstActive.browser.send("survives-stale-registration");
    expect(await next(firstActive.tunnel)).toBe("survives-stale-registration");

    // Retrying the exact generation is required when relay/registered was lost.
    const renewedControlClosed = closeDetails(renewedControl);
    const retriedControl = await registerRoute(endpoint, renewed.capability);
    await expect(renewedControlClosed).resolves.toEqual({
      code: 1008,
      reason: "route registered elsewhere",
    });
    expect(firstActive.browser.readyState).toBe(WebSocket.OPEN);
    expect(firstActive.tunnel.readyState).toBe(WebSocket.OPEN);

    clock.advanceBy(500);
    expect(firstActive.browser.readyState).toBe(WebSocket.OPEN);
    expect(firstActive.tunnel.readyState).toBe(WebSocket.OPEN);
    firstActive.browser.send("survives-old-expiration");
    expect(await next(firstActive.tunnel)).toBe("survives-old-expiration");

    const secondBrowser = await open(endpoint);
    secondBrowser.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: initial.payload.routeId,
      }),
    );
    const secondIncoming = JSON.parse(await next(retriedControl)) as {
      connectionId: string;
    };
    const expiredAgent = await open(endpoint);
    const expiredAgentClosed = closeDetails(expiredAgent);
    expiredAgent.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: initial.capability,
        connectionId: secondIncoming.connectionId,
      }),
    );
    await expect(expiredAgentClosed).resolves.toEqual({
      code: 1008,
      reason: "invalid relay handshake",
    });
    expect(secondBrowser.readyState).toBe(WebSocket.OPEN);

    const secondAgent = await open(endpoint);
    secondAgent.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: renewed.capability,
        connectionId: secondIncoming.connectionId,
      }),
    );
    await next(secondAgent);
    secondAgent.send(
      JSON.stringify({ type: "relay/tunnel-ready", version: 1 }),
    );
    await next(secondBrowser);

    const renewedClosures = [
      retriedControl,
      firstActive.browser,
      firstActive.tunnel,
      secondBrowser,
      secondAgent,
    ].map(closeDetails);
    clock.advanceBy(2_000);
    await expect(Promise.all(renewedClosures)).resolves.toEqual(
      Array.from({ length: renewedClosures.length }, () => ({
        code: 1008,
        reason: "route authorization expired",
      })),
    );
  });

  it("uses issuance time to reject rollback at the same expiration", async () => {
    const signingKey = generateRelaySigningKey();
    const clock = new ManualExpirationClock();
    const provisioner = issueHostProvisionerCredential(signingKey, {
      installationId,
      expiresAt: clock.dateAfter(5_000),
    });
    const expiration = clock.dateAfter(4_000);
    const initial = issueProvisionedRouteCapability(
      provisioner,
      { loginName: "alice", expiresAt: expiration },
      clock.dateAfter(0),
    );
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      expirationClock: clock.relayClock,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const initialControl = await registerRoute(endpoint, initial.capability);

    clock.advanceBy(100);
    const newer = issueProvisionedRouteCapability(
      provisioner,
      {
        loginName: "alice",
        routeId: initial.payload.routeId,
        expiresAt: expiration,
      },
      clock.dateAfter(0),
    );
    const initialControlClosed = closeDetails(initialControl);
    const newerControl = await registerRoute(endpoint, newer.capability);
    await expect(initialControlClosed).resolves.toEqual({
      code: 1008,
      reason: "route registered elsewhere",
    });

    const rollbackControl = await open(endpoint);
    const rollbackClosed = closeDetails(rollbackControl);
    sendRegistration(rollbackControl, initial.capability, "rollback-node");
    await expect(rollbackClosed).resolves.toEqual({
      code: 1008,
      reason: "invalid relay handshake",
    });
    expect(newerControl.readyState).toBe(WebSocket.OPEN);
    newerControl.close();
  });

  it("does not replace an unbounded authorization with a finite one", async () => {
    const signingKey = generateRelaySigningKey();
    const clock = new ManualExpirationClock();
    const unbounded = issueRouteCapability(signingKey, {
      loginName: "alice",
    });
    const finite = issueRouteCapability(signingKey, {
      loginName: "alice",
      routeId: unbounded.payload.routeId,
      expiresAt: clock.dateAfter(5_000),
    });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      expirationClock: clock.relayClock,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const unboundedControl = await registerRoute(
      endpoint,
      unbounded.capability,
    );

    const finiteControl = await open(endpoint);
    const finiteControlClosed = closeDetails(finiteControl);
    sendRegistration(finiteControl, finite.capability, "finite-node");
    await expect(finiteControlClosed).resolves.toEqual({
      code: 1008,
      reason: "invalid relay handshake",
    });
    expect(unboundedControl.readyState).toBe(WebSocket.OPEN);
    unboundedControl.close();
  });

  it("chunks expiration timers longer than the Node timer maximum", async () => {
    const signingKey = generateRelaySigningKey();
    const clock = new ManualExpirationClock();
    const maximumTimerDelay = 2_147_483_647;
    const route = issueRouteCapability(signingKey, {
      loginName: "alice",
      expiresAt: clock.dateAfter(maximumTimerDelay + 1_000),
    });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      expirationClock: clock.relayClock,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const control = await registerRoute(endpoint, route.capability);
    const controlClosed = closeDetails(control);

    clock.advanceBy(maximumTimerDelay);
    expect(control.readyState).toBe(WebSocket.OPEN);
    clock.advanceBy(999);
    expect(control.readyState).toBe(WebSocket.OPEN);
    clock.advanceBy(1);
    await expect(controlClosed).resolves.toEqual({
      code: 1008,
      reason: "route authorization expired",
    });
  });

  it("rejects an unsupported Relay wire version before route handling", async () => {
    const signingKey = generateRelaySigningKey();
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
    });
    const socket = await open(`ws://127.0.0.1:${relay.port}`);
    const rejected = closeCode(socket);

    socket.send(
      JSON.stringify({
        type: "relay/connect",
        version: 2,
        routeId: "opaque-route",
      }),
    );

    await expect(rejected).resolves.toBe(1008);
  });

  it("terminates a tunnel endpoint that stops answering heartbeat pings", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, { loginName: "alice" });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      tunnelHeartbeatMs: 20,
    });
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
        },
      }),
    );
    await next(control);

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
    const tunnel = await open(endpoint, false);
    tunnel.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: route.capability,
        connectionId: incoming.connectionId,
      }),
    );
    await next(tunnel);
    tunnel.send(JSON.stringify({ type: "relay/tunnel-ready", version: 1 }));
    await next(browser);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tunnel.readyState).toBe(WebSocket.OPEN);
    expect(browser.readyState).toBe(WebSocket.OPEN);
    await closed(tunnel);
    await closed(browser);
    expect(control.readyState).toBe(WebSocket.OPEN);
    control.close();
  });

  it("rate limits repeated lookup attempts from one address", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, { loginName: "alice" });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      maxLookupsPerWindow: 1,
      lookupWindowMs: 60_000,
    });
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
        },
      }),
    );
    await next(control);

    const first = await open(endpoint);
    const firstClosed = closeCode(first);
    first.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    await next(first);
    expect(await firstClosed).toBe(1000);

    const second = await open(endpoint);
    const secondClosed = closeCode(second);
    second.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    expect(await secondClosed).toBe(1013);
    control.close();
  });

  it("rate limits repeated tunnel connections from one address", async () => {
    const signingKey = generateRelaySigningKey();
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      maxConnectsPerWindow: 1,
      connectWindowMs: 60_000,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;

    const first = await open(endpoint);
    const firstClosed = closeCode(first);
    first.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: "offline-route",
      }),
    );
    expect(await firstClosed).toBe(1013);

    const second = await open(endpoint);
    const secondClosed = closeDetails(second);
    second.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: "offline-route",
      }),
    );
    await expect(secondClosed).resolves.toEqual({
      code: 1013,
      reason: "connect rate exceeded",
    });
  });

  it("bounds high-cardinality address buckets and admits a new address after expiry", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, { loginName: "alice" });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      trustLoopbackProxy: true,
      maxAddressRateBuckets: 2,
      maxLookupsPerWindow: 10,
      lookupWindowMs: 20,
    });
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
        },
      }),
    );
    await next(control);

    for (const address of ["2001:db8::1", "2001:db8::2"]) {
      const lookup = await open(endpoint, true, { "X-Real-IP": address });
      const lookupClosed = closeCode(lookup);
      lookup.send(
        JSON.stringify({
          type: "relay/lookup",
          version: 1,
          loginName: "alice",
        }),
      );
      await next(lookup);
      expect(await lookupClosed).toBe(1000);
    }

    const overflow = await open(endpoint, true, {
      "X-Real-IP": "2001:db8::3",
    });
    const overflowClosed = closeDetails(overflow);
    overflow.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    await expect(overflowClosed).resolves.toEqual({
      code: 1013,
      reason: "lookup rate exceeded",
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterExpiry = await open(endpoint, true, {
      "X-Real-IP": "2001:db8::4",
    });
    const afterExpiryClosed = closeCode(afterExpiry);
    afterExpiry.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    await next(afterExpiry);
    expect(await afterExpiryClosed).toBe(1000);
    control.close();
  });

  it("closes a tunnel when forwarding would exceed its byte budget", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, { loginName: "alice" });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      maxTunnelBufferedBytes: 1,
    });
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
        },
      }),
    );
    await next(control);
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
    const tunnel = await open(endpoint);
    tunnel.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: route.capability,
        connectionId: incoming.connectionId,
      }),
    );
    await next(tunnel);
    tunnel.send(JSON.stringify({ type: "relay/tunnel-ready", version: 1 }));
    await next(browser);

    browser.send("too large");
    await Promise.all([closed(browser), closed(tunnel)]);
    control.close();
  });

  it("enforces one process-wide pending byte budget", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, { loginName: "alice" });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      maxTunnelBufferedBytes: 1_024,
      maxRelayBufferedBytes: 1,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const control = await registerRoute(endpoint, route.capability);
    const { browser, tunnel } = await openTunnel(
      endpoint,
      control,
      route.capability,
      route.payload.routeId,
    );

    browser.send("too large");
    await Promise.all([closed(browser), closed(tunnel)]);
    control.close();
  });

  it("releases the process byte reservation before another tunnel forwards", async () => {
    const signingKey = generateRelaySigningKey();
    const route = issueRouteCapability(signingKey, { loginName: "alice" });
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
      maxTunnelBufferedBytes: 1_024,
      maxRelayBufferedBytes: 1,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const control = await registerRoute(endpoint, route.capability);
    const first = await openTunnel(
      endpoint,
      control,
      route.capability,
      route.payload.routeId,
    );
    const second = await openTunnel(
      endpoint,
      control,
      route.capability,
      route.payload.routeId,
    );

    first.browser.send("a");
    expect(await next(first.tunnel)).toBe("a");
    second.browser.send("b");
    expect(await next(second.tunnel)).toBe("b");

    first.browser.terminate();
    second.browser.terminate();
    await Promise.all([closed(first.tunnel), closed(second.tunnel)]);
    control.close();
  });

  it("discovers a legacy v3 self-provisioned Unix user by login name", async () => {
    const signingKey = generateRelaySigningKey();
    const provisioner = issueHostProvisionerCredential(signingKey, {
      installationId: "hpc-cluster-1",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const route = issueProvisionedRouteCapability(provisioner, {
      loginName: "bob",
    });
    const legacyCapability = signProvisionedPayload(
      {
        version: 3,
        purpose: "agent-route",
        routeId: route.payload.routeId,
        installationId: route.payload.installationId,
        loginName: route.payload.loginName,
        issuedAt: route.payload.issuedAt,
        provisionerExpiresAt: route.payload.provisionerExpiresAt,
      },
      provisioner.signingKey,
    );
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;
    const control = await open(endpoint);
    control.send(
      JSON.stringify({
        type: "relay/register",
        version: 1,
        capability: legacyCapability,
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
      installationId,
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

  it("rejects cross-installation registration and tunnel acceptance even when the attacker arrives first", async () => {
    const signingKey = generateRelaySigningKey();
    const expiresAt = new Date(Date.now() + 86_400_000);
    const victimProvisioner = issueHostProvisionerCredential(signingKey, {
      installationId,
      expiresAt,
    });
    const attackerProvisioner = issueHostProvisionerCredential(signingKey, {
      installationId: "attacker-cluster",
      expiresAt,
    });
    const victim = issueProvisionedRouteCapability(victimProvisioner, {
      loginName: "alice",
    });
    const attacker = issueProvisionedRouteCapability(attackerProvisioner, {
      loginName: "alice",
    });
    const crossInstallationTakeover = issueProvisionedRouteCapability(
      attackerProvisioner,
      { loginName: "alice", routeId: victim.payload.routeId },
    );
    const conflictingOwner = issueProvisionedRouteCapability(
      victimProvisioner,
      { loginName: "mallory", routeId: victim.payload.routeId },
    );
    relay = await RelayServer.start({
      host: "127.0.0.1",
      port: 0,
      signingKey,
      installationId,
    });
    const endpoint = `ws://127.0.0.1:${relay.port}`;

    const attackerFirst = await open(endpoint);
    const attackerFirstClosed = closeCode(attackerFirst);
    sendRegistration(attackerFirst, attacker.capability, "attacker-node");
    expect(await attackerFirstClosed).toBe(1008);

    const victimControl = await open(endpoint);
    sendRegistration(victimControl, victim.capability, "victim-node");
    await expect(next(victimControl)).resolves.toContain("relay/registered");

    const takeover = await open(endpoint);
    const takeoverClosed = closeCode(takeover);
    sendRegistration(
      takeover,
      crossInstallationTakeover.capability,
      "attacker-node",
    );
    expect(await takeoverClosed).toBe(1008);
    expect(victimControl.readyState).toBe(WebSocket.OPEN);

    const wrongOwner = await open(endpoint);
    const wrongOwnerClosed = closeCode(wrongOwner);
    sendRegistration(wrongOwner, conflictingOwner.capability, "wrong-owner");
    expect(await wrongOwnerClosed).toBe(1008);
    expect(victimControl.readyState).toBe(WebSocket.OPEN);

    const lookup = await open(endpoint);
    lookup.send(
      JSON.stringify({
        type: "relay/lookup",
        version: 1,
        loginName: "alice",
      }),
    );
    expect(JSON.parse(await next(lookup))).toMatchObject({
      type: "relay/profile",
      nodeId: "victim-node",
      routeId: victim.payload.routeId,
    });

    const browser = await open(endpoint);
    browser.send(
      JSON.stringify({
        type: "relay/connect",
        version: 1,
        routeId: victim.payload.routeId,
      }),
    );
    const incoming = JSON.parse(await next(victimControl)) as {
      connectionId: string;
    };
    const crossInstallationTunnel = await open(endpoint);
    const crossInstallationTunnelClosed = closeCode(crossInstallationTunnel);
    crossInstallationTunnel.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: crossInstallationTakeover.capability,
        connectionId: incoming.connectionId,
      }),
    );
    expect(await crossInstallationTunnelClosed).toBe(1008);

    const hostileTunnel = await open(endpoint);
    const hostileClosed = closeCode(hostileTunnel);
    hostileTunnel.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: conflictingOwner.capability,
        connectionId: incoming.connectionId,
      }),
    );
    expect(await hostileClosed).toBe(1008);

    const legitimateTunnel = await open(endpoint);
    legitimateTunnel.send(
      JSON.stringify({
        type: "relay/accept",
        version: 1,
        capability: victim.capability,
        connectionId: incoming.connectionId,
      }),
    );
    await expect(next(legitimateTunnel)).resolves.toContain("relay/accepted");
    legitimateTunnel.send(
      JSON.stringify({ type: "relay/tunnel-ready", version: 1 }),
    );
    await expect(next(browser)).resolves.toContain("relay/ready");

    browser.terminate();
    await closed(legitimateTunnel);
    victimControl.close();
  });
});

class ManualExpirationClock {
  #now: number;
  readonly #timers = new Map<
    ReturnType<typeof setTimeout>,
    { callback: () => void; dueAt: number }
  >();

  readonly relayClock: RelayExpirationClock = {
    now: () => this.#now,
    setTimeout: (callback, delayMs) => {
      const timer = {
        unref: () => undefined,
      } as unknown as ReturnType<typeof setTimeout>;
      this.#timers.set(timer, {
        callback,
        dueAt: this.#now + delayMs,
      });
      return timer;
    },
    clearTimeout: (timer) => this.#timers.delete(timer),
  };

  constructor(now = Date.now()) {
    this.#now = now;
  }

  dateAfter(milliseconds: number): Date {
    return new Date(this.#now + milliseconds);
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
      throw new Error("Manual clock advance must be a non-negative integer");
    const target = this.#now + milliseconds;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].dueAt;
      next[1].callback();
    }
    this.#now = target;
  }
}

function sendRegistration(
  socket: WebSocket,
  capability: string,
  nodeId: string,
): void {
  socket.send(
    JSON.stringify({
      type: "relay/register",
      version: 1,
      capability,
      profile: {
        nodeId,
        userId: "unix:1003",
        hostPublicKey: "A".repeat(43),
        hostFingerprint: `sha256:${"B".repeat(43)}`,
      },
    }),
  );
}

function signProvisionedPayload(
  payload: Record<string, unknown>,
  signingKey: string,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", Buffer.from(signingKey, "base64url"))
    .update(`ce-relay-provisioned-v1.${body}`)
    .digest("base64url");
  return `${body}.${signature}`;
}

function open(
  endpoint: string,
  autoPong = true,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      perMessageDeflate: false,
      autoPong,
      ...(headers ? { headers } : {}),
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function registerRoute(
  endpoint: string,
  capability: string,
): Promise<WebSocket> {
  const control = await open(endpoint);
  control.send(
    JSON.stringify({
      type: "relay/register",
      version: 1,
      capability,
      profile: {
        nodeId: "node-1",
        userId: "unix:1003",
        hostPublicKey: "A".repeat(43),
        hostFingerprint: `sha256:${"B".repeat(43)}`,
      },
    }),
  );
  await next(control);
  return control;
}

async function openTunnel(
  endpoint: string,
  control: WebSocket,
  capability: string,
  routeId: string,
): Promise<{ browser: WebSocket; tunnel: WebSocket }> {
  const browser = await open(endpoint);
  browser.send(JSON.stringify({ type: "relay/connect", version: 1, routeId }));
  const incoming = JSON.parse(await next(control)) as { connectionId: string };
  const tunnel = await open(endpoint);
  tunnel.send(
    JSON.stringify({
      type: "relay/accept",
      version: 1,
      capability,
      connectionId: incoming.connectionId,
    }),
  );
  await next(tunnel);
  tunnel.send(JSON.stringify({ type: "relay/tunnel-ready", version: 1 }));
  await next(browser);
  return { browser, tunnel };
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

function closeCode(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED)
    return Promise.reject(new Error("Socket already closed"));
  return new Promise((resolve) => socket.once("close", resolve));
}

function closeDetails(
  socket: WebSocket,
): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED)
    return Promise.reject(new Error("Socket already closed"));
  return new Promise((resolve) =>
    socket.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
}
