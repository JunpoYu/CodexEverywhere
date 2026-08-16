import type {
  GatewayDeviceRegistry,
  GatewayTrustedDevice,
} from "./transport-contract.js";
import type { IdentityRepository } from "../repositories/identity-repository.js";

/** Keeps transport authentication independent from the SQLite implementation. */
export class IdentityDeviceRegistryAdapter implements GatewayDeviceRegistry {
  readonly #repository: IdentityRepository;

  constructor(repository: IdentityRepository) {
    this.#repository = repository;
  }

  consumePairing(input: {
    readonly pairingId: string;
    readonly secret: string;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly publicKey: Uint8Array;
  }): Promise<GatewayTrustedDevice> {
    return this.#repository.consumePairing(input);
  }

  verify(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<GatewayTrustedDevice> {
    return this.#repository.verifyDevice(deviceId, publicKey);
  }

  match(
    deviceId: string,
    publicKey: Uint8Array,
  ): Promise<GatewayTrustedDevice | undefined> {
    return this.#repository.matchDevice(deviceId, publicKey);
  }
}
