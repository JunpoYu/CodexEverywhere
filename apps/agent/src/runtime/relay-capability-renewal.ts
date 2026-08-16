import { createHash } from "node:crypto";

import {
  RELAY_CAPABILITY_VERSION,
  inspectRouteCapability,
  routeCapabilityEffectiveExpiration,
} from "@codex-everywhere/protocol/relay-capability";

import {
  readHostConfig,
  relayTransport,
  type HostConfig,
  type HostConfigCoordination,
} from "../host/config.js";
import type { HostPaths } from "../host/paths.js";
import {
  applyRelayCapabilityRenewal,
  type UserSelfProvisioningGrant,
} from "./self-service-provisioning.js";
import { requestRootlessSelfProvisioningGrant } from "./rootless-self-provisioning.js";

export const RELAY_CAPABILITY_RENEWAL_WINDOW_MS = 30 * 86_400_000;
const MAX_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const NORMAL_RETRY_MS = 12 * 60 * 60_000;
const URGENT_RETRY_MS = 60 * 60_000;
const CRITICAL_RETRY_MS = 5 * 60_000;
// Covers the 15 s provisioner response timeout plus Relay socket open and
// registration timeouts, with room for atomic config I/O.
const RENEWAL_DEADLINE_SAFETY_MS = 45_000;
const NEAR_DEADLINE_RETRY_MS = 1_000;
const RENEWAL_REQUEST_TIMEOUT_MS = 15_000;

export type RelayCapabilityRenewalStatus = {
  provisioned: boolean;
  expiresAt?: string;
  remainingMs?: number;
  renewalDue: boolean;
};

export type RelayCapabilityRenewalResult = {
  state:
    "not-configured" | "legacy" | "fresh" | "awaiting-provisioner" | "renewed";
  config: HostConfig;
  status?: RelayCapabilityRenewalStatus;
};

type RenewalGrantRequester = (options: {
  renewalCapability: string;
}) => Promise<UserSelfProvisioningGrant>;

export function inspectRelayCapabilityRenewal(
  capability: string,
  now = Date.now(),
  renewalWindowMs = RELAY_CAPABILITY_RENEWAL_WINDOW_MS,
): RelayCapabilityRenewalStatus {
  return inspectProvisionedRelayCapabilityRenewal(
    capability,
    { principal: "user", purpose: "agent-route" },
    now,
    renewalWindowMs,
  );
}

export function inspectProvisionedRelayCapabilityRenewal(
  capability: string,
  expected: {
    principal: "user" | "host-admin";
    purpose: "agent-route" | "host-admin-route";
  },
  now = Date.now(),
  renewalWindowMs = RELAY_CAPABILITY_RENEWAL_WINDOW_MS,
): RelayCapabilityRenewalStatus {
  const payload = inspectRouteCapability(capability);
  const provisioned =
    (payload.version === 3 || payload.version === RELAY_CAPABILITY_VERSION) &&
    payload.purpose === expected.purpose &&
    (payload.version === 3
      ? expected.principal === "user"
      : payload.principal === expected.principal);
  if (!provisioned) return { provisioned: false, renewalDue: false };
  const expiresAt = routeCapabilityEffectiveExpiration(capability);
  if (!expiresAt) return { provisioned: true, renewalDue: false };
  const remainingMs = Date.parse(expiresAt) - now;
  return {
    provisioned: true,
    expiresAt,
    remainingMs,
    renewalDue: remainingMs <= renewalWindowMs,
  };
}

export async function renewRelayCapabilityIfNeeded(
  paths: HostPaths,
  options: {
    force?: boolean;
    now?: () => number;
    requestGrant?: RenewalGrantRequester;
    currentUser?: { username: string; uid: number };
    coordination?: HostConfigCoordination;
    shouldContinue?: () => boolean;
  } = {},
): Promise<RelayCapabilityRenewalResult> {
  const config = await readHostConfig(paths);
  const relay = relayTransport(config.transport);
  if (!relay) return { state: "not-configured", config };
  const now = (options.now ?? Date.now)();
  const status = inspectRelayCapabilityRenewal(relay.routeCapability, now);
  if (!status.provisioned) return { state: "legacy", config, status };
  if (!options.force && !status.renewalDue) {
    return { state: "fresh", config, status };
  }
  const requestGrant =
    options.requestGrant ??
    ((request) =>
      requestRootlessSelfProvisioningGrant({
        ...request,
        timeoutMs: RENEWAL_REQUEST_TIMEOUT_MS,
      }));
  const grant = await requestGrant({
    renewalCapability: relay.routeCapability,
  });
  if (options.shouldContinue && !options.shouldContinue()) {
    return { state: "awaiting-provisioner", config, status };
  }
  if (grant.routeId !== relay.routeId) {
    throw new Error("Host provisioner attempted to replace the Relay route ID");
  }
  const currentPayload = inspectRouteCapability(relay.routeCapability);
  const renewedPayload = inspectRouteCapability(grant.routeCapability);
  if (
    (currentPayload.version !== 3 &&
      currentPayload.version !== RELAY_CAPABILITY_VERSION) ||
    (renewedPayload.version !== 3 &&
      renewedPayload.version !== RELAY_CAPABILITY_VERSION) ||
    renewedPayload.installationId !== currentPayload.installationId ||
    renewedPayload.loginName !== currentPayload.loginName
  ) {
    throw new Error("Host provisioner returned a different Relay owner");
  }
  const renewedStatus = inspectRelayCapabilityRenewal(
    grant.routeCapability,
    now,
  );
  if (
    !renewedStatus.provisioned ||
    !renewedStatus.expiresAt ||
    !status.expiresAt ||
    Date.parse(renewedStatus.expiresAt) <= Date.parse(status.expiresAt)
  ) {
    return { state: "awaiting-provisioner", config, status };
  }
  const updated = await applyRelayCapabilityRenewal(
    paths,
    grant,
    relay.routeCapability,
    options.currentUser,
    options.coordination,
  );
  return {
    state: "renewed",
    config: updated,
    status: renewedStatus,
  };
}

