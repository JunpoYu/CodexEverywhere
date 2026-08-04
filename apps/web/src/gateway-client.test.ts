import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GatewayClient,
  connectionTargets,
  firstAvailableTarget,
  validatePairingDocument,
  type PairingDocument,
} from "./gateway-client.js";
import type { SavedHost } from "./storage.js";

afterEach(() => vi.unstubAllGlobals());

const pairing: PairingDocument = {
  version: 1,
  transport: "relay",
  endpoint: "wss://codex.example/relay",
  routeId: "opaque-route",
  nodeId: "node-1",
  userId: "unix:1000",
  loginName: "alice",
  hostPublicKey: "public-key",
  hostFingerprint: "fingerprint",
  pairingId: "pairing-1",
  secret: "secret",
  expiresAt: "2000-01-01T00:00:00.000Z",
};

describe("pairing document validation", () => {
  it("leaves expiration decisions to the issuing host clock", () => {
    expect(() => validatePairingDocument(pairing)).not.toThrow();
  });

  it("still rejects malformed timestamps", () => {
    expect(() =>
      validatePairingDocument({ ...pairing, expiresAt: "not-a-date" }),
    ).toThrow("格式无效");
  });

  it("rejects a malformed Linux login name field", () => {
    expect(() =>
      validatePairingDocument({ ...pairing, loginName: 1000 } as never),
    ).toThrow("格式无效");
  });
});

describe("connection target selection", () => {
  it("discovers a Direct gateway from the standard HTTPS document", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: "host/profile",
            version: 1,
            nodeId: "node-1",
            userId: "unix:1000",
            hostPublicKey: "A".repeat(43),
            hostFingerprint: `sha256:${"B".repeat(43)}`,
            directEndpoint: "wss://hpc.example/gateway",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      GatewayClient.discoverDirect("https://hpc.example/ignored"),
    ).resolves.toMatchObject({
      transport: "direct",
      endpoint: "wss://hpc.example/gateway",
      nodeId: "node-1",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://hpc.example/.well-known/codex-everywhere"),
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("tries Direct before Relay while retaining legacy endpoint compatibility", () => {
    const host: SavedHost = {
      id: "node-1",
      name: "alice",
      endpoint: "wss://relay.example/relay",
      transport: "relay",
      directEndpoint: "wss://hpc.example/gateway",
      relayEndpoint: "wss://relay.example/relay",
      routeId: "route-1",
      nodeId: "node-1",
      userId: "unix:1000",
      hostPublicKey: "A".repeat(43),
      hostFingerprint: `sha256:${"B".repeat(43)}`,
      deviceId: "device-1",
      deviceName: "Browser",
      devicePublicKey: "public-key",
      deviceSecretKey: "secret-key",
    };

    expect(connectionTargets(host)).toEqual([
      { transport: "direct", endpoint: "wss://hpc.example/gateway" },
      { transport: "relay", endpoint: "wss://relay.example/relay" },
    ]);
  });

  it("falls back to Relay only after Direct fails", async () => {
    const attempts: string[] = [];
    const result = await firstAvailableTarget(
      [
        { transport: "direct", endpoint: "wss://hpc.example/gateway" },
        { transport: "relay", endpoint: "wss://relay.example/relay" },
      ],
      async (target) => {
        attempts.push(target.transport);
        if (target.transport === "direct") throw new Error("unreachable");
        return "connected";
      },
    );

    expect(result).toBe("connected");
    expect(attempts).toEqual(["direct", "relay"]);
  });
});
