import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";

import type { HostPaths } from "../host/paths.js";
import {
  directTransport,
  initializeHost,
  readHostConfig,
  relayTransport,
} from "../host/config.js";
import { loadOrCreateHostIdentity } from "../host/identity.js";
import {
  ProcessLock,
  isProcessAlive,
  processRecordMatches,
  readProcessRecord,
  signalRecordedProcess,
  writeProcessRecord,
} from "../host/process-files.js";
import { HostStateStore } from "../host/state-store.js";
import { WorkspaceRegistry } from "../host/workspaces.js";
import { CodexGatewaySession } from "../gateway/codex-gateway-session.js";
import { DirectGateway } from "../gateway/direct-gateway.js";
import { RelayConnector } from "../gateway/relay-connector.js";
import { AuthenticatedGatewaySession } from "../gateway/authenticated-session.js";
import { PasskeyRegistry } from "../host/passkeys.js";
import {
  PasswordRegistry,
  loadOrCreateOpaqueServerSetup,
} from "../host/passwords.js";
import {
  CachedDeviceTrustVerifier,
  DeviceRegistry,
  DeviceTrustError,
  type TrustedDevice,
} from "../host/devices.js";
import { QueueRegistry } from "../host/queue.js";
import { UserPreferencesRegistry } from "../host/user-preferences.js";
import { ThreadPermissionRegistry } from "../host/thread-permissions.js";
import {
  AuthenticatedSessionRegistry,
  AuthenticationRateLimiter,
} from "../host/auth-security.js";
import { ensureAppServer, probeAppServer } from "./app-server-supervisor.js";
import { HostSetupService } from "./host-setup-service.js";
import { probeCodexInstallation } from "./codex-install.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { QueueDispatcher } from "./queue-dispatcher.js";
import { QueueConsumptionRepairer } from "./queue-consumption.js";
import { assertUserAccessEnabled } from "../admin/access-policy.js";
import {
  inspectRelayCapabilityRenewal,
  renewRelayCapabilityIfNeeded,
  startRelayCapabilityRenewalLoop,
} from "./relay-capability-renewal.js";

