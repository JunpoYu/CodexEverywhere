import { spawn } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";

import type { RequestEnvelope } from "@codex-everywhere/protocol";

import {
  loadAdminControllerConfig,
  resolveAdminControllerPaths,
  type AdminControllerConfig,
} from "../admin/controller-config.js";
import {
  ADMIN_HELPER_PROTOCOL_VERSION,
  AdminHelperClient,
} from "../admin/control-service.js";
import { AuthenticatedGatewaySession } from "../gateway/authenticated-session.js";
import type { GatewaySession } from "../gateway/direct-gateway.js";
import { RelayConnector } from "../gateway/relay-connector.js";
import {
  AuthenticatedSessionRegistry,
  AuthenticationRateLimiter,
} from "../host/auth-security.js";
import { loadOrCreateHostIdentity } from "../host/identity.js";
import { PasskeyRegistry } from "../host/passkeys.js";
import {
  PasswordRegistry,
  loadOrCreateOpaqueServerSetup,
} from "../host/passwords.js";
import {
  ProcessLock,
  isProcessAlive,
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
  writeProcessRecord,
} from "../host/process-files.js";
import { HostStateStore } from "../host/state-store.js";
import {
  CachedDeviceTrustVerifier,
  DeviceRegistry,
  DeviceTrustError,
  type TrustedDevice,
} from "../host/devices.js";

const RECENT_AUTHENTICATION_MS = 5 * 60 * 1_000;

type AdminResumeTicketMetadata = {
  authenticatedAt: number;
};

