export interface ServiceToken<Service> {
  readonly key: symbol;
  readonly description: string;
  readonly __service?: (_service: Service) => Service;
}

export function createServiceToken<Service>(
  description: string,
): ServiceToken<Service> {
  const normalized = description.trim();
  if (normalized.length === 0) {
    throw new TypeError("Service token description must not be empty");
  }
  return Object.freeze({
    key: Symbol(normalized),
    description: normalized,
  });
}

export class DuplicateServiceError extends Error {
  constructor(readonly tokenDescription: string) {
    super(`Service is already registered: ${tokenDescription}`);
    this.name = "DuplicateServiceError";
  }
}

export class MissingServiceError extends Error {
  constructor(readonly tokenDescription: string) {
    super(`Required service is not registered: ${tokenDescription}`);
    this.name = "MissingServiceError";
  }
}

/**
 * A deliberately small dependency registry for explicit composition roots.
 * It is not a container: it does not scan modules, construct services, or
 * mutate registrations after the root has been sealed.
 */
export class ServiceRegistry {
  readonly #services = new Map<symbol, unknown>();
  #sealed = false;

  register<Service>(token: ServiceToken<Service>, service: Service): this {
    if (this.#sealed) {
      throw new Error("Service registry is sealed");
    }
    if (this.#services.has(token.key)) {
      throw new DuplicateServiceError(token.description);
    }
    this.#services.set(token.key, service);
    return this;
  }

  has<Service>(token: ServiceToken<Service>): boolean {
    return this.#services.has(token.key);
  }

  get<Service>(token: ServiceToken<Service>): Service {
    if (!this.#services.has(token.key)) {
      throw new MissingServiceError(token.description);
    }
    return this.#services.get(token.key) as Service;
  }

  seal(): this {
    this.#sealed = true;
    return this;
  }

  get sealed(): boolean {
    return this.#sealed;
  }
}