export async function runAgentService(paths: HostPaths): Promise<void> {
  await assertUserAccessEnabled();
  let config = await initializeHost(paths);
  if (config.transport.mode === "unconfigured")
    throw new Error(
      "Configure direct or relay transport before starting Agent",
    );
  if (!config.webAuthn)
    throw new Error("Configure Passkey origin before starting Agent");
  const startupRelay = relayTransport(config.transport);
  if (startupRelay) {
    const status = inspectRelayCapabilityRenewal(startupRelay.routeCapability);
    if (
      status.provisioned &&
      status.remainingMs !== undefined &&
      status.remainingMs <= 0
    ) {
      try {
        config = (await renewRelayCapabilityIfNeeded(paths)).config;
      } catch (error) {
        process.stderr.write(
          `Relay capability renewal deferred: ${safeServiceError(error)}\n`,
        );
      }
    }
  }
  if (!config.webAuthn)
    throw new Error("Relay renewal returned an invalid Host configuration");
  const lock = await ProcessLock.acquire(paths.agentLockFile);
  const state = await HostStateStore.open(paths.stateFile);
  let gateway: DirectGateway | undefined;
  let relay: RelayConnector | undefined;
  let activeRelayCapability: string | undefined;
  let relayRenewalLoop:
    ReturnType<typeof startRelayCapabilityRenewalLoop> | undefined;
  let queueDispatcher: QueueDispatcher | undefined;
  let queueConsumptionRepairer: QueueConsumptionRepairer | undefined;
  try {
    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    const opaqueServerSetup = await loadOrCreateOpaqueServerSetup(
      paths.keysDir,
    );
    const userId = `unix:${process.getuid?.() ?? "unknown"}`;
    const loginName = userInfo().username;
    const hostPublicKey = Buffer.from(identity.keyPair.publicKey).toString(
      "base64url",
    );
    const direct = directTransport(config.transport);
    const relayConfig = relayTransport(config.transport);
    const workspaces = new WorkspaceRegistry(state);
    const queue = new QueueRegistry(state);
    const activeQueueConsumptionRepairer = new QueueConsumptionRepairer(queue);
    queueConsumptionRepairer = activeQueueConsumptionRepairer;
    const preferences = new UserPreferencesRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    const setup = new HostSetupService(paths, { preferences });
    const authenticatedSessions = new AuthenticatedSessionRegistry();
    const authenticationRateLimiter = new AuthenticationRateLimiter();
    const deviceTrust = new CachedDeviceTrustVerifier(
      new DeviceRegistry(state),
    );
    const ensureCodexReady = async (): Promise<void> => {
      const env = await setup.codexEnvironment();
      const installation = await probeCodexInstallation({ env });
      if (!installation.installed) {
        throw new Error(
          "Codex is not installed. Complete setup before opening a workspace.",
        );
      }
      await ensureAppServer(paths, {
        codexBinary: installation.binary,
        env,
      });
    };
    const connectCodexClient = async (): Promise<CodexAppServerClient> => {
      await ensureCodexReady();
      return CodexAppServerClient.connectUnix(paths.appServerSocket);
    };
    const activeQueueDispatcher = new QueueDispatcher({
      queue,
      workspaces,
      threadPermissions,
      connectClient: connectCodexClient,
      consumptionRepairer: activeQueueConsumptionRepairer,
    });
    queueDispatcher = activeQueueDispatcher;
    const gatewayOptions = {
      host: direct?.listenHost ?? "127.0.0.1",
      port: direct?.listenPort ?? 0,
      nodeId: config.nodeId,
      userId,
      loginName,
      identity: identity.keyPair,
      hostFingerprint: identity.fingerprint,
      allowedOrigin: config.webAuthn.origin,
      ...(direct ? { directEndpoint: direct.endpoint } : {}),
      ...(relayConfig
        ? {
            relayEndpoint: relayConfig.endpoint,
            relayRouteId: relayConfig.routeId,
          }
        : {}),
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
        const sessionBinding = {
          principal: "user" as const,
          nodeId: config.nodeId,
          userId,
          deviceId: device.id,
          devicePublicKey: Buffer.from(device.publicKey).toString("base64url"),
          rememberedDevice: context.rememberedDevice,
        };
        if (context.resumeRememberedDeviceInvalid)
          await authenticatedSessions.revokeDevice(sessionBinding);
        return new AuthenticatedGatewaySession({
          newlyPaired: context.newlyPaired,
          ...(context.onAuthenticated
            ? { onAuthenticated: context.onAuthenticated }
            : {}),
          ...(context.resumeToken ? { resumeToken: context.resumeToken } : {}),
          passkeys: new PasskeyRegistry(state, {
            ...config.webAuthn!,
            nodeId: config.nodeId,
            userName: loginName,
            userDisplayName: `${loginName} · ${hostname()}`,
            userHandle: identity.keyPair.publicKey,
          }),
          passwords: new PasswordRegistry(state, {
            serverSetup: opaqueServerSetup,
            userIdentifier: config.nodeId,
          }),
          opaqueIdentifiers: {
            client: userId,
            server: hostPublicKey,
          },
          consumeAuthAttempt: (kind) => authenticationRateLimiter.consume(kind),
          captureAuthenticationGeneration: () =>
            authenticatedSessions.captureGeneration(),
          registerAuthenticatedSession: (expectedGeneration, revoke) =>
            authenticatedSessions.register(
              expectedGeneration,
              sessionBinding,
              revoke,
            ),
          resumeAuthenticatedSession: (token, revoke) =>
            authenticatedSessions.resume(token, sessionBinding, revoke),
          issueResumeTicket: (expectedGeneration) =>
            authenticatedSessions.issueResumeTicket(
              expectedGeneration,
              sessionBinding,
            ),
          runCredentialMutation: (expectedGeneration, operation, options) =>
            authenticatedSessions.runCredentialMutation(
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
                      await authenticatedSessions.revokeDevice(sessionBinding);
                      throw new Error(
                        "This device was revoked; authentication is required",
                      );
                    }
                    throw error;
                  }
                },
              }
            : {}),
          handleAuthenticatedRequest: (request, emitEvent) =>
            setup.request(request, emitEvent),
          createInner: async () => {
            await ensureCodexReady();
            const appServerInstanceId = await readAppServerInstanceId(paths);
            return CodexGatewaySession.connect({
              socketPath: paths.appServerSocket,
              appServerInstanceId,
              workspaces,
              queue,
              threadPermissions,
              queueDispatcher: activeQueueDispatcher,
              consumptionRepairer: activeQueueConsumptionRepairer,
              nodeStatus: async () => ({
                nodeId: config.nodeId,
                transport: config.transport.mode,
                appServer: await probeAppServer(paths.appServerSocket),
                appServerInstanceId: await readAppServerInstanceId(paths),
                workspaceRoots: await workspaces.list(),
              }),
            });
          },
        });
      },
    };
    await activeQueueDispatcher.start();
    if (direct) {
      gateway = await DirectGateway.start(gatewayOptions);
    }
    if (relayConfig) {
      relay = await RelayConnector.start({
        ...gatewayOptions,
        endpoint: relayConfig.endpoint,
        routeId: relayConfig.routeId,
        routeCapability: relayConfig.routeCapability,
        ...(direct ? { directEndpoint: direct.endpoint } : {}),
      });
      activeRelayCapability = relayConfig.routeCapability;
      relayRenewalLoop = startRelayCapabilityRenewalLoop(paths, {
        initialCapability: relayConfig.routeCapability,
        onConfig: async (currentConfig) => {
          const currentRelay = relayTransport(currentConfig.transport);
          if (
            !relay ||
            !currentRelay ||
            currentRelay.routeId !== relayConfig.routeId ||
            currentRelay.routeCapability === activeRelayCapability
          ) {
            return;
          }
          await relay.rotateRouteCapability(currentRelay.routeCapability);
          activeRelayCapability = currentRelay.routeCapability;
        },
        onError: (error) => {
          process.stderr.write(
            `Relay capability renewal retry scheduled: ${safeServiceError(error)}\n`,
          );
        },
      });
    }
    await writeProcessRecord(paths.agentPidFile);
    await waitForShutdownSignal();
  } finally {
    await relayRenewalLoop?.close();
    await gateway?.close();
    await relay?.close();
    await queueDispatcher?.close();
    await queueConsumptionRepairer?.close();
    await state.close();
    await rm(paths.agentPidFile, { force: true });
    await lock.release();
  }
}

