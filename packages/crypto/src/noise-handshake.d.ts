declare module "noise-handshake" {
  export type NoiseKeyPair = {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };

  export default class NoiseHandshake {
    constructor(
      pattern: "IK",
      initiator: boolean,
      staticKeypair?: NoiseKeyPair,
    );
    readonly s: NoiseKeyPair;
    readonly rs: Uint8Array;
    readonly rx: Uint8Array;
    readonly tx: Uint8Array;
    readonly hash: Uint8Array;
    readonly complete: boolean;
    initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;
    send(payload?: Uint8Array): Uint8Array;
    recv(message: Uint8Array): Uint8Array;
  }
}

declare module "noise-handshake/cipher.js" {
  export default class NoiseCipher {
    constructor(key: Uint8Array);
    encrypt(plaintext: Uint8Array, additionalData?: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array, additionalData?: Uint8Array): Uint8Array;
  }
}