export async function runAdminControllerService(): Promise<void> {
  const config = await loadAdminControllerConfig();
  assertControllerUser(config);
  const paths = resolveAdminControllerPaths(config.home, config.runAsUid);
  await Promise.all([
    mkdir(paths.home, { recursive: true, mode: 0o700 }),
    mkdir(paths.keysDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(paths.home, 0o700),
    chmod(paths.keysDir, 0o700),
    chmod(paths.runtimeDir, 0o700),
  ]);
  const lock = await ProcessLock.acquire(paths.lockFile);
  const state = await HostStateStore.open(paths.stateFile);
  let relay: RelayConnector | undefined;
  try {
    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    const opaqueServerSetup = await loadOrCreateOpaqueServerSetup(
      paths.keysDir,
    );
    const hostPublicKey = Buffer.from(identity.keyPair.publicKey).toString(
      "base64url",
    );
    const sessions =
      new AuthenticatedSessionRegistry<AdminResumeTicketMetadata>();
    const limiter = new AuthenticationRateLimiter();
    const deviceTrust = new CachedDeviceTrustVerifier(
      new DeviceRegistry(state),
    );
    const helper = new AdminHelperClient();
    const gatewayOptions = {
      host: "127.0.0.1",
      port: 0,
      nodeId: config.nodeId,
      userId: `admin:${config.installationId}`,
      principal: "host-admin" as const,
      loginName: config.adminHandle,
      identity: identity.keyPair,
      hostFingerprint: identity.fingerprint,
      relayEndpoint: config.relayEndpoint,
      relayRouteId: config.routeId,
      allowedOrigin: config.origin,
      state,
      createSession: async (
        device: TrustedDevice,
        context: {
          newlyPaired: boolean;
          rememberedDevice: boolean;
          resumeRememberedDeviceInvalid?: boolean;
          resumeToken?: string;
          onAuthenticated?: () => Promise<(() => Promise<void> | void) | void>;
        },
      ) => {
        let authenticatedAt: number | undefined;
        const sessionBinding = {
          principal: "host-admin" as const,
          nodeId: config.nodeId,
          userId: `admin:${config.installationId}`,
          deviceId: device.id,
          devicePublicKey: Buffer.from(device.publicKey).toString("base64url"),
          rememberedDevice: context.rememberedDevice,
        };
        if (context.resumeRememberedDeviceInvalid)
          await sessions.revokeDevice(sessionBinding);
        return new AuthenticatedGatewaySession({
          newlyPaired: context.newlyPaired,
          ...(context.onAuthenticated
            ? { onAuthenticated: context.onAuthenticated }
            : {}),
          ...(context.resumeToken ? { resumeToken: context.resumeToken } : {}),
          passkeys: new PasskeyRegistry(state, {
            origin: config.origin,
            rpId: config.rpId,
            nodeId: config.nodeId,
            userName: `admin:${config.adminHandle}`,
            userDisplayName: `${config.serverName} 管理员`,
            userHandle: identity.keyPair.publicKey,
          }),
          passwords: new PasswordRegistry(state, {
            serverSetup: opaqueServerSetup,
            userIdentifier: `ce-admin-password-v1\0${config.installationId}`,
          }),
          opaqueIdentifiers: {
            client: `admin:${config.installationId}`,
            server: hostPublicKey,
          },
          consumeAuthAttempt: (kind) => limiter.consume(kind),
          captureAuthenticationGeneration: () => sessions.captureGeneration(),
          registerAuthenticatedSession: (expectedGeneration, revoke) =>
            sessions.register(expectedGeneration, sessionBinding, revoke),
          resumeAuthenticatedSession: (token, revoke) => {
            const resumed = sessions.resume(token, sessionBinding, revoke);
            if (resumed) authenticatedAt = resumed.metadata.authenticatedAt;
            return resumed;
          },
          issueResumeTicket: (expectedGeneration) => {
            authenticatedAt = Date.now();
            return sessions.issueResumeTicket(
              expectedGeneration,
              sessionBinding,
              { authenticatedAt },
            );
          },
          runCredentialMutation: (expectedGeneration, operation, options) =>
            sessions.runCredentialMutation(
              expectedGeneration,
              operation,
              options,
            ),
          ...(context.rememberedDevice
            ? {
                assertAuthenticatedSessionCurrent: async () => {
                  try {
                    await deviceTrust.verify(device.id, device.publicKey);
                  } catch (error) {
                    if (
                      error instanceof DeviceTrustError &&
                      (error.code === "REVOKED" || error.code === "NOT_TRUSTED")
                    ) {
                      await sessions.revokeDevice(sessionBinding);
                      throw new Error(
                        "This device was revoked; authentication is required",
                      );
                    }
                    throw error;
                  }
                },
              }
            : {}),
          createInner: async () => {
            if (authenticatedAt === undefined)
              throw new Error(
                "Administrator authentication timestamp is missing",
              );
            return new AdminGatewaySession(
              helper,
              `device:${device.id}`,
              authenticatedAt,
            );
          },
        });
      },
    };
    relay = await RelayConnector.start({
      ...gatewayOptions,
      endpoint: config.relayEndpoint,
      routeId: config.routeId,
      routeCapability: config.routeCapability,
    });
    await writeProcessRecord(paths.pidFile);
    await waitForShutdownSignal();
  } finally {
    await relay?.close();
    await state.close();
    await rm(paths.pidFile, { force: true });
    await lock.release();
  }
}

export async function startAdminControllerService(
  cliEntryPoint: string,
): Promise<{ started: boolean; pid: number }> {
  const config = await loadAdminControllerConfig();
  assertControllerUser(config);
  const paths = resolveAdminControllerPaths(config.home, config.runAsUid);
  const existing = await readProcessRecord(paths.pidFile);
  if (existing && (await processRecordMatches(existing)))
    return { started: false, pid: existing.pid };
  const child = spawn(
    process.execPath,
    [cliEntryPoint, "admin", "web", "serve"],
    {
      detached: true,
      env: { ...process.env, CE_ADMIN_HOME: config.home },
      stdio: "ignore",
    },
  );
  if (!child.pid) throw new Error("Failed to start Administrator Controller");
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = await readProcessRecord(paths.pidFile);
    if (
      record &&
      record.pid === child.pid &&
      (await processRecordMatches(record))
    )
      return { started: true, pid: record.pid };
    if (!isProcessAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Administrator Controller did not become ready");
}

export async function stopAdminControllerService(): Promise<boolean> {
  const config = await loadAdminControllerConfig();
  assertControllerUser(config);
  const paths = resolveAdminControllerPaths(config.home, config.runAsUid);
  const record = await readProcessRecord(paths.pidFile);
  if (!record || !(await processRecordMatches(record))) {
    await rm(paths.pidFile, { force: true });
    return false;
  }
  await signalRecordedProcess(record, "SIGTERM", {
    uid: config.runAsUid,
    commandIncludes: ["admin", "web", "serve"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await processRecordMatches(record)))
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (await processRecordMatches(record))
    throw new Error("Administrator Controller did not stop after SIGTERM");
  return true;
}

export class AdminGatewaySession implements GatewaySession {
  readonly #helper: Pick<AdminHelperClient, "request">;
  readonly #actor: string;
  readonly #authenticatedAt: number;

  constructor(
    helper: Pick<AdminHelperClient, "request">,
    actor: string,
    authenticatedAt: number,
  ) {
    if (!Number.isSafeInteger(authenticatedAt) || authenticatedAt < 0)
      throw new Error("Administrator authentication timestamp is invalid");
    this.#helper = helper;
    this.#actor = actor;
    this.#authenticatedAt = authenticatedAt;
  }

  request(request: RequestEnvelope): Promise<unknown> {
    if (!request.method.startsWith("admin/"))
      throw new Error("Unsupported administrator request");
    if (
      isDangerous(request.method) &&
      Date.now() - this.#authenticatedAt > RECENT_AUTHENTICATION_MS
    )
      throw new Error("This operation requires a recent administrator login");
    return this.#helper.request({
      version: ADMIN_HELPER_PROTOCOL_VERSION,
      requestId: request.requestId,
      actor: this.#actor,
      action: request.method,
      payload: request.payload,
    });
  }
}

function isDangerous(method: string): boolean {
  return [
    "admin/user/disable",
    "admin/user/enable",
    "admin/recovery/start",
    "admin/removal/schedule",
    "admin/removal/cancel",
  ].includes(method);
}

function assertControllerUser(config: AdminControllerConfig): void {
  if (process.getuid?.() !== config.runAsUid)
    throw new Error(
      `Administrator Controller must run as ${config.runAsUser} (UID ${config.runAsUid})`,
    );
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGTERM", finish);
      process.off("SIGINT", finish);
      resolve();
    };
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
  });
}
