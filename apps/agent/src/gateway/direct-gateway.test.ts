import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import {
  NoiseInitiator,
  encodePrologue,
  generateStaticKeyPair,
  type SecureSession,
} from "@codex-everywhere/crypto";
import {
  PROTOCOL_VERSION,
  parseGatewayHandshakeResult,
  type GatewayCipherFrame,
  type RequestEnvelope,
} from "@codex-everywhere/protocol";

import { DeviceRegistry } from "../host/devices.js";
import { AuthenticatedSessionRegistry } from "../host/auth-security.js";
import { HostStateStore } from "../host/state-store.js";
import type { PasskeyRegistry } from "../host/passkeys.js";
import { AuthenticatedGatewaySession } from "./authenticated-session.js";
import { DirectGateway } from "./direct-gateway.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("DirectGateway", () => {
  it("keeps responsive Direct sockets alive and closes half-open peers", async () => {
    const state = await stateStore();
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: generateStaticKeyPair(),
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      gatewayHeartbeatMs: 20,
      state,
      createSession: () => ({ request: async () => undefined }),
    });
    const endpoint = `ws://127.0.0.1:${gateway.port}/gateway`;
    const responsive = await openRawSocket(endpoint);
    let pingCount = 0;
    responsive.on("ping", () => {
      pingCount += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(pingCount).toBeGreaterThanOrEqual(2);
    expect(responsive.readyState).toBe(WebSocket.OPEN);

    const halfOpen = await openRawSocket(endpoint, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(halfOpen.readyState).toBe(WebSocket.OPEN);
    await onceClosed(halfOpen);
    expect(halfOpen.readyState).toBe(WebSocket.CLOSED);

    responsive.close();
    await onceClosed(responsive);
    await gateway.close();
    await state.close();
  });

  it("returns a public profile without opening an authenticated session", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    let sessions = 0;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      loginName: "alice",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      directEndpoint: "wss://hpc.example/gateway",
      relayEndpoint: "wss://relay.example/relay",
      relayRouteId: "route-1",
      allowedOrigin: "https://codex.example",
      state,
      createSession: () => {
        sessions += 1;
        return { request: async () => undefined };
      },
    });
    await expect(
      rejectedWebSocketStatus(
        `ws://127.0.0.1:${gateway.port}/gateway`,
        "https://evil.example",
      ),
    ).resolves.toBe(401);
    const discovered = await fetch(
      `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`,
      { headers: { Origin: "https://codex.example" } },
    );
    expect(discovered.status).toBe(200);
    expect(discovered.headers.get("access-control-allow-origin")).toBe(
      "https://codex.example",
    );
    await expect(discovered.json()).resolves.toMatchObject({
      type: "host/profile",
      directEndpoint: "wss://hpc.example/gateway",
    });
    const preflight = await fetch(
      `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://codex.example",
          "Access-Control-Request-Private-Network": "true",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
    const blocked = await fetch(
      `http://127.0.0.1:${gateway.port}/.well-known/codex-everywhere`,
      { headers: { Origin: "https://evil.example" } },
    );
    expect(blocked.status).toBe(403);
    expect(sessions).toBe(0);
    await gateway.close();
    await state.close();
  });

  it("pairs once, reconnects a trusted device, and exchanges encrypted requests", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const options = {
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      loginName: "alice",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async (request: RequestEnvelope) =>
          request.method === "thread/start"
            ? { thread: { id: "thread-1" } }
            : request.payload,
      }),
    };
    const gateway = await DirectGateway.start(options);

    const paired = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });
    expect(paired.accepted).toMatchObject({ loginName: "alice" });
    await expect(
      roundTrip(paired.socket, paired.session, { answer: 42 }),
    ).resolves.toEqual({
      answer: 42,
    });
    await expect(
      requestWithKey(
        paired.socket,
        paired.session,
        "thread/start",
        { cwd: "/work" },
        "durable-thread-start-key",
      ),
    ).resolves.toEqual({ thread: { id: "thread-1" } });
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT count(*) FROM durable_mutation_claims WHERE result_json IS NOT NULL",
          )[0]?.values[0]?.[0],
      ),
    ).resolves.toBe(1);
    const largePayload = "x".repeat(3_500_000);
    await expect(
      roundTrip(paired.socket, paired.session, largePayload),
    ).resolves.toBe(largePayload);
    paired.socket.close();
    await onceClosed(paired.socket);

    const trusted = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: { mode: "connect" },
    });
    await expect(
      roundTrip(trusted.socket, trusted.session, "again"),
    ).resolves.toBe("again");
    trusted.socket.close();
    await onceClosed(trusted.socket);

    await gateway.close();
    await state.close();
  }, 30_000);

  it("fails a rejected claimed thread/start closed without replaying it", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    let calls = 0;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async () => {
          calls += 1;
          throw new Error(
            "app-server disconnected after accepting thread/start",
          );
        },
      }),
    });
    const client = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });

    const first = await requestOutcomeWithKey(
      client.socket,
      client.session,
      "thread/start",
      { cwd: "/work" },
      "rejected-thread-start-key",
    );
    expect(first).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    if (first.ok) throw new Error("Expected thread/start to fail closed");
    const retry = await requestOutcomeWithKey(
      client.socket,
      client.session,
      "thread/start",
      { cwd: "/work" },
      "rejected-thread-start-key",
    );
    expect(retry).toMatchObject({
      ok: false,
      error: {
        code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
        retryable: false,
      },
    });
    expect(calls).toBe(1);
    await expect(
      state.read(
        (database) =>
          database.exec(
            "SELECT durable_mutation_claims.result_json, idempotency_keys.result_json, idempotency_keys.expires_at FROM durable_mutation_claims JOIN idempotency_keys USING (key)",
          )[0]?.values[0],
      ),
    ).resolves.toEqual([
      JSON.stringify({ ok: false, error: first.error }),
      JSON.stringify({ ok: false, error: first.error }),
      "9999-12-31T23:59:59.999Z",
    ]);

    client.socket.close();
    await onceClosed(client.socket);
    await gateway.close();
    await state.close();
  });

  it("returns a claimed turn/queue success once and permanently disables content replay", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const calls = new Map<string, number>();
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async (request: RequestEnvelope) => {
          calls.set(request.method, (calls.get(request.method) ?? 0) + 1);
          const payload = request.payload as Record<string, unknown>;
          if (request.method === "turn/start") {
            return {
              turn: {
                id: "turn-1",
                status: "inProgress",
                items: [{ text: "PRIVATE DIRECT TURN PROMPT" }],
              },
            };
          }
          if (request.method === "queue/add") {
            return {
              id: "queue-1",
              threadId: payload.threadId,
              status: "pending",
              turnPayload: {
                clientUserMessageId: payload.clientUserMessageId,
                input: payload.input,
              },
            };
          }
          return {};
        },
      }),
    });
    const client = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });
    const cases = [
      {
        method: "turn/start",
        key: "durable-turn-start-key",
        payload: {
          threadId: "thread-1",
          clientUserMessageId: "operation-turn-1",
          input: [{ type: "text", text: "PRIVATE DIRECT TURN PROMPT" }],
        },
      },
      {
        method: "queue/add",
        key: "durable-queue-add-key",
        payload: {
          threadId: "thread-1",
          clientUserMessageId: "operation-queue-1",
          input: [{ type: "text", text: "PRIVATE DIRECT QUEUE PROMPT" }],
        },
      },
    ];

    for (const entry of cases) {
      await expect(
        requestWithKey(
          client.socket,
          client.session,
          entry.method,
          entry.payload,
          entry.key,
        ),
      ).resolves.toMatchObject(
        entry.method === "turn/start"
          ? { turn: { id: "turn-1" } }
          : { id: "queue-1", status: "pending" },
      );
      await expect(
        requestOutcomeWithKey(
          client.socket,
          client.session,
          entry.method,
          entry.payload,
          entry.key,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: "IDEMPOTENCY_OUTCOME_INDETERMINATE",
          retryable: false,
        },
      });
      expect(calls.get(entry.method)).toBe(1);
    }
    const persisted = JSON.stringify(
      await state.read(
        (database) =>
          database.exec(
            "SELECT durable_mutation_claims.result_json, idempotency_keys.result_json, idempotency_keys.expires_at FROM durable_mutation_claims JOIN idempotency_keys USING (key) WHERE durable_mutation_claims.method IN ('turn/start', 'queue/add') ORDER BY durable_mutation_claims.method",
          )[0]?.values,
      ),
    );
    expect(persisted).not.toContain("PRIVATE DIRECT TURN PROMPT");
    expect(persisted).not.toContain("PRIVATE DIRECT QUEUE PROMPT");
    expect(persisted.match(/IDEMPOTENCY_OUTCOME_INDETERMINATE/gu)).toHaveLength(
      4,
    );
    expect(persisted.match(/9999-12-31T23:59:59.999Z/gu)).toHaveLength(2);

    client.socket.close();
    await onceClosed(client.socket);
    await gateway.close();
    await state.close();
  });

  it("never replays rejected claimed turn/start and queue/add mutations", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const calls = new Map<string, number>();
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async (request: RequestEnvelope) => {
          calls.set(request.method, (calls.get(request.method) ?? 0) + 1);
          throw new Error(`disconnect after accepting ${request.method}`);
        },
      }),
    });
    const client = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });

    for (const method of ["turn/start", "queue/add"]) {
      const payload = {
        threadId: "thread-1",
        clientUserMessageId: `operation-${method}`,
        input: [{ type: "text", text: "PRIVATE REJECTED DIRECT PROMPT" }],
      };
      const key = `rejected-${method}-key`;
      const first = await requestOutcomeWithKey(
        client.socket,
        client.session,
        method,
        payload,
        key,
      );
      expect(first).toMatchObject({
        ok: false,
        error: { code: "IDEMPOTENCY_OUTCOME_INDETERMINATE" },
      });
      await expect(
        requestOutcomeWithKey(
          client.socket,
          client.session,
          method,
          payload,
          key,
        ),
      ).resolves.toEqual(first);
      expect(calls.get(method)).toBe(1);
    }

    client.socket.close();
    await onceClosed(client.socket);
    await gateway.close();
    await state.close();
  });

  it("accepts an unknown device only as a pending login", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    let finishAuthentication:
      (() => Promise<(() => Promise<void> | void) | void>) | undefined;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: (_device, context) => {
        finishAuthentication = context.onAuthenticated;
        return { request: async () => "pending" };
      },
    });

    const pending = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "login",
        deviceName: "New browser",
        rememberDevice: true,
      },
    });
    const devices = new DeviceRegistry(state);
    await expect(devices.get("browser-1")).resolves.toBeUndefined();
    expect(finishAuthentication).toBeTypeOf("function");
    await finishAuthentication!();
    await expect(devices.get("browser-1")).resolves.toMatchObject({
      name: "New browser",
    });

    pending.socket.close();
    await onceClosed(pending.socket);
    await gateway.close();
    await state.close();
  });

  it("reactivates a revoked saved identity only after explicit remembered login authentication", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const devices = new DeviceRegistry(state);
    await devices.enrollAuthenticated({
      deviceId: "browser-1",
      deviceName: "Old browser",
      publicKey: deviceKeys.publicKey,
    });
    await devices.revoke("browser-1");
    let rememberedDevice = false;
    let finishAuthentication:
      (() => Promise<(() => Promise<void> | void) | void>) | undefined;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: (_device, context) => {
        rememberedDevice = context.rememberedDevice;
        finishAuthentication = context.onAuthenticated;
        return { request: async () => "pending" };
      },
    });

    const pending = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "login",
        deviceName: "Trusted again",
        rememberDevice: true,
      },
    });
    expect(rememberedDevice).toBe(true);
    await expect(
      devices.verify("browser-1", deviceKeys.publicKey),
    ).rejects.toMatchObject({ code: "REVOKED" });
    await finishAuthentication!();
    await expect(
      devices.verify("browser-1", deviceKeys.publicKey),
    ).resolves.toMatchObject({ name: "Trusted again" });

    pending.socket.close();
    await onceClosed(pending.socket);
    await gateway.close();
    await state.close();
  });

  it("returns an encrypted reauthentication rejection for a revoked trusted connect", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const devices = new DeviceRegistry(state);
    await devices.enrollAuthenticated({
      deviceId: "browser-1",
      deviceName: "Remembered browser",
      publicKey: deviceKeys.publicKey,
    });
    await devices.revoke("browser-1");
    let sessions = 0;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => {
        sessions += 1;
        return { request: async () => "unexpected" };
      },
    });

    await expect(
      rejectedHandshakeResult({
        port: gateway.port,
        deviceKeys,
        hostPublicKey: hostKeys.publicKey,
        auth: { mode: "connect" },
      }),
    ).resolves.toEqual({
      result: {
        version: 1,
        ok: false,
        error: { code: "REAUTH_REQUIRED" },
      },
      code: 1008,
      reason: "REAUTH_REQUIRED",
    });
    expect(sessions).toBe(0);

    await gateway.close();
    await state.close();
  });

  it("resumes only a ticket bound to the Noise device identity", async () => {
    const state = await stateStore();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    const sessions = new AuthenticatedSessionRegistry();
    const binding = {
      principal: "user" as const,
      nodeId: "node-1",
      userId: "unix:1000",
      deviceId: "browser-1",
      devicePublicKey: Buffer.from(deviceKeys.publicKey).toString("base64url"),
      rememberedDevice: false,
    };
    const resumeToken = sessions.issueResumeTicket(
      sessions.captureGeneration(),
      binding,
    )!;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: (device, context) =>
        new AuthenticatedGatewaySession({
          inner: {
            request: async (request: RequestEnvelope) => request.payload,
          },
          passkeys: {
            count: async () => 1,
          } as unknown as PasskeyRegistry,
          newlyPaired: context.newlyPaired,
          ...(context.resumeToken ? { resumeToken: context.resumeToken } : {}),
          resumeAuthenticatedSession: (token, revoke) =>
            sessions.resume(
              token,
              {
                ...binding,
                deviceId: device.id,
                devicePublicKey: Buffer.from(device.publicKey).toString(
                  "base64url",
                ),
              },
              revoke,
            ),
        }),
    });
    const resumed = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: { mode: "resume", resumeToken },
    });
    await expect(
      roundTrip(resumed.socket, resumed.session, {
        value: "already-authenticated",
      }),
    ).resolves.toEqual({ value: "already-authenticated" });
    resumed.socket.close();
    await onceClosed(resumed.socket);

    await expect(
      rejectedHandshakeResult({
        port: gateway.port,
        deviceKeys,
        hostPublicKey: hostKeys.publicKey,
        auth: { mode: "resume", resumeToken: "B".repeat(43) },
      }),
    ).resolves.toEqual({
      result: {
        version: 1,
        ok: false,
        error: { code: "REAUTH_REQUIRED" },
      },
      code: 1008,
      reason: "REAUTH_REQUIRED",
    });
    await gateway.close();
    await state.close();
  });

  it("rejects every remembered tab after an out-of-process device revoke while preserving temporary sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-device-revoke-test-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.sqlite");
    const state = await HostStateStore.open(statePath);
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    await new DeviceRegistry(state).enrollAuthenticated({
      deviceId: "browser-1",
      deviceName: "Remembered browser",
      publicKey: deviceKeys.publicKey,
    });
    const sessions = new AuthenticatedSessionRegistry();
    const baseBinding = {
      principal: "user" as const,
      nodeId: "node-1",
      userId: "unix:1000",
      deviceId: "browser-1",
      devicePublicKey: Buffer.from(deviceKeys.publicKey).toString("base64url"),
    };
    const generation = sessions.captureGeneration();
    const rememberedBinding = { ...baseBinding, rememberedDevice: true };
    const keyMismatchTicket = sessions.issueResumeTicket(
      generation,
      rememberedBinding,
    )!;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: async (device, context) => {
        const binding = {
          ...baseBinding,
          deviceId: device.id,
          devicePublicKey: Buffer.from(device.publicKey).toString("base64url"),
          rememberedDevice: context.rememberedDevice,
        };
        if (context.resumeRememberedDeviceInvalid)
          await sessions.revokeDevice(binding);
        return new AuthenticatedGatewaySession({
          inner: {
            request: async (request: RequestEnvelope) => request.payload,
          },
          passkeys: { count: async () => 1 } as unknown as PasskeyRegistry,
          newlyPaired: context.newlyPaired,
          ...(context.resumeToken ? { resumeToken: context.resumeToken } : {}),
          resumeAuthenticatedSession: (token, revoke) =>
            sessions.resume(token, binding, revoke),
        });
      },
    });

    await expect(
      rejectedHandshakeResult({
        port: gateway.port,
        deviceKeys: generateStaticKeyPair(),
        hostPublicKey: hostKeys.publicKey,
        auth: { mode: "resume", resumeToken: keyMismatchTicket },
      }),
    ).resolves.toMatchObject({
      result: { ok: false, error: { code: "REAUTH_REQUIRED" } },
    });

    const rememberedTickets = [
      sessions.issueResumeTicket(generation, rememberedBinding)!,
      sessions.issueResumeTicket(generation, rememberedBinding)!,
    ];

    const externalState = await HostStateStore.open(statePath);
    expect(await new DeviceRegistry(externalState).revoke("browser-1")).toBe(
      true,
    );
    await externalState.close();

    for (const resumeToken of rememberedTickets) {
      await expect(
        rejectedHandshakeResult({
          port: gateway.port,
          deviceKeys,
          hostPublicKey: hostKeys.publicKey,
          auth: { mode: "resume", resumeToken },
        }),
      ).resolves.toMatchObject({
        result: { ok: false, error: { code: "REAUTH_REQUIRED" } },
      });
    }

    const temporaryTicket = sessions.issueResumeTicket(generation, {
      ...baseBinding,
      rememberedDevice: false,
    })!;
    const temporary = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: { mode: "resume", resumeToken: temporaryTicket },
    });
    await expect(
      roundTrip(temporary.socket, temporary.session, { still: "valid" }),
    ).resolves.toEqual({ still: "valid" });
    temporary.socket.close();
    await onceClosed(temporary.socket);
    await gateway.close();
    await state.close();
  });

  it("replays authentication secrets only in connection memory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ce-gateway-secret-test-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "state.sqlite");
    const state = await HostStateStore.open(statePath);
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    let calls = 0;
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async () => {
          calls += 1;
          return {
            authenticated: true,
            recoveryCodes: ["RECOVERY-CODE-PLAINTEXT"],
            resumeToken: "RESUME-TOKEN-PLAINTEXT",
          };
        },
      }),
    });
    const client = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });
    const first = await requestWithKey(
      client.socket,
      client.session,
      "auth/register/verify",
      { response: { id: "credential" } },
      "secret-idempotency-key",
    );
    const retry = await requestWithKey(
      client.socket,
      client.session,
      "auth/register/verify",
      { response: { id: "credential" } },
      "secret-idempotency-key",
    );
    expect(retry).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      state.read(
        (database) =>
          database.exec("SELECT count(*) FROM idempotency_keys")[0]
            ?.values[0]?.[0],
      ),
    ).resolves.toBe(0);

    client.socket.close();
    await onceClosed(client.socket);
    await gateway.close();
    await state.close();
    const persisted = await readFile(statePath);
    expect(persisted.includes(Buffer.from("RECOVERY-CODE-PLAINTEXT"))).toBe(
      false,
    );
    expect(persisted.includes(Buffer.from("RESUME-TOKEN-PLAINTEXT"))).toBe(
      false,
    );
  });

  it("does not let a slow read block a later mutation", async () => {
    const state = await stateStore();
    const devices = new DeviceRegistry(state);
    const grant = await devices.issuePairing();
    const hostKeys = generateStaticKeyPair();
    const deviceKeys = generateStaticKeyPair();
    let finishRead: (() => void) | undefined;
    const readPending = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let mutationStarted: (() => void) | undefined;
    const mutationSeen = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const gateway = await DirectGateway.start({
      host: "127.0.0.1",
      port: 0,
      nodeId: "node-1",
      userId: "unix:1000",
      identity: hostKeys,
      hostFingerprint: `sha256:${"A".repeat(43)}`,
      state,
      createSession: () => ({
        request: async (request: RequestEnvelope) => {
          if (request.method === "thread/read") {
            markReadStarted?.();
            await readPending;
          }
          if (request.method === "turn/start") mutationStarted?.();
          return {};
        },
      }),
    });
    const client = await connectClient({
      port: gateway.port,
      deviceKeys,
      hostPublicKey: hostKeys.publicKey,
      auth: {
        mode: "pair",
        pairingId: grant.pairingId,
        secret: grant.secret,
        deviceName: "Test browser",
      },
    });

    sendRequest(client.socket, client.session, "thread/read", {});
    await readStarted;
    sendRequest(client.socket, client.session, "turn/start", {});
    await expect(
      Promise.race([
        mutationSeen.then(() => "started"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), 250),
        ),
      ]),
    ).resolves.toBe("started");

    finishRead?.();
    client.socket.close();
    await onceClosed(client.socket);
    await gateway.close();
    await state.close();
  });
});

