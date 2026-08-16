import { rm } from "node:fs/promises";
import { homedir, userInfo } from "node:os";

import { Scope } from "@codex-everywhere/kernel";

import { assertUserAccessEnabled } from "../admin/access-policy.js";
import {
  directTransport,
  initializeHostFilesystem,
  readHostConfig,
  relayTransport,
  updateHostConfigWithCoordination,
} from "../host/config.js";
import { loadOrCreateHostIdentity } from "../host/identity.js";
import type { HostPaths } from "../host/paths.js";
import { ProcessLock, writeProcessRecord } from "../host/process-files.js";
import { loadOrCreateOpaqueServerSetup } from "../host/passwords.js";
import { RelayConnector } from "../gateway/relay-connector.js";
import {
  DirectTransportV2,
  acceptGatewayV2Socket,
} from "../v2/adapters/direct-transport.js";
import { CodexClientFactory } from "../v2/codex/client-factory.js";
import {
  createAgentCompositionRoot,
  IdentityDeviceRegistryAdapter,
  type AgentCompositionRoot,
} from "../v2/gateway/index.js";
import { UserStateDatabase } from "../v2/repositories/user-state-database.js";
import { CodexSupervisor } from "../v2/services/codex-supervisor.js";
import {
  inspectRelayCapabilityRenewal,
  renewRelayCapabilityIfNeeded,
  startRelayCapabilityRenewalLoop,
} from "./relay-capability-renewal.js";

