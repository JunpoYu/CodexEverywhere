import { describe, expect, it } from "vitest";

import {
  NoiseInitiator,
  NoiseResponder,
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
});

function connectedSessions() {
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
  responder.receive(initiator.start());
  const response = responder.finish();
  const host = response.session;
  const client = initiator.finish(response.message).session;
  return { client, host };
}
