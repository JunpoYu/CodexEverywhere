import { createHash, randomBytes } from "node:crypto";

export type AuthenticationAttemptKind = "password" | "recovery";

export type AuthenticatedSessionBinding = {
  principal: "user" | "host-admin";
  nodeId: string;
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  rememberedDevice: boolean;
};

export type CredentialMutationResult<T> = {
  result: T;
  generation: number;
};

export type CredentialMutationRunner = <T>(
  expectedGeneration: number,
  operation: () => Promise<T>,
  options?: { revokeAllAfter?: boolean },
) => Promise<CredentialMutationResult<T>>;

type ResumeTicket<TMetadata> = {
  binding: AuthenticatedSessionBinding;
  deviceKey: string;
  generation: number;
  metadata: TMetadata;
};

type ResumeTicketMetadataArguments<TMetadata> = [TMetadata] extends [undefined]
  ? []
  : [metadata: TMetadata];

const DEFAULT_MAX_RESUME_TICKETS = 1_024;
const MAX_RESUME_TICKETS_PER_DEVICE = 16;

export class AuthenticationRateLimiter {
  readonly #attempts = new Map<AuthenticationAttemptKind, number[]>();

  consume(kind: AuthenticationAttemptKind, now = Date.now()): void {
    const policy =
      kind === "recovery"
        ? { limit: 10, windowMs: 5 * 60_000 }
        : { limit: 20, windowMs: 5 * 60_000 };
    const recent = (this.#attempts.get(kind) ?? []).filter(
      (attempt) => now - attempt < policy.windowMs,
    );
    if (recent.length >= policy.limit) {
      throw new Error(`Too many ${kind} attempts. Wait before trying again.`);
    }
    recent.push(now);
    this.#attempts.set(kind, recent);
  }
}

export class AuthenticatedSessionRegistry<TResumeMetadata = undefined> {
  readonly #activeSessions = new Map<
    () => void,
    { binding: AuthenticatedSessionBinding; revoke: () => void }
  >();
  readonly #resumeTickets = new Map<string, ResumeTicket<TResumeMetadata>>();
  readonly #resumeTicketsByDevice = new Map<string, Set<string>>();
  readonly #maxResumeTickets: number;
  #generation = 0;
  #credentialMutationTail: Promise<void> = Promise.resolve();

