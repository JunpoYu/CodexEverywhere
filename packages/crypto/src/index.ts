import b4a from "b4a";
import NoiseHandshake, { type NoiseKeyPair } from "noise-handshake";
import NoiseCipher from "noise-handshake/cipher.js";

export const CRYPTO_PROTOCOL = "codex-everywhere/noise-ik/v1" as const;

// Noise transport messages are capped at 65,535 bytes including the 16-byte
// ChaChaPoly authentication tag. Larger application messages are split into
// authenticated records before encryption and reassembled after decryption.
const MAX_NOISE_PLAINTEXT_BYTES = 65_535 - 16;
const MAX_SECURE_MESSAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_FRAGMENT_ASSEMBLY_TIMEOUT_MS = 15_000;
const DEFAULT_FRAGMENT_ASSEMBLY_ABSOLUTE_TIMEOUT_MS = 60_000;
const FRAGMENT_HEADER_BYTES = 16;
const MAX_FRAGMENT_PAYLOAD_BYTES =
  MAX_NOISE_PLAINTEXT_BYTES - FRAGMENT_HEADER_BYTES;
const FRAGMENT_MAGIC = Uint8Array.of(0, 0x43, 0x45, 0x01);

export type StaticKeyPair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export type CipherFrame = {
  sessionId: string;
  sequence: number;
  ciphertext: Uint8Array;
};

export type SecureSessionOptions = {
  /** Maximum size of one reassembled message received by this session. */
  maxReceiveMessageBytes?: number;
  /** Maximum idle time allowed between fragments of one message. */
  fragmentAssemblyTimeoutMs?: number;
  /** Maximum total lifetime of one fragmented message assembly. */
  fragmentAssemblyAbsoluteTimeoutMs?: number;
  /** Optional process-level budget shared by multiple receiving sessions. */
  assemblyBudget?: SecureMessageAssemblyBudget;
};

/**
 * Bounds aggregate fragment reservations across multiple sessions. Reserving
 * the declared message size (rather than only chunks received so far) prevents
 * an attacker from opening many almost-empty, very large assemblies.
 */
export class SecureMessageAssemblyBudget {
  readonly #maximumBytes: number;
  #reservedBytes = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("Secure message assembly budget must be positive");
    }
    this.#maximumBytes = maximumBytes;
  }

  get reservedBytes(): number {
    return this.#reservedBytes;
  }

  reserve(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      this.#reservedBytes + bytes > this.#maximumBytes
    ) {
      throw new Error("Secure message assembly budget exceeded");
    }
    this.#reservedBytes += bytes;
  }

  release(bytes: number): void {
    this.#reservedBytes = Math.max(0, this.#reservedBytes - bytes);
  }
}

export type NoisePrologue = {
  version: 1;
  userId: string;
  nodeId: string;
  deviceId: string;
};

export function generateStaticKeyPair(): StaticKeyPair {
  const temporary = new NoiseHandshake("IK", true);
  return cloneKeyPair(temporary.s);
}

export function encodePrologue(value: NoisePrologue): Uint8Array {
  return b4a.from(
    `${CRYPTO_PROTOCOL}\0${value.version}\0${value.userId}\0${value.nodeId}\0${value.deviceId}`,
  );
}

