import { describe, expect, it, vi } from "vitest";

import {
  NoiseInitiator,
  NoiseResponder,
  SecureMessageAssemblyBudget,
  base64UrlToBytes,
  bytesToBase64Url,
  encodePrologue,
  generateStaticKeyPair,
} from "./index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe("browser-compatible base64url", () => {
  it("uses only the standard base64 codec and round-trips URL-safe text", () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0xef, 0xfa);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).toBe("-__v-g");
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(base64UrlToBytes(encoded)).toEqual(bytes);
  });

  it("rejects malformed input", () => {
    expect(() => base64UrlToBytes("a")).toThrow("Invalid base64url");
    expect(() => base64UrlToBytes("not+url")).toThrow("Invalid base64url");
  });
});

describe("Noise IK secure session", () => {
  it("authenticates both static keys and encrypts in both directions", () => {
    const clientKeys = generateStaticKeyPair();
    const hostKeys = generateStaticKeyPair();
    const prologue = encodePrologue({
      version: 1,
      userId: "unix:alice",
      nodeId: "node-1",
      deviceId: "phone-1",
    });
    const initiator = new NoiseInitiator(
      clientKeys,
      hostKeys.publicKey,
      prologue,
    );
    const responder = new NoiseResponder(hostKeys, prologue);

    const pairingSecret = textEncoder.encode("one-time-secret");
    expect(
      textDecoder.decode(responder.receive(initiator.start(pairingSecret))),
    ).toBe("one-time-secret");
    expect(responder.remoteStatic()).toEqual(clientKeys.publicKey);
    const host = responder.finish(textEncoder.encode("accepted"));
    const client = initiator.finish(host.message);

    expect(host.remoteStatic).toEqual(clientKeys.publicKey);
    expect(textDecoder.decode(client.payload)).toBe("accepted");
    expect(host.session.sessionId).toBe(client.session.sessionId);
    expect(
      textDecoder.decode(
        host.session.decrypt(
          client.session.encrypt(textEncoder.encode("hello")),
        ),
      ),
    ).toBe("hello");
    expect(
      textDecoder.decode(
        client.session.decrypt(
          host.session.encrypt(textEncoder.encode("world")),
        ),
      ),
    ).toBe("world");
  });

  it("rejects replayed and out-of-order frames", () => {
    const { client, host } = connectedSessions();
    const first = client.encrypt(textEncoder.encode("first"));
    expect(textDecoder.decode(host.decrypt(first))).toBe("first");
    expect(() => host.decrypt(first)).toThrow(
      "Unexpected cipher frame sequence",
    );

    const second = client.encrypt(textEncoder.encode("second"));
    const third = client.encrypt(textEncoder.encode("third"));
    expect(() => host.decrypt(third)).toThrow(
      "Unexpected cipher frame sequence",
    );
    expect(textDecoder.decode(host.decrypt(second))).toBe("second");
  });

  it("rejects ciphertext tampering", () => {
    const { client, host } = connectedSessions();
    const frame = client.encrypt(textEncoder.encode("protected"));
    frame.ciphertext[0] = (frame.ciphertext[0] ?? 0) ^ 1;
    expect(() => host.decrypt(frame)).toThrow();
  });

  it("fragments and reassembles multi-megabyte application messages", () => {
    const { client, host } = connectedSessions();
    const message = new Uint8Array(3_500_000);
    for (let index = 0; index < message.length; index += 1) {
      message[index] = index % 251;
    }

    const frames = client.encryptMessage(message);
    expect(frames.length).toBeGreaterThan(50);
    let received: Uint8Array | undefined;
    for (const frame of frames) received = host.decryptMessage(frame);
    expect(received?.byteLength).toBe(message.byteLength);
    for (let index = 0; index < message.length; index += 1) {
      if (received?.[index] !== message[index]) {
        throw new Error(`Reassembled message differs at byte ${index}`);
      }
    }
  }, 20_000);

  it("keeps small application messages compatible with single frames", () => {
    const { client, host } = connectedSessions();
    const message = textEncoder.encode("small message");
    const frames = client.encryptMessage(message);
    expect(frames).toHaveLength(1);
    expect(Array.from(host.decryptMessage(frames[0]!) ?? [])).toEqual(
      Array.from(message),
    );
  });

  it("rejects an oversized single Noise frame before advancing sequence", () => {
    const { client, host } = connectedSessions();
    expect(() => client.encrypt(new Uint8Array(65_520))).toThrow(
      "exceeds maximum",
    );
    const valid = client.encrypt(textEncoder.encode("still synchronized"));
    expect(textDecoder.decode(host.decrypt(valid))).toBe("still synchronized");
  });

  it("releases an incomplete fragment assembly after its deadline", async () => {
    const budget = new SecureMessageAssemblyBudget(1_000_000);
    const { client, host } = connectedSessions({
      maxReceiveMessageBytes: 1_000_000,
      fragmentAssemblyTimeoutMs: 20,
      assemblyBudget: budget,
    });
    const frames = client.encryptMessage(new Uint8Array(400_000));

    expect(host.decryptMessage(frames[0]!)).toBeUndefined();
    expect(budget.reservedBytes).toBe(400_000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(budget.reservedBytes).toBe(0);
    expect(() => host.decryptMessage(frames[1]!)).toThrow(
      "Unexpected secure message fragment",
    );
  });

  it("does not let slow fragments extend the absolute assembly deadline", async () => {
    vi.useFakeTimers();
    const budget = new SecureMessageAssemblyBudget(1_000_000);
    const { client, host } = connectedSessions({
      maxReceiveMessageBytes: 1_000_000,
      fragmentAssemblyTimeoutMs: 50,
      fragmentAssemblyAbsoluteTimeoutMs: 120,
      assemblyBudget: budget,
    });
    const frames = client.encryptMessage(new Uint8Array(400_000));

    try {
      expect(host.decryptMessage(frames[0]!)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(40);
      expect(host.decryptMessage(frames[1]!)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(40);
      expect(host.decryptMessage(frames[2]!)).toBeUndefined();
      expect(budget.reservedBytes).toBe(400_000);

      await vi.advanceTimersByTimeAsync(41);
      expect(budget.reservedBytes).toBe(0);
      expect(() => host.decryptMessage(frames[3]!)).toThrow(
        "Unexpected secure message fragment",
      );
    } finally {
      host.dispose();
      vi.useRealTimers();
    }
  });

  it("enforces an aggregate fragment budget across sessions", () => {
    const budget = new SecureMessageAssemblyBudget(600_000);
    const first = connectedSessions({
      maxReceiveMessageBytes: 1_000_000,
      assemblyBudget: budget,
    });
    const second = connectedSessions({
      maxReceiveMessageBytes: 1_000_000,
      assemblyBudget: budget,
    });
    const firstFrames = first.client.encryptMessage(new Uint8Array(400_000));
    const secondFrames = second.client.encryptMessage(new Uint8Array(400_000));

    expect(first.host.decryptMessage(firstFrames[0]!)).toBeUndefined();
    expect(() => second.host.decryptMessage(secondFrames[0]!)).toThrow(
      "assembly budget exceeded",
    );
    expect(budget.reservedBytes).toBe(400_000);
    first.host.dispose();
    expect(budget.reservedBytes).toBe(0);
  });
});

function connectedSessions(
  hostOptions: ConstructorParameters<typeof NoiseResponder>[2] = {},
) {
  const clientKeys = generateStaticKeyPair();
  const hostKeys = generateStaticKeyPair();
  const prologue = encodePrologue({
    version: 1,
    userId: "unix:alice",
    nodeId: "node-1",
    deviceId: "phone-1",
  });
  const initiator = new NoiseInitiator(
    clientKeys,
    hostKeys.publicKey,
    prologue,
  );
  const responder = new NoiseResponder(hostKeys, prologue, hostOptions);
  responder.receive(initiator.start());
  const response = responder.finish();
  const host = response.session;
  const client = initiator.finish(response.message).session;
  return { client, host };
}
