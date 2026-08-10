import {
  loadAdminInstallation,
  type AdminControllerConfig,
} from "../admin/controller-config.js";
import { inspectSshUnixAccount } from "../admin/unix-accounts.js";
import { inspectAdminRelayCapabilityRenewal } from "./admin-relay-capability-renewal.js";

export type AdminControllerAuthorizationStatus = {
  relayAuthorization: string;
  rootRegistration: string;
};

export async function inspectAdminControllerAuthorizationStatus(
  config: AdminControllerConfig,
  options: {
    now?: number;
    loadInstallation?: typeof loadAdminInstallation;
    inspectAccount?: typeof inspectSshUnixAccount;
  } = {},
): Promise<AdminControllerAuthorizationStatus> {
  let relayAuthorization: string;
  try {
    const capability = inspectAdminRelayCapabilityRenewal(
      config.routeCapability,
      options.now,
    );
    relayAuthorization = !capability.provisioned
      ? "INVALID: expected a provisioned host-admin route capability"
      : (capability.remainingMs ?? 0) <= 0
        ? `EXPIRED at ${capability.expiresAt ?? "unknown"}; same-route renewal retries while the Controller is running`
        : capability.renewalDue
          ? `renewal due before ${capability.expiresAt ?? "unknown"}; same-route renewal retries while the Controller is running`
          : `healthy until ${capability.expiresAt ?? "unknown"}`;
  } catch {
    relayAuthorization = "INVALID: cannot parse Relay capability metadata";
  }

  let rootRegistration: string;
  try {
    const installation = await (
      options.loadInstallation ?? loadAdminInstallation
    )();
    if (installation.version !== 2) {
      rootRegistration =
        "MIGRATION REQUIRED: root must rerun ce admin install-controller once before the current capability expires";
    } else {
      const account = await (options.inspectAccount ?? inspectSshUnixAccount)(
        config.runAsUser,
      );
      const registrationMatches =
        installation.runAsUser === config.runAsUser &&
        installation.runAsUid === config.runAsUid &&
        installation.adminHandle === config.adminHandle &&
        installation.installationId === config.installationId &&
        installation.serverName === config.serverName &&
        installation.routeId === config.routeId &&
        installation.home === config.home &&
        account.eligible &&
        account.account.username === installation.runAsUser &&
        account.account.uid === installation.runAsUid &&
        account.account.gid === installation.runAsGid &&
        account.account.home === installation.runAsHome &&
        account.account.shell === installation.runAsShell;
      rootRegistration = registrationMatches
        ? "version 2 UID/NSS route binding available"
        : "INVALID: version 2 root registration does not match Controller config or current NSS identity";
    }
  } catch (error) {
    rootRegistration = `INVALID: ${error instanceof Error ? error.message : "cannot read root registration"}`;
  }
  return { relayAuthorization, rootRegistration };
}