async function connectClient(input: {
  port: number;
  deviceKeys: ReturnType<typeof generateStaticKeyPair>;
  hostPublicKey: Uint8Array;
  auth: Record<string, unknown>;
}): Promise<{
  socket: WebSocket;
  session: SecureSession;
  accepted: Record<string, unknown>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${input.port}/gateway`, {
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const prologue = encodePrologue({
    version: 1,
    userId: "unix:1000",
    nodeId: "node-1",
    deviceId: "browser-1",
  });
  const handshake = new NoiseInitiator(
    input.deviceKeys,
    input.hostPublicKey,
    prologue,
  );
  socket.send(
    JSON.stringify({
      type: "handshake/hello",
      version: PROTOCOL_VERSION,
      nodeId: "node-1",
      deviceId: "browser-1",
      message: Buffer.from(
        handshake.start(Buffer.from(JSON.stringify(input.auth))),
      ).toString("base64url"),
    }),
  );
  const reply = JSON.parse((await nextMessage(socket)).toString()) as {
    message: string;
  };
  const completed = handshake.finish(Buffer.from(reply.message, "base64url"));
  const accepted = JSON.parse(
    Buffer.from(completed.payload).toString(),
  ) as Record<string, unknown>;
  expect(accepted).toMatchObject({ ok: true });
  return { socket, session: completed.session, accepted };
}

async function rejectedHandshakeResult(input: {
  port: number;
  deviceKeys: ReturnType<typeof generateStaticKeyPair>;
  hostPublicKey: Uint8Array;
  auth: Record<string, unknown>;
}): Promise<{
  result: ReturnType<typeof parseGatewayHandshakeResult>;
  code: number;
  reason: string;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${input.port}/gateway`, {
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const handshake = new NoiseInitiator(
    input.deviceKeys,
    input.hostPublicKey,
    encodePrologue({
      version: 1,
      userId: "unix:1000",
      nodeId: "node-1",
      deviceId: "browser-1",
    }),
  );
  const replyMessage = nextMessage(socket);
  const closed = new Promise<{ code: number; reason: string }>(
    (resolve, reject) => {
      socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
      socket.once("error", reject);
    },
  );
  socket.send(
    JSON.stringify({
      type: "handshake/hello",
      version: PROTOCOL_VERSION,
      nodeId: "node-1",
      deviceId: "browser-1",
      message: Buffer.from(
        handshake.start(Buffer.from(JSON.stringify(input.auth))),
      ).toString("base64url"),
    }),
  );
  const reply = JSON.parse((await replyMessage).toString()) as {
    message: string;
  };
  const completed = handshake.finish(Buffer.from(reply.message, "base64url"));
  completed.session.dispose();
  const result = parseGatewayHandshakeResult(
    Buffer.from(completed.payload).toString("utf8"),
  );
  return { result, ...(await closed) };
}

async function roundTrip(
  socket: WebSocket,
  session: SecureSession,
  payload: unknown,
): Promise<unknown> {
  const requestNumber = ++requestCounter;
  const encrypted = session.encryptMessage(
    Buffer.from(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId: `request-${requestNumber}`,
        idempotencyKey: `idempotency-${requestNumber}`,
        method: "test/echo",
        payload,
      }),
    ),
  );
  const response = nextEncryptedMessage(socket, session);
  for (const frame of encrypted) {
    socket.send(
      JSON.stringify({
        type: "cipher",
        version: PROTOCOL_VERSION,
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        ciphertext: Buffer.from(frame.ciphertext).toString("base64url"),
      }),
    );
  }
  const value = JSON.parse(Buffer.from(await response).toString()) as {
    ok: boolean;
    result: unknown;
  };
  expect(value, JSON.stringify(value)).toMatchObject({ ok: true });
  return value.result;
}

