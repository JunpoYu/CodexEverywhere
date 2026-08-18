import {
  GATEWAY_API_VERSION,
  MutationOutcomeUnknownError,
  type GatewayEventEnvelopeV2,
  type GatewayMethodName,
  type InputOf,
  type OutputOf,
  type RequestOptionsOf,
} from "@codex-everywhere/protocol/v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openTransport: vi.fn(),
  saveHost: vi.fn(),
}));

vi.mock("../../storage.js", () => ({
  saveHost: mocks.saveHost,
}));

vi.mock("./encrypted-transport.js", () => ({
  EncryptedGatewayV2Transport: { open: mocks.openTransport },
}));

import {
  loginHost,
  normalizeWebAuthnResponse,
  rotateRecoveryCodes,
  type HostLoginOptions,
} from "./connect-host.js";
import type {
  EventfulGatewayV2Transport,
  GatewayPort,
} from "./gateway-port.js";

beforeEach(() => {
  mocks.openTransport.mockReset();
  mocks.saveHost.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("secret-bearing Web identity mutations", () => {
  it("reuses one operation key after a transport-unknown response", async () => {
    vi.useFakeTimers();
    const gateway = new RecoveringGateway();

    const result = rotateRecoveryCodes(gateway);
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toEqual(["replacement-code"]);
    expect(gateway.operationKeys).toHaveLength(2);
    expect(new Set(gateway.operationKeys).size).toBe(1);
  });
});

describe("WebAuthn JSON boundary", () => {
  it("removes the undefined compatibility fields returned by SimpleWebAuthn", () => {
    const response = normalizeWebAuthnResponse({
      id: "credential-id",
      rawId: "credential-id",
      response: {
        attestationObject: "attestation",
        clientDataJSON: "client-data",
        transports: undefined,
        publicKeyAlgorithm: undefined,
        publicKey: undefined,
        authenticatorData: undefined,
      },
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: undefined,
    });

    expect(response).toEqual({
      id: "credential-id",
      rawId: "credential-id",
      response: {
        attestationObject: "attestation",
        clientDataJSON: "client-data",
      },
      type: "public-key",
      clientExtensionResults: {},
    });
  });

  it("rejects values that are not JSON objects", () => {
    expect(() => normalizeWebAuthnResponse(undefined)).toThrow(
      "Passkey 响应不是 JSON 对象",
    );
  });
});

describe("temporary Web login persistence", () => {
  it("keeps temporary device keys and resume tickets in memory only", async () => {
    mocks.openTransport.mockResolvedValue(new LoginTransport());

    const result = await loginHost(testHost(), recoveryLogin(false));

    expect(result.temporary).toBe(true);
    expect(mocks.saveHost).not.toHaveBeenCalled();
    expect(mocks.openTransport).toHaveBeenCalledTimes(1);
    expect(mocks.openTransport).toHaveBeenCalledWith(
      expect.objectContaining({ deviceSecretKey: "A".repeat(43) }),
      expect.objectContaining({
        mode: "login",
        rememberDevice: false,
      }),
    );
    await result.gateway.close();
  });

  it("persists the device only after an explicitly remembered login", async () => {
    mocks.openTransport.mockResolvedValue(new LoginTransport());
    const host = testHost();

    const result = await loginHost(host, recoveryLogin(true));

    expect(result.temporary).toBe(false);
    expect(mocks.saveHost).toHaveBeenCalledOnce();
    expect(mocks.saveHost).toHaveBeenCalledWith(host);
    await result.gateway.close();
  });
});

class RecoveringGateway implements GatewayPort {
  readonly operationKeys: string[] = [];

  request<Method extends GatewayMethodName>(
    method: Method,
    _input: InputOf<Method>,
    options: RequestOptionsOf<Method>,
  ): Promise<OutputOf<Method>> {
    if (method !== "auth/recovery/rotate" || !("operationKey" in options)) {
      return Promise.reject(new Error(`Unexpected method: ${method}`));
    }
    this.operationKeys.push(options.operationKey);
    if (this.operationKeys.length === 1) {
      return Promise.reject(
        new MutationOutcomeUnknownError(method, options.operationKey),
      );
    }
    return Promise.resolve({
      version: 1,
      recoveryCodes: ["replacement-code"],
    }) as Promise<OutputOf<Method>>;
  }

  onEvent(_listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return () => undefined;
  }

  onConnectionLost(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onConnectionRestored(_listener: () => void): () => void {
    return () => undefined;
  }

  close(): void {}
}

class LoginTransport implements EventfulGatewayV2Transport {
  async exchange(request: unknown): Promise<unknown> {
    const envelope = request as {
      readonly requestId: string;
      readonly method: string;
    };
    const result =
      envelope.method === "auth/status"
        ? {
            version: 1,
            initialized: true,
            authenticated: false,
            passkeyAvailable: true,
            passwordAvailable: true,
            temporary: true,
          }
        : envelope.method === "auth/recover"
          ? {
              version: 1,
              authenticated: true,
              principal: "user",
              loginName: "alice",
              rememberedDevice: false,
              resumeToken: "memory-only-ticket",
            }
          : undefined;
    if (result === undefined) {
      throw new Error(`Unexpected method: ${envelope.method}`);
    }
    return {
      version: GATEWAY_API_VERSION,
      requestId: envelope.requestId,
      ok: true,
      result,
    };
  }

  onEvent(_listener: (event: GatewayEventEnvelopeV2) => void): () => void {
    return () => undefined;
  }

  onConnectionLost(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  close(): void {}
}

function testHost() {
  return {
    id: "host-1",
    name: "HPC",
    loginName: "alice",
    endpoint: "wss://host.invalid",
    transport: "direct" as const,
    nodeId: "node-1",
    userId: "unix:alice",
    hostPublicKey: "A".repeat(43),
    hostFingerprint: "fingerprint",
    deviceId: "device-1",
    deviceName: "Browser",
    devicePublicKey: "A".repeat(43),
    deviceSecretKey: "A".repeat(43),
  };
}

function recoveryLogin(rememberDevice: boolean): HostLoginOptions {
  return {
    method: "recovery",
    deviceName: rememberDevice ? "Browser" : "Temporary Browser",
    rememberDevice,
    recoveryCode: "RECOVERY-CODE",
  };
}