export function relayCapabilityRenewalRetryDelay(
  status: RelayCapabilityRenewalStatus | undefined,
  jitterKey?: string,
  afterAttempt = false,
): number {
  let maximum: number;
  if (!status?.provisioned || status.remainingMs === undefined) {
    maximum = MAX_CHECK_INTERVAL_MS;
  } else if (!status.renewalDue) {
    maximum = Math.max(
      CRITICAL_RETRY_MS,
      Math.min(
        MAX_CHECK_INTERVAL_MS,
        status.remainingMs - RELAY_CAPABILITY_RENEWAL_WINDOW_MS,
      ),
    );
  } else if (status.remainingMs > 7 * 86_400_000) {
    maximum = NORMAL_RETRY_MS;
  } else if (status.remainingMs > 86_400_000) {
    maximum = URGENT_RETRY_MS;
  } else {
    maximum = CRITICAL_RETRY_MS;
  }
  let delay = maximum;
  if (jitterKey) {
    const spread = Math.max(1, Math.floor(maximum / 4));
    const sample = createHash("sha256")
      .update(`ce-relay-renewal-jitter-v1\0${jitterKey}`)
      .digest()
      .readUInt32BE(0);
    delay = maximum - (sample % spread);
  }
  if (status?.remainingMs === undefined) return delay;
  if (status.remainingMs <= 0) {
    // Check an already-expired capability immediately on startup. After an
    // actual attempt, retain the critical tier instead of spinning at 0 ms.
    return afterAttempt ? delay : 0;
  }
  const deadlineBound = Math.max(
    0,
    status.remainingMs - RENEWAL_DEADLINE_SAFETY_MS,
  );
  if (deadlineBound > 0) return Math.min(delay, deadlineBound);
  // There is no longer enough lifetime to promise completion. Make the first
  // best-effort attempt immediately, then use a tiny bounded delay so an
  // immediately failing provisioner cannot create a zero-delay busy loop.
  return afterAttempt
    ? Math.min(NEAR_DEADLINE_RETRY_MS, Math.max(0, status.remainingMs - 1))
    : 0;
}

export function startRelayCapabilityRenewalLoop(
  paths: HostPaths,
  options: {
    onConfig(config: HostConfig): Promise<void>;
    now?: () => number;
    requestGrant?: RenewalGrantRequester;
    currentUser?: { username: string; uid: number };
    coordination?: HostConfigCoordination;
    initialCapability?: string;
    onError?: (error: unknown) => void;
  },
): { close(): Promise<void>; checkNow(): Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let activeCapability = options.initialCapability;

  const schedule = (delay: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void checkNow(), delay);
    timer.unref?.();
  };
  const checkNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    if (timer) clearTimeout(timer);
    timer = undefined;
    running = (async () => {
      let status: RelayCapabilityRenewalStatus | undefined;
      let jitterKey = activeCapability;
      try {
        if (!activeCapability) {
          const relay = relayTransport((await readHostConfig(paths)).transport);
          activeCapability = relay?.routeCapability;
          jitterKey = activeCapability;
        }
        if (activeCapability) {
          status = inspectRelayCapabilityRenewal(
            activeCapability,
            (options.now ?? Date.now)(),
          );
        }
        if (stopped) return;
        const result = await renewRelayCapabilityIfNeeded(paths, {
          ...(options.now ? { now: options.now } : {}),
          ...(options.requestGrant
            ? { requestGrant: options.requestGrant }
            : {}),
          ...(options.currentUser ? { currentUser: options.currentUser } : {}),
          ...(options.coordination
            ? { coordination: options.coordination }
            : {}),
          shouldContinue: () => !stopped,
        });
        if (stopped) return;
        await options.onConfig(result.config);
        if (stopped) return;
        activeCapability = relayTransport(
          result.config.transport,
        )?.routeCapability;
        jitterKey = activeCapability;
        status = activeCapability
          ? inspectRelayCapabilityRenewal(
              activeCapability,
              (options.now ?? Date.now)(),
            )
          : result.status;
      } catch (error) {
        if (stopped) return;
        if (activeCapability) {
          status = inspectRelayCapabilityRenewal(
            activeCapability,
            (options.now ?? Date.now)(),
          );
        }
        options.onError?.(error);
      } finally {
        running = undefined;
        schedule(relayCapabilityRenewalRetryDelay(status, jitterKey, true));
      }
    })();
    return running;
  };

  let initialStatus: RelayCapabilityRenewalStatus | undefined;
  if (activeCapability) {
    initialStatus = inspectRelayCapabilityRenewal(
      activeCapability,
      (options.now ?? Date.now)(),
    );
  }
  schedule(relayCapabilityRenewalRetryDelay(initialStatus, activeCapability));
  return {
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await running;
    },
    checkNow,
  };
}