async function requestWithKey(
  socket: WebSocket,
  session: SecureSession,
  method: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<unknown> {
  const value = await requestOutcomeWithKey(
    socket,
    session,
    method,
    payload,
    idempotencyKey,
  );
  expect(value.ok).toBe(true);
  if (!value.ok) throw new Error(`Gateway request failed: ${value.error.code}`);
  return value.result;
}

async function requestOutcomeWithKey(
  socket: WebSocket,
  session: SecureSession,
  method: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: string; message: string; retryable?: boolean };
    }
> {
  const requestNumber = ++requestCounter;
  const encrypted = session.encryptMessage(
    Buffer.from(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId: `request-${requestNumber}`,
        idempotencyKey,
        method,
        payload,
      }),
    ),
  );
  const response = nextEncryptedMessage(socket, session);
  for (const frame of encrypted) {
    socket.send(
      JSON.stringify({
        type: "cipher",
        version: PROTOCOL_VERSION,
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        ciphertext: Buffer.from(frame.ciphertext).toString("base64url"),
      }),
    );
  }
  const value = JSON.parse(Buffer.from(await response).toString()) as {
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string; retryable?: boolean };
  };
  if (value.ok) return { ok: true, result: value.result };
  if (!value.error) throw new Error("Gateway error response is missing error");
  return { ok: false, error: value.error };
}