/** v0.4 composition root. It can serve onboarding before Codex is installed. */
export async function runAgentServiceV2(paths: HostPaths): Promise<void> {
  await assertUserAccessEnabled();
  await initializeHostFilesystem(paths);
  const lock = await ProcessLock.acquire(paths.agentLockFile);
  const runtimeScope = new Scope("agent-v0.4-runtime");
  let state: UserStateDatabase | undefined;
  let root: AgentCompositionRoot | undefined;
  let directGateway: DirectTransportV2 | undefined;
  let relayConnector: RelayConnector | undefined;
  let relayRenewal:
    ReturnType<typeof startRelayCapabilityRenewalLoop> | undefined;
  try {
    state = await UserStateDatabase.open(paths.stateFile, { create: true });
    await updateHostConfigWithCoordination(paths, state, (config) => config, {
      signal: runtimeScope.signal,
    });
    let config = await readHostConfig(paths);
    if (config.transport.mode === "unconfigured") {
      throw new Error(
        "Configure direct or relay transport before starting Agent",
      );
    }
    if (config.webAuthn === undefined) {
      throw new Error("Configure Passkey origin before starting Agent");
    }
    const startupRelay = relayTransport(config.transport);
    if (startupRelay !== undefined) {
      const renewal = inspectRelayCapabilityRenewal(
        startupRelay.routeCapability,
      );
      if (
        renewal.provisioned &&
        renewal.remainingMs !== undefined &&
        renewal.remainingMs <= 0
      ) {
        try {
          config = (
            await renewRelayCapabilityIfNeeded(paths, {
              coordination: state,
            })
          ).config;
        } catch (error) {
          process.stderr.write(
            `Relay capability renewal deferred: ${safeError(error)}\n`,
          );
        }
      }
    }
    if (config.webAuthn === undefined) {
      throw new Error("Relay renewal returned invalid Host configuration");
    }

    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    const opaqueServerSetup = await loadOrCreateOpaqueServerSetup(
      paths.keysDir,
    );
    const loginName = userInfo().username;
    const userId = `unix:${process.getuid?.() ?? "unknown"}`;
    const hostPublicKey = Buffer.from(identity.keyPair.publicKey).toString(
      "base64url",
    );
    const supervisor = new CodexSupervisor({
      scope: runtimeScope,
      paths,
      userHome: homedir(),
    });
    const clients = new CodexClientFactory({
      connect: () => supervisor.connect(),
    });
    const identityRepository = state.identity;
    const stateCoordination = state;
    root = await createAgentCompositionRoot({
      state,
      clients,
      hostId: config.nodeId,
      home: homedir(),
      appServerSocketPath: paths.appServerSocket,
      identity: {
        origin: config.webAuthn.origin,
        rpId: config.webAuthn.rpId,
        nodeId: config.nodeId,
        loginName,
        opaqueServerSetup,
        opaqueIdentifiers: {
          client: userId,
          server: hostPublicKey,
        },
      },
      setup: {
        paths,
        userHome: homedir(),
        supervisor,
      },
    });
    // Ownership moved into the Agent root immediately after construction.
    state = undefined;

    const deviceRegistry = new IdentityDeviceRegistryAdapter(
      identityRepository,
    );
    const direct = directTransport(config.transport);
    const relay = relayTransport(config.transport);
    const gatewayOptions = {
      parentScope: runtimeScope,
      host: direct?.listenHost ?? "127.0.0.1",
      port: direct?.listenPort ?? 0,
      nodeId: config.nodeId,
      userId,
      loginName,
      identity: identity.keyPair,
      hostFingerprint: identity.fingerprint,
      deviceRegistry,
      allowedOrigin: config.webAuthn.origin,
      ...(direct === undefined ? {} : { directEndpoint: direct.endpoint }),
      ...(relay === undefined
        ? {}
        : {
            relayEndpoint: relay.endpoint,
            relayRouteId: relay.routeId,
          }),
      createSession: (
        device: Parameters<AgentCompositionRoot["createTransportSession"]>[0],
        context: Parameters<
          NonNullable<
            Parameters<typeof DirectTransportV2.start>[0]["createSession"]
          >
        >[1],
      ) =>
        root!.createTransportSession(device, {
          authenticationMode: context.authenticationMode,
          ...(context.resumeToken === undefined
            ? {}
            : { resumeToken: context.resumeToken }),
        }),
    };
    if (direct !== undefined) {
      directGateway = await DirectTransportV2.start(gatewayOptions);
    }
    if (relay !== undefined) {
      relayConnector = await RelayConnector.start({
        ...gatewayOptions,
        endpoint: relay.endpoint,
        routeId: relay.routeId,
        routeCapability: relay.routeCapability,
        acceptGatewaySocket: (socket) =>
          acceptGatewayV2Socket(socket, gatewayOptions, runtimeScope),
      });
      let activeCapability = relay.routeCapability;
      const relayRouteId = relay.routeId;
      relayRenewal = startRelayCapabilityRenewalLoop(paths, {
        initialCapability: activeCapability,
        coordination: stateCoordination,
        onConfig: async (currentConfig) => {
          const currentRelay = relayTransport(currentConfig.transport);
          if (
            relayConnector === undefined ||
            currentRelay === undefined ||
            currentRelay.routeId !== relayRouteId ||
            currentRelay.routeCapability === activeCapability
          ) {
            return;
          }
          await relayConnector.rotateRouteCapability(
            currentRelay.routeCapability,
          );
          activeCapability = currentRelay.routeCapability;
        },
        onError: (error) => {
          process.stderr.write(
            `Relay capability renewal retry scheduled: ${safeError(error)}\n`,
          );
        },
      });
    }
    await writeProcessRecord(paths.agentPidFile);
    await waitForShutdownSignal(runtimeScope);
  } finally {
    await relayRenewal?.close();
    await relayConnector?.close();
    await directGateway?.close();
    await root?.close();
    await state?.close();
    await runtimeScope.close("agent-service-stopped");
    await rm(paths.agentPidFile, { force: true });
    await lock.release();
  }
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_024)
    : "unknown failure";
}

function waitForShutdownSignal(scope: Scope): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGTERM", finish);
      process.off("SIGINT", finish);
      resolve();
    };
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
    scope.defer(() => {
      process.off("SIGTERM", finish);
      process.off("SIGINT", finish);
    });
  });
}