async function readAppServerInstanceId(paths: HostPaths): Promise<string> {
  const record = await readProcessRecord(paths.appServerPidFile);
  if (!record) throw new Error("Codex app-server process identity is missing");
  return createHash("sha256")
    .update(
      JSON.stringify({
        pid: record.pid,
        host: record.host ?? null,
        procStartTime: record.procStartTime ?? null,
        bootId: record.bootId ?? null,
        uid: record.uid ?? null,
        startedAt: record.startedAt,
      }),
    )
    .digest("base64url");
}

function safeServiceError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_024)
    : "unknown failure";
}

export async function startAgentService(
  paths: HostPaths,
  cliEntryPoint: string,
): Promise<{ started: boolean; pid: number }> {
  await assertUserAccessEnabled();
  const existing = await readProcessRecord(paths.agentPidFile);
  if (existing && (await processRecordMatches(existing))) {
    return { started: false, pid: existing.pid };
  }
  const child = spawn(process.execPath, [cliEntryPoint, "agent", "serve"], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("Failed to start CodexEverywhere Agent");
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const record = await readProcessRecord(paths.agentPidFile);
    if (
      record &&
      record.pid === child.pid &&
      (await processRecordMatches(record))
    ) {
      return { started: true, pid: record.pid };
    }
    if (!isProcessAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("CodexEverywhere Agent did not become ready");
}

export async function stopAgentService(paths: HostPaths): Promise<boolean> {
  const record = await readProcessRecord(paths.agentPidFile);
  if (!record || !(await processRecordMatches(record))) {
    await rm(paths.agentPidFile, { force: true });
    return false;
  }
  await signalRecordedProcess(record, "SIGTERM", {
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
    commandIncludes: ["agent", "serve"],
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await processRecordMatches(record))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await processRecordMatches(record)) {
    throw new Error(`Agent PID ${record.pid} did not stop after SIGTERM`);
  }
  return true;
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