let requestCounter = 0;

function sendRequest(
  socket: WebSocket,
  session: SecureSession,
  method: string,
  payload: unknown,
): void {
  const requestNumber = ++requestCounter;
  const frames = session.encryptMessage(
    Buffer.from(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId: `request-${requestNumber}`,
        idempotencyKey: `idempotency-${requestNumber}`,
        method,
        payload,
      }),
    ),
  );
  for (const frame of frames) {
    socket.send(
      JSON.stringify({
        type: "cipher",
        version: PROTOCOL_VERSION,
        sessionId: frame.sessionId,
        sequence: frame.sequence,
        ciphertext: Buffer.from(frame.ciphertext).toString("base64url"),
      }),
    );
  }
}

function nextMessage(socket: WebSocket): Promise<RawData> {
  return new Promise((resolve, reject) => {
    socket.once("message", resolve);
    socket.once("error", reject);
  });
}

function nextEncryptedMessage(
  socket: WebSocket,
  session: SecureSession,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const handleMessage = (data: RawData) => {
      try {
        const wire = JSON.parse(data.toString()) as GatewayCipherFrame;
        const plaintext = session.decryptMessage({
          sessionId: wire.sessionId,
          sequence: wire.sequence,
          ciphertext: Buffer.from(wire.ciphertext, "base64url"),
        });
        if (!plaintext) return;
        cleanup();
        resolve(plaintext);
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Decrypt failed"));
      }
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", handleMessage);
      socket.off("error", handleError);
    };
    socket.on("message", handleMessage);
    socket.once("error", handleError);
  });
}

function onceClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", resolve));
}

function openRawSocket(endpoint: string, autoPong = true): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      perMessageDeflate: false,
      autoPong,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rejectedWebSocketStatus(
  endpoint: string,
  origin: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { origin });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("Unexpectedly accepted WebSocket origin"));
    });
    socket.once("error", () => undefined);
  });
}

async function stateStore(): Promise<HostStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "ce-gateway-test-"));
  temporaryDirectories.push(directory);
  return HostStateStore.open(join(directory, "state.sqlite"));
}
