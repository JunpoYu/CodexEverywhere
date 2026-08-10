import { userInfo } from "node:os";

import {
  RELAY_CAPABILITY_VERSION,
  inspectRouteCapability,
  routeCapabilityEffectiveExpiration,
} from "@codex-everywhere/protocol/relay-capability";

import {
  loadAdminControllerConfig,
  type AdminControllerConfig,
} from "../admin/controller-config.js";
import {
  parseAdminRouteRenewalGrant,
  type AdminRouteRenewalGrant,
} from "../admin/admin-route-provisioning.js";
import { writePrivateJsonAtomically } from "../host/process-files.js";
import {
  inspectProvisionedRelayCapabilityRenewal,
  relayCapabilityRenewalRetryDelay,
  type RelayCapabilityRenewalStatus,
} from "./relay-capability-renewal.js";
import { requestRootlessAdminRouteRenewal } from "./rootless-self-provisioning.js";

const ADMIN_RENEWAL_REQUEST_TIMEOUT_MS = 15_000;

type AdminRenewalGrantRequester = (options: {
  renewalCapability: string;
}) => Promise<AdminRouteRenewalGrant>;

export type AdminRelayCapabilityRenewalResult = {
  state: "fresh" | "awaiting-provisioner" | "renewed";
  config: AdminControllerConfig;
  status: RelayCapabilityRenewalStatus;
};

export function inspectAdminRelayCapabilityRenewal(
  capability: string,
  now = Date.now(),
): RelayCapabilityRenewalStatus {
  return inspectProvisionedRelayCapabilityRenewal(
    capability,
    { principal: "host-admin", purpose: "host-admin-route" },
    now,
  );
}

export async function renewAdminRelayCapabilityIfNeeded(
  configPath: string,
  options: {
    force?: boolean;
    now?: () => number;
    requestGrant?: AdminRenewalGrantRequester;
    currentUser?: { username: string; uid: number };
    shouldContinue?: () => boolean;
  } = {},
): Promise<AdminRelayCapabilityRenewalResult> {
  const config = await loadAdminControllerConfig(configPath);
  const now = (options.now ?? Date.now)();
  const status = inspectAdminRelayCapabilityRenewal(
    config.routeCapability,
    now,
  );
  if (!status.provisioned) {
    throw new Error(
      "Administrator Controller requires a provisioned host-admin Relay capability",
    );
  }
  if (!options.force && !status.renewalDue) {
    return { state: "fresh", config, status };
  }
  const requestGrant =
    options.requestGrant ??
    ((request) =>
      requestRootlessAdminRouteRenewal({
        ...request,
        timeoutMs: ADMIN_RENEWAL_REQUEST_TIMEOUT_MS,
      }));
  const grant = parseAdminRouteRenewalGrant(
    await requestGrant({ renewalCapability: config.routeCapability }),
  );
  if (options.shouldContinue && !options.shouldContinue()) {
    return { state: "awaiting-provisioner", config, status };
  }
  assertGrantMatchesController(grant, config, options.currentUser);
  assertCapabilityTransition(config, grant.routeCapability);
  const renewedStatus = inspectAdminRelayCapabilityRenewal(
    grant.routeCapability,
    now,
  );
  if (
    !renewedStatus.expiresAt ||
    !status.expiresAt ||
    Date.parse(renewedStatus.expiresAt) <= Date.parse(status.expiresAt)
  ) {
    return { state: "awaiting-provisioner", config, status };
  }
  const updated = await applyAdminRelayCapabilityRenewal(
    configPath,
    grant,
    config.routeCapability,
    options.currentUser,
  );
  return { state: "renewed", config: updated, status: renewedStatus };
}