export function bytesToBase64Url(value: Uint8Array): string {
  return b4a
    .toString(value, "base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = (4 - (base64.length % 4)) % 4;
  return Uint8Array.from(b4a.from(`${base64}${"=".repeat(padding)}`, "base64"));
}

export class NoiseInitiator {
  readonly #handshake: NoiseHandshake;
  readonly #sessionOptions: SecureSessionOptions;

  constructor(
    localStatic: StaticKeyPair,
    remoteStatic: Uint8Array,
    prologue: Uint8Array,
    sessionOptions: SecureSessionOptions = {},
  ) {
    this.#handshake = new NoiseHandshake("IK", true, cloneKeyPair(localStatic));
    this.#handshake.initialise(b4a.from(prologue), b4a.from(remoteStatic));
    this.#sessionOptions = sessionOptions;
  }

  start(payload = new Uint8Array()): Uint8Array {
    if (this.#handshake.complete)
      throw new Error("Noise handshake is already complete");
    return this.#handshake.send(b4a.from(payload));
  }

  finish(message: Uint8Array): { payload: Uint8Array; session: SecureSession } {
    const payload = this.#handshake.recv(b4a.from(message));
    if (!this.#handshake.complete)
      throw new Error("Noise IK handshake did not complete");
    return {
      payload,
      session: sessionFromHandshake(this.#handshake, this.#sessionOptions),
    };
  }
}

export class NoiseResponder {
  readonly #handshake: NoiseHandshake;
  readonly #sessionOptions: SecureSessionOptions;

  constructor(
    localStatic: StaticKeyPair,
    prologue: Uint8Array,
    sessionOptions: SecureSessionOptions = {},
  ) {
    this.#handshake = new NoiseHandshake(
      "IK",
      false,
      cloneKeyPair(localStatic),
    );
    this.#handshake.initialise(b4a.from(prologue));
    this.#sessionOptions = sessionOptions;
  }

  receive(message: Uint8Array): Uint8Array {
    if (this.#handshake.complete)
      throw new Error("Noise handshake is already complete");
    return this.#handshake.recv(b4a.from(message));
  }

  remoteStatic(): Uint8Array {
    if (this.#handshake.complete || this.#handshake.rs.byteLength !== 32)
      throw new Error("Noise initiator identity is not available");
    return b4a.from(this.#handshake.rs);
  }

  finish(payload = new Uint8Array()): {
    message: Uint8Array;
    remoteStatic: Uint8Array;
    session: SecureSession;
  } {
    const message = this.#handshake.send(b4a.from(payload));
    if (!this.#handshake.complete)
      throw new Error("Noise IK handshake did not complete");
    return {
      message,
      remoteStatic: b4a.from(this.#handshake.rs),
      session: sessionFromHandshake(this.#handshake, this.#sessionOptions),
    };
  }
}

export class SecureSession {
  readonly sessionId: string;
  readonly #send: NoiseCipher;
  readonly #receive: NoiseCipher;
  readonly #maxReceiveMessageBytes: number;
  readonly #fragmentAssemblyTimeoutMs: number;
  readonly #fragmentAssemblyAbsoluteTimeoutMs: number;
  readonly #assemblyBudget: SecureMessageAssemblyBudget | undefined;
  #sendSequence = 0;
  #receiveSequence = 0;
  #fragments:
    | {
        count: number;
        nextIndex: number;
        totalBytes: number;
        receivedBytes: number;
        chunks: Uint8Array[];
        idleTimeout: ReturnType<typeof setTimeout>;
        absoluteTimeout: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(
    sessionId: string,
    sendKey: Uint8Array,
    receiveKey: Uint8Array,
    options: SecureSessionOptions = {},
  ) {
    this.sessionId = sessionId;
    this.#send = new NoiseCipher(b4a.from(sendKey));
    this.#receive = new NoiseCipher(b4a.from(receiveKey));
    this.#maxReceiveMessageBytes =
      options.maxReceiveMessageBytes ?? MAX_SECURE_MESSAGE_BYTES;
    this.#fragmentAssemblyTimeoutMs =
      options.fragmentAssemblyTimeoutMs ?? DEFAULT_FRAGMENT_ASSEMBLY_TIMEOUT_MS;
    this.#fragmentAssemblyAbsoluteTimeoutMs =
      options.fragmentAssemblyAbsoluteTimeoutMs ??
      DEFAULT_FRAGMENT_ASSEMBLY_ABSOLUTE_TIMEOUT_MS;
    this.#assemblyBudget = options.assemblyBudget;
    if (
      !Number.isSafeInteger(this.#maxReceiveMessageBytes) ||
      this.#maxReceiveMessageBytes <= MAX_NOISE_PLAINTEXT_BYTES ||
      this.#maxReceiveMessageBytes > MAX_SECURE_MESSAGE_BYTES
    ) {
      throw new Error("Invalid secure session receive message limit");
    }
    if (
      !Number.isFinite(this.#fragmentAssemblyTimeoutMs) ||
      this.#fragmentAssemblyTimeoutMs <= 0
    ) {
      throw new Error("Invalid secure message assembly timeout");
    }
    if (
      !Number.isFinite(this.#fragmentAssemblyAbsoluteTimeoutMs) ||
      this.#fragmentAssemblyAbsoluteTimeoutMs <= 0
    ) {
      throw new Error("Invalid secure message assembly absolute timeout");
    }
  }

  encrypt(plaintext: Uint8Array): CipherFrame {
    if (plaintext.byteLength > MAX_NOISE_PLAINTEXT_BYTES) {
      throw new Error(
        `Noise plaintext length of ${plaintext.byteLength} exceeds maximum ${MAX_NOISE_PLAINTEXT_BYTES}`,
      );
    }
    const sequence = this.#sendSequence++;
    const ciphertext = this.#send.encrypt(
      b4a.from(plaintext),
      frameAssociatedData(this.sessionId, sequence),
    );
    return { sessionId: this.sessionId, sequence, ciphertext };
  }

  decrypt(frame: CipherFrame): Uint8Array {
    if (frame.sessionId !== this.sessionId)
      throw new Error("Cipher frame belongs to another session");
    if (frame.sequence !== this.#receiveSequence) {
      throw new Error(
        `Unexpected cipher frame sequence ${frame.sequence}; expected ${this.#receiveSequence}`,
      );
    }
    const plaintext = this.#receive.decrypt(
      b4a.from(frame.ciphertext),
      frameAssociatedData(this.sessionId, frame.sequence),
    );
    this.#receiveSequence++;
    return plaintext;
  }

  encryptMessage(plaintext: Uint8Array): CipherFrame[] {
    if (plaintext.byteLength > MAX_SECURE_MESSAGE_BYTES) {
      throw new Error(
        `Secure message length of ${plaintext.byteLength} exceeds maximum ${MAX_SECURE_MESSAGE_BYTES}`,
      );
    }
    if (plaintext.byteLength <= MAX_NOISE_PLAINTEXT_BYTES) {
      return [this.encrypt(plaintext)];
    }

    const count = Math.ceil(plaintext.byteLength / MAX_FRAGMENT_PAYLOAD_BYTES);
    const frames: CipherFrame[] = [];
    for (let index = 0; index < count; index += 1) {
      const offset = index * MAX_FRAGMENT_PAYLOAD_BYTES;
      const chunk = plaintext.subarray(
        offset,
        Math.min(offset + MAX_FRAGMENT_PAYLOAD_BYTES, plaintext.byteLength),
      );
      const record = new Uint8Array(FRAGMENT_HEADER_BYTES + chunk.byteLength);
      record.set(FRAGMENT_MAGIC);
      const header = new DataView(record.buffer, record.byteOffset);
      header.setUint32(4, index);
      header.setUint32(8, count);
      header.setUint32(12, plaintext.byteLength);
      record.set(chunk, FRAGMENT_HEADER_BYTES);
      frames.push(this.encrypt(record));
    }
    return frames;
  }

  decryptMessage(frame: CipherFrame): Uint8Array | undefined {
    const plaintext = this.decrypt(frame);
    if (!isFragmentRecord(plaintext)) {
      if (this.#fragments) {
        this.#discardFragments();
        throw new Error("Secure message fragment missing");
      }
      return plaintext;
    }

    const header = new DataView(
      plaintext.buffer,
      plaintext.byteOffset,
      FRAGMENT_HEADER_BYTES,
    );
    const index = header.getUint32(4);
    const count = header.getUint32(8);
    const totalBytes = header.getUint32(12);
    if (
      count < 2 ||
      count >
        Math.ceil(MAX_SECURE_MESSAGE_BYTES / MAX_FRAGMENT_PAYLOAD_BYTES) ||
      index >= count ||
      totalBytes <= MAX_NOISE_PLAINTEXT_BYTES ||
      totalBytes > this.#maxReceiveMessageBytes
    ) {
      this.#discardFragments();
      throw new Error("Invalid secure message fragment header");
    }

    if (index === 0) {
      if (this.#fragments) {
        this.#discardFragments();
        throw new Error("Secure messages are interleaved");
      }
      this.#assemblyBudget?.reserve(totalBytes);
      this.#fragments = {
        count,
        nextIndex: 0,
        totalBytes,
        receivedBytes: 0,
        chunks: [],
        idleTimeout: this.#newFragmentTimeout(this.#fragmentAssemblyTimeoutMs),
        absoluteTimeout: this.#newFragmentTimeout(
          this.#fragmentAssemblyAbsoluteTimeoutMs,
        ),
      };
    }
    const assembly = this.#fragments;
    if (
      !assembly ||
      assembly.count !== count ||
      assembly.totalBytes !== totalBytes ||
      assembly.nextIndex !== index
    ) {
      this.#discardFragments();
      throw new Error("Unexpected secure message fragment");
    }

    const chunk = plaintext.slice(FRAGMENT_HEADER_BYTES);
    assembly.chunks.push(chunk);
    assembly.nextIndex += 1;
    assembly.receivedBytes += chunk.byteLength;
    if (assembly.receivedBytes > assembly.totalBytes) {
      this.#discardFragments();
      throw new Error("Secure message exceeds its declared length");
    }
    if (assembly.nextIndex < assembly.count) {
      clearTimeout(assembly.idleTimeout);
      assembly.idleTimeout = this.#newFragmentTimeout(
        this.#fragmentAssemblyTimeoutMs,
      );
      return undefined;
    }

    this.#discardFragments();
    if (assembly.receivedBytes !== assembly.totalBytes) {
      throw new Error("Secure message length does not match its fragments");
    }
    const message = new Uint8Array(assembly.totalBytes);
    let offset = 0;
    for (const part of assembly.chunks) {
      message.set(part, offset);
      offset += part.byteLength;
    }
    return message;
  }

  dispose(): void {
    this.#discardFragments();
  }

  #newFragmentTimeout(timeoutMs: number): ReturnType<typeof setTimeout> {
    const timeout = setTimeout(() => this.#discardFragments(), timeoutMs);
    timeout.unref?.();
    return timeout;
  }

  #discardFragments(): void {
    const assembly = this.#fragments;
    if (!assembly) return;
    this.#fragments = undefined;
    clearTimeout(assembly.idleTimeout);
    clearTimeout(assembly.absoluteTimeout);
    this.#assemblyBudget?.release(assembly.totalBytes);
  }
}

function isFragmentRecord(value: Uint8Array): boolean {
  if (value.byteLength < FRAGMENT_HEADER_BYTES) return false;
  return FRAGMENT_MAGIC.every((byte, index) => value[index] === byte);
}

function sessionFromHandshake(
  handshake: NoiseHandshake,
  options: SecureSessionOptions,
): SecureSession {
  const sessionId = bytesToBase64Url(handshake.hash.subarray(0, 18));
  // noise-handshake names keys from the remote peer's perspective: rx is
  // used to send and tx is used to receive.
  return new SecureSession(sessionId, handshake.rx, handshake.tx, options);
}

function frameAssociatedData(sessionId: string, sequence: number): Uint8Array {
  return b4a.from(`${CRYPTO_PROTOCOL}\0${sessionId}\0${sequence}`);
}

function cloneKeyPair(keyPair: NoiseKeyPair): NoiseKeyPair {
  return {
    publicKey: b4a.from(keyPair.publicKey),
    secretKey: b4a.from(keyPair.secretKey),
  };
}
