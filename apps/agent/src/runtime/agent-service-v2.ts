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
  type DirectTransportV2Options,
} from "../v2/adapters/direct-transport.js";
import {
  acceptGatewayV2Socket,
  type GatewayFatalRuntimeFailure,
  type GatewaySocketConnectionOptions,
} from "../v2/adapters/gateway-socket-connection.js";
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

const FATAL_WASM_EXIT_GRACE_MS = 5_000;
const SIGNAL_EXIT_GRACE_MS = 8_000;

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
  let fatalRuntimeFailure: GatewayFatalRuntimeFailure | undefined;
  let signalExitTimer: ReturnType<typeof setTimeout> | undefined;
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
    const gatewayConnectionOptions: GatewaySocketConnectionOptions = {
      nodeId: config.nodeId,
      userId,
      loginName,
      identity: identity.keyPair,
      deviceRegistry,
      createSession: (device, context) =>
        root!.createTransportSession(device, {
          authenticationMode: context.authenticationMode,
          ...(context.resumeToken === undefined
            ? {}
            : { resumeToken: context.resumeToken }),
        }),
      onFatalRuntimeFailure: (failure) => {
        if (fatalRuntimeFailure !== undefined) return;
        fatalRuntimeFailure = failure;
        process.stderr.write(
          `${JSON.stringify({
            level: "error",
            event: "agent.fatal_wasm_runtime",
            stage: failure.stage,
          })}\n`,
        );
        // A trapped WASM runtime cannot be trusted for later handshakes. Keep
        // the timer referenced so leaked sockets or a failed disposer cannot
        // leave a PID that the watchdog mistakes for a healthy Agent.
        setTimeout(() => process.exit(1), FATAL_WASM_EXIT_GRACE_MS);
        void runtimeScope.close("fatal-wasm-runtime").catch(() => undefined);
      },
    };
    if (direct !== undefined) {
      const directGatewayOptions: DirectTransportV2Options = {
        ...gatewayConnectionOptions,
        parentScope: runtimeScope,
        host: direct.listenHost,
        port: direct.listenPort,
        hostFingerprint: identity.fingerprint,
        allowedOrigin: config.webAuthn.origin,
        directEndpoint: direct.endpoint,
        ...(relay === undefined
          ? {}
          : {
              relayEndpoint: relay.endpoint,
              relayRouteId: relay.routeId,
            }),
      };
      directGateway = await DirectTransportV2.start(directGatewayOptions);
    }
    if (relay !== undefined) {
      relayConnector = await RelayConnector.start({
        endpoint: relay.endpoint,
        routeId: relay.routeId,
        routeCapability: relay.routeCapability,
        nodeId: config.nodeId,
        userId,
        identity: { publicKey: identity.keyPair.publicKey },
        hostFingerprint: identity.fingerprint,
        ...(direct === undefined ? {} : { directEndpoint: direct.endpoint }),
        acceptGatewaySocket: (socket) =>
          acceptGatewayV2Socket(socket, gatewayConnectionOptions, runtimeScope),
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
    await waitForShutdownSignal(runtimeScope, () => {
      signalExitTimer ??= setTimeout(
        () => process.exit(0),
        SIGNAL_EXIT_GRACE_MS,
      );
    });
    if (fatalRuntimeFailure !== undefined) {
      throw new Error(
        `Agent runtime entered an unrecoverable WASM state during ${fatalRuntimeFailure.stage}`,
        { cause: fatalRuntimeFailure.error },
      );
    }
  } finally {
    const cleanupFailures: string[] = [];
    await captureCleanupFailure(cleanupFailures, "relay-renewal", () =>
      relayRenewal?.close(),
    );
    await captureCleanupFailure(cleanupFailures, "relay-connector", () =>
      relayConnector?.close(),
    );
    await captureCleanupFailure(cleanupFailures, "direct-gateway", () =>
      directGateway?.close(),
    );
    await captureCleanupFailure(cleanupFailures, "composition-root", () =>
      root?.close(),
    );
    await captureCleanupFailure(cleanupFailures, "state", () => state?.close());
    await captureCleanupFailure(cleanupFailures, "runtime-scope", () =>
      runtimeScope.close("agent-service-stopped"),
    );
    await captureCleanupFailure(cleanupFailures, "process-record", () =>
      rm(paths.agentPidFile, { force: true }),
    );
    await captureCleanupFailure(cleanupFailures, "process-lock", () =>
      lock.release(),
    );
    if (cleanupFailures.length > 0) {
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          event: "agent.cleanup_failed",
          components: cleanupFailures,
        })}\n`,
      );
    }
    // A completed cleanup should not be delayed by the safety timer. If an
    // unowned handle remains, the unref'ed timer can still terminate it.
    signalExitTimer?.unref?.();
  }
}

async function captureCleanupFailure(
  failures: string[],
  component: string,
  operation: () => void | Promise<void> | undefined,
): Promise<void> {
  try {
    await operation();
  } catch {
    failures.push(component);
  }
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1_024)
    : "unknown failure";
}

function waitForShutdownSignal(
  scope: Scope,
  onSignal: () => void,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      process.off("SIGTERM", signaled);
      process.off("SIGINT", signaled);
      scope.signal.removeEventListener("abort", finish);
      resolve();
    };
    const signaled = () => {
      onSignal();
      finish();
    };
    process.on("SIGTERM", signaled);
    process.on("SIGINT", signaled);
    scope.signal.addEventListener("abort", finish, { once: true });
    scope.defer(() => {
      process.off("SIGTERM", signaled);
      process.off("SIGINT", signaled);
      scope.signal.removeEventListener("abort", finish);
    });
    if (scope.signal.aborted) finish();
  });
}