export async function applyAdminRelayCapabilityRenewal(
  configPath: string,
  grantValue: unknown,
  expectedCapability: string,
  currentUser: { username: string; uid: number } = {
    username: userInfo().username,
    uid: process.getuid?.() ?? -1,
  },
): Promise<AdminControllerConfig> {
  const grant = parseAdminRouteRenewalGrant(grantValue);
  const current = await loadAdminControllerConfig(configPath);
  assertGrantMatchesController(grant, current, currentUser);
  if (current.routeCapability !== expectedCapability) {
    throw new Error(
      "Administrator Controller configuration changed while applying Relay renewal",
    );
  }
  assertCapabilityTransition(current, grant.routeCapability);
  const currentExpiration = routeCapabilityEffectiveExpiration(
    current.routeCapability,
  );
  const renewedExpiration = routeCapabilityEffectiveExpiration(
    grant.routeCapability,
  );
  if (
    !currentExpiration ||
    !renewedExpiration ||
    Date.parse(renewedExpiration) <= Date.parse(currentExpiration)
  ) {
    throw new Error(
      "Administrator Relay renewal did not extend the authorization deadline",
    );
  }
  const updated: AdminControllerConfig = {
    ...current,
    routeCapability: grant.routeCapability,
  };
  await writePrivateJsonAtomically(configPath, updated);
  return updated;
}

function assertCapabilityTransition(
  config: AdminControllerConfig,
  candidateCapability: string,
): void {
  const current = inspectRouteCapability(config.routeCapability);
  const candidate = inspectRouteCapability(candidateCapability);
  if (
    current.version !== RELAY_CAPABILITY_VERSION ||
    current.principal !== "host-admin" ||
    current.purpose !== "host-admin-route" ||
    current.installationId !== config.installationId ||
    current.loginName !== config.adminHandle ||
    current.routeId !== config.routeId ||
    candidate.version !== RELAY_CAPABILITY_VERSION ||
    candidate.principal !== "host-admin" ||
    candidate.purpose !== "host-admin-route" ||
    candidate.installationId !== config.installationId ||
    candidate.loginName !== config.adminHandle ||
    candidate.routeId !== config.routeId
  ) {
    throw new Error(
      "Host provisioner returned a different administrator Relay owner",
    );
  }
}

function assertGrantMatchesController(
  grant: AdminRouteRenewalGrant,
  config: AdminControllerConfig,
  currentUser: { username: string; uid: number } | undefined,
): void {
  const uid = currentUser?.uid ?? process.getuid?.() ?? -1;
  const username = currentUser?.username ?? config.runAsUser;
  if (
    uid !== config.runAsUid ||
    username !== config.runAsUser ||
    grant.uid !== config.runAsUid ||
    grant.username !== config.runAsUser
  ) {
    throw new Error(
      "Host provisioner returned a different Administrator Controller Unix identity",
    );
  }
  if (
    grant.adminHandle !== config.adminHandle ||
    grant.routeId !== config.routeId ||
    grant.origin !== config.origin ||
    grant.relayEndpoint !== config.relayEndpoint
  ) {
    throw new Error(
      "Host provisioner attempted to replace the Administrator Controller identity or Relay route",
    );
  }
}

export function startAdminRelayCapabilityRenewalLoop(
  configPath: string,
  options: {
    initialCapability: string;
    onConfig(config: AdminControllerConfig): Promise<void>;
    now?: () => number;
    requestGrant?: AdminRenewalGrantRequester;
    currentUser?: { username: string; uid: number };
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
      let status = inspectAdminRelayCapabilityRenewal(
        activeCapability,
        (options.now ?? Date.now)(),
      );
      let jitterKey = activeCapability;
      try {
        const result = await renewAdminRelayCapabilityIfNeeded(configPath, {
          ...(options.now ? { now: options.now } : {}),
          ...(options.requestGrant
            ? { requestGrant: options.requestGrant }
            : {}),
          ...(options.currentUser ? { currentUser: options.currentUser } : {}),
          shouldContinue: () => !stopped,
        });
        if (stopped) return;
        await options.onConfig(result.config);
        if (stopped) return;
        activeCapability = result.config.routeCapability;
        jitterKey = activeCapability;
        status = inspectAdminRelayCapabilityRenewal(
          activeCapability,
          (options.now ?? Date.now)(),
        );
      } catch (error) {
        if (stopped) return;
        status = inspectAdminRelayCapabilityRenewal(
          activeCapability,
          (options.now ?? Date.now)(),
        );
        options.onError?.(error);
      } finally {
        running = undefined;
        schedule(relayCapabilityRenewalRetryDelay(status, jitterKey, true));
      }
    })();
    return running;
  };

  schedule(
    relayCapabilityRenewalRetryDelay(
      inspectAdminRelayCapabilityRenewal(
        activeCapability,
        (options.now ?? Date.now)(),
      ),
      activeCapability,
    ),
  );
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
