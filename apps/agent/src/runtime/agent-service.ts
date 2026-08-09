import { spawn } from "node:child_process";
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
  readProcessRecord,
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
import type { TrustedDevice } from "../host/devices.js";
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
import { assertUserAccessEnabled } from "../admin/access-policy.js";

export async function runAgentService(paths: HostPaths): Promise<void> {
  await assertUserAccessEnabled();
  const config = await initializeHost(paths);
  if (config.transport.mode === "unconfigured")
    throw new Error(
      "Configure direct or relay transport before starting Agent",
    );
  if (!config.webAuthn)
    throw new Error("Configure Passkey origin before starting Agent");
  const lock = await ProcessLock.acquire(paths.agentLockFile);
  const state = await HostStateStore.open(paths.stateFile);
  let gateway: DirectGateway | undefined;
  let relay: RelayConnector | undefined;
  let queueDispatcher: QueueDispatcher | undefined;
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
    const preferences = new UserPreferencesRegistry(state);
    const threadPermissions = new ThreadPermissionRegistry(state);
    const setup = new HostSetupService(paths, { preferences });
    const authenticatedSessions = new AuthenticatedSessionRegistry();
    const authenticationRateLimiter = new AuthenticationRateLimiter();
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
      connectClient: connectCodexClient,
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
        _device: TrustedDevice,
        context: {
          newlyPaired: boolean;
          onAuthenticated?: () => Promise<void>;
        },
      ) =>
        new AuthenticatedGatewaySession({
          newlyPaired: context.newlyPaired,
          ...(context.onAuthenticated
            ? { onAuthenticated: context.onAuthenticated }
            : {}),
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
          registerAuthenticatedSession: (revoke) =>
            authenticatedSessions.register(revoke),
          onCredentialsRecovered: () => authenticatedSessions.revokeAll(),
          handleAuthenticatedRequest: (request, emitEvent) =>
            setup.request(request, emitEvent),
          createInner: async () => {
            await ensureCodexReady();
            return CodexGatewaySession.connect({
              socketPath: paths.appServerSocket,
              workspaces,
              queue,
              threadPermissions,
              queueDispatcher: activeQueueDispatcher,
              nodeStatus: async () => ({
                nodeId: config.nodeId,
                transport: config.transport.mode,
                appServer: await probeAppServer(paths.appServerSocket),
                workspaceRoots: await workspaces.list(),
              }),
            });
          },
        }),
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
    }
    await writeProcessRecord(paths.agentPidFile);
    await waitForShutdownSignal();
  } finally {
    await gateway?.close();
    await relay?.close();
    await queueDispatcher?.close();
    await state.close();
    await rm(paths.agentPidFile, { force: true });
    await lock.release();
  }
}

export async function startAgentService(
  paths: HostPaths,
  cliEntryPoint: string,
): Promise<{ started: boolean; pid: number }> {
  await assertUserAccessEnabled();
  const existing = await readProcessRecord(paths.agentPidFile);
  if (existing && isProcessAlive(existing.pid)) {
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
    if (record && record.pid === child.pid && isProcessAlive(record.pid)) {
      return { started: true, pid: record.pid };
    }
    if (!isProcessAlive(child.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("CodexEverywhere Agent did not become ready");
}

export async function stopAgentService(paths: HostPaths): Promise<boolean> {
  const record = await readProcessRecord(paths.agentPidFile);
  if (!record || !isProcessAlive(record.pid)) {
    await rm(paths.agentPidFile, { force: true });
    return false;
  }
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isProcessAlive(record.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isProcessAlive(record.pid)) {
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