  constructor(options: { maxResumeTickets?: number } = {}) {
    this.#maxResumeTickets =
      options.maxResumeTickets ?? DEFAULT_MAX_RESUME_TICKETS;
    if (
      !Number.isSafeInteger(this.#maxResumeTickets) ||
      this.#maxResumeTickets <= 0
    ) {
      throw new Error("Authenticated session ticket limit must be positive");
    }
  }

  captureGeneration(): number {
    return this.#generation;
  }

  register(
    expectedGeneration: number,
    binding: AuthenticatedSessionBinding,
    revoke: () => void,
  ): (() => void) | undefined {
    assertBinding(binding);
    if (expectedGeneration !== this.#generation) return undefined;
    this.#activeSessions.set(revoke, { binding: { ...binding }, revoke });
    return () => this.#activeSessions.delete(revoke);
  }

  issueResumeTicket(
    expectedGeneration: number,
    binding: AuthenticatedSessionBinding,
    ...metadataArguments: ResumeTicketMetadataArguments<TResumeMetadata>
  ): string | undefined {
    assertBinding(binding);
    if (expectedGeneration !== this.#generation) return undefined;
    const deviceKey = resumeDeviceKey(binding);
    let deviceTickets = this.#resumeTicketsByDevice.get(deviceKey);
    if (!deviceTickets) {
      deviceTickets = new Set();
      this.#resumeTicketsByDevice.set(deviceKey, deviceTickets);
    }
    while (deviceTickets.size >= MAX_RESUME_TICKETS_PER_DEVICE) {
      const oldest = deviceTickets.values().next().value as string | undefined;
      if (!oldest) break;
      this.#deleteResumeTicket(oldest);
    }
    while (this.#resumeTickets.size >= this.#maxResumeTickets) {
      const oldest = this.#resumeTickets.keys().next().value as
        string | undefined;
      if (!oldest) break;
      this.#deleteResumeTicket(oldest);
    }
    deviceTickets = this.#resumeTicketsByDevice.get(deviceKey);
    if (!deviceTickets) {
      deviceTickets = new Set();
      this.#resumeTicketsByDevice.set(deviceKey, deviceTickets);
    }
    const token = randomBytes(32).toString("base64url");
    const digest = resumeTicketDigest(token);
    this.#resumeTickets.set(digest, {
      binding: { ...binding },
      deviceKey,
      generation: this.#generation,
      metadata: metadataArguments[0] as TResumeMetadata,
    });
    deviceTickets.add(digest);
    return token;
  }

  /**
   * Validate a ticket and register the resumed session in one synchronous
   * generation check. Tickets remain reusable so a successful handshake whose
   * response is lost cannot lock the still-open page out of another retry.
   * Caller-owned metadata is returned unchanged, allowing security properties
   * such as the original authentication time to survive transport reconnects.
   */
  resume(
    token: string,
    binding: AuthenticatedSessionBinding,
    revoke: () => void,
  ):
    | {
        unregister: () => void;
        generation: number;
        metadata: TResumeMetadata;
      }
    | undefined {
    assertBinding(binding);
    if (!validResumeToken(token)) return undefined;
    const digest = resumeTicketDigest(token);
    const ticket = this.#resumeTickets.get(digest);
    if (
      !ticket ||
      ticket.generation !== this.#generation ||
      !sameBinding(ticket.binding, binding)
    ) {
      return undefined;
    }
    // Refresh both eviction orders so an actively reconnecting page does not
    // acquire a hidden lifetime merely because other windows authenticate.
    this.#resumeTickets.delete(digest);
    this.#resumeTickets.set(digest, ticket);
    const deviceTickets = this.#resumeTicketsByDevice.get(ticket.deviceKey);
    deviceTickets?.delete(digest);
    deviceTickets?.add(digest);
    this.#activeSessions.set(revoke, { binding: { ...binding }, revoke });
    return {
      unregister: () => this.#activeSessions.delete(revoke),
      generation: this.#generation,
      metadata: ticket.metadata,
    };
  }

  runCredentialMutation<T>(
    expectedGeneration: number,
    operation: () => Promise<T>,
    options: { revokeAllAfter?: boolean } = {},
  ): Promise<CredentialMutationResult<T>> {
    const mutation = this.#credentialMutationTail.then(async () => {
      if (expectedGeneration !== this.#generation)
        throw new Error("Authentication was invalidated; reconnect");
      const result = await operation();
      if (expectedGeneration !== this.#generation)
        throw new Error("Authentication was invalidated; reconnect");
      if (options.revokeAllAfter) this.#revokeAllNow();
      return { result, generation: this.#generation };
    });
    this.#credentialMutationTail = mutation.then(
      () => undefined,
      () => undefined,
    );
    return mutation;
  }

  async revokeAll(): Promise<void> {
    const revoked = this.#credentialMutationTail.then(() =>
      this.#revokeAllNow(),
    );
    this.#credentialMutationTail = revoked.then(
      () => undefined,
      () => undefined,
    );
    await revoked;
  }

  async revokeDevice(binding: AuthenticatedSessionBinding): Promise<void> {
    assertBinding(binding);
    const revoked = this.#credentialMutationTail.then(() => {
      const deviceKey = resumeDeviceKey({
        ...binding,
        rememberedDevice: true,
      });
      const tickets = this.#resumeTicketsByDevice.get(deviceKey);
      for (const digest of [...(tickets ?? [])])
        this.#deleteResumeTicket(digest);
      const sessions = [...this.#activeSessions.values()].filter(
        (session) => resumeDeviceKey(session.binding) === deviceKey,
      );
      for (const session of sessions) {
        this.#activeSessions.delete(session.revoke);
        session.revoke();
      }
    });
    this.#credentialMutationTail = revoked.then(
      () => undefined,
      () => undefined,
    );
    await revoked;
  }

  #revokeAllNow(): void {
    this.#generation += 1;
    this.#resumeTickets.clear();
    this.#resumeTicketsByDevice.clear();
    const sessions = [...this.#activeSessions.values()];
    this.#activeSessions.clear();
    for (const session of sessions) session.revoke();
  }

  #deleteResumeTicket(digest: string): void {
    const ticket = this.#resumeTickets.get(digest);
    if (!ticket) return;
    this.#resumeTickets.delete(digest);
    const deviceTickets = this.#resumeTicketsByDevice.get(ticket.deviceKey);
    deviceTickets?.delete(digest);
    if (deviceTickets?.size === 0)
      this.#resumeTicketsByDevice.delete(ticket.deviceKey);
  }
}

function validResumeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function resumeTicketDigest(value: string): string {
  return createHash("sha256")
    .update("ce-page-session-v1\0")
    .update(value)
    .digest("base64url");
}

function resumeDeviceKey(binding: AuthenticatedSessionBinding): string {
  return [
    binding.principal,
    binding.nodeId,
    binding.userId,
    binding.deviceId,
    binding.rememberedDevice ? "remembered" : "temporary",
  ].join("\0");
}

function sameBinding(
  left: AuthenticatedSessionBinding,
  right: AuthenticatedSessionBinding,
): boolean {
  return (
    left.principal === right.principal &&
    left.nodeId === right.nodeId &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.devicePublicKey === right.devicePublicKey &&
    left.rememberedDevice === right.rememberedDevice
  );
}

function assertBinding(binding: AuthenticatedSessionBinding): void {
  if (
    (binding.principal !== "user" && binding.principal !== "host-admin") ||
    !bounded(binding.nodeId) ||
    !bounded(binding.userId) ||
    !bounded(binding.deviceId) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(binding.devicePublicKey) ||
    typeof binding.rememberedDevice !== "boolean"
  ) {
    throw new Error("Invalid authenticated session binding");
  }
}

function bounded(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
