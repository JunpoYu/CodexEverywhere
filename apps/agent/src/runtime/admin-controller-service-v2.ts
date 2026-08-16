import { chmod, mkdir, rm } from "node:fs/promises";

import { Scope } from "@codex-everywhere/kernel";

import {
  loadAdminControllerConfig,
  resolveAdminControllerPaths,
} from "../admin/controller-config.js";
import { RelayConnector } from "../gateway/relay-connector.js";
import { loadOrCreateHostIdentity } from "../host/identity.js";
import { loadOrCreateOpaqueServerSetup } from "../host/passwords.js";
import { ProcessLock, writeProcessRecord } from "../host/process-files.js";
import {
  DirectTransportV2,
  acceptGatewayV2Socket,
} from "../v2/adapters/direct-transport.js";
import { AdminHelperV2Client } from "../v2/admin/helper-protocol.js";
import {
  createAdminControllerCompositionRoot,
  IdentityDeviceRegistryAdapter,
  type AdminControllerCompositionRoot,
} from "../v2/gateway/index.js";
import { AdminStateDatabase } from "../v2/repositories/admin-state-database.js";
import { startAdminRelayCapabilityRenewalLoop } from "./admin-relay-capability-renewal.js";
import { reloadAdminControllerConfigForStartup } from "./admin-controller-process-service.js";

/** v0.4 unprivileged Administrator Controller with high-level sudo IPC. */
export async function runAdminControllerServiceV2(): Promise<void> {
  const bootstrapConfig = await loadAdminControllerConfig();
  assertControllerUser(bootstrapConfig.runAsUser, bootstrapConfig.runAsUid);
  const paths = resolveAdminControllerPaths(
    bootstrapConfig.home,
    bootstrapConfig.runAsUid,
  );
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
  const runtimeScope = new Scope("admin-controller-v0.4-runtime");
  let state: AdminStateDatabase | undefined;
  let root: AdminControllerCompositionRoot | undefined;
  let relay: RelayConnector | undefined;
  let renewal:
    ReturnType<typeof startAdminRelayCapabilityRenewalLoop> | undefined;
  try {
    const config = await reloadAdminControllerConfigForStartup(
      paths.configFile,
      bootstrapConfig,
      {
        onRenewalError: (error) => {
          process.stderr.write(
            `Administrator Relay capability renewal deferred: ${safeError(error)}\n`,
          );
        },
      },
    );
    assertControllerUser(config.runAsUser, config.runAsUid);
    state = await AdminStateDatabase.open(paths.stateFile, { create: true });
    const identityRepository = state.identity;
    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    const opaqueServerSetup = await loadOrCreateOpaqueServerSetup(
      paths.keysDir,
    );
    const hostPublicKey = Buffer.from(identity.keyPair.publicKey).toString(
      "base64url",
    );
    root = await createAdminControllerCompositionRoot({
      state,
      helper: new AdminHelperV2Client(),
      installationId: config.installationId,
      hostId: config.nodeId,
      identity: {
        origin: config.origin,
        rpId: config.rpId,
        nodeId: config.nodeId,
        loginName: config.adminHandle,
        opaqueServerSetup,
        opaqueIdentifiers: {
          client: `admin:${config.installationId}`,
          server: hostPublicKey,
        },
      },
    });
    state = undefined;

    const deviceRegistry = new IdentityDeviceRegistryAdapter(
      identityRepository,
    );
    const gatewayOptions = {
      parentScope: runtimeScope,
      host: "127.0.0.1",
      port: 0,
      nodeId: config.nodeId,
      userId: `admin:${config.installationId}`,
      principal: "host-admin" as const,
      loginName: config.adminHandle,
      identity: identity.keyPair,
      hostFingerprint: identity.fingerprint,
      deviceRegistry,
      allowedOrigin: config.origin,
      relayEndpoint: config.relayEndpoint,
      relayRouteId: config.routeId,
      createSession: (
        device: Parameters<
          AdminControllerCompositionRoot["createTransportSession"]
        >[0],
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
    relay = await RelayConnector.start({
      ...gatewayOptions,
      endpoint: config.relayEndpoint,
      routeId: config.routeId,
      routeCapability: config.routeCapability,
      acceptGatewaySocket: (socket) =>
        acceptGatewayV2Socket(socket, gatewayOptions, runtimeScope),
    });
    let activeCapability = config.routeCapability;
    renewal = startAdminRelayCapabilityRenewalLoop(paths.configFile, {
      initialCapability: config.routeCapability,
      currentUser: { username: config.runAsUser, uid: config.runAsUid },
      onConfig: async (currentConfig) => {
        assertSameController(config, currentConfig);
        if (
          relay === undefined ||
          currentConfig.routeCapability === activeCapability
        ) {
          return;
        }
        await relay.rotateRouteCapability(currentConfig.routeCapability);
        activeCapability = currentConfig.routeCapability;
      },
      onError: (error) => {
        process.stderr.write(
          `Administrator Relay capability renewal retry scheduled: ${safeError(error)}\n`,
        );
      },
    });
    await writeProcessRecord(paths.pidFile);
    await waitForShutdownSignal(runtimeScope);
  } finally {
    await renewal?.close();
    await relay?.close();
    await root?.close();
    await state?.close();
    await runtimeScope.close("admin-controller-stopped");
    await rm(paths.pidFile, { force: true });
    await lock.release();
  }
}

function assertControllerUser(username: string, uid: number): void {
  if (process.getuid?.() !== uid) {
    throw new Error(
      `Administrator Controller must run as ${username} (UID ${uid})`,
    );
  }
}

function assertSameController(
  expected: Awaited<ReturnType<typeof loadAdminControllerConfig>>,
  current: Awaited<ReturnType<typeof loadAdminControllerConfig>>,
): void {
  for (const field of [
    "version",
    "adminHandle",
    "runAsUser",
    "runAsUid",
    "installationId",
    "origin",
    "relayEndpoint",
    "routeId",
    "nodeId",
    "home",
  ] as const) {
    if (expected[field] !== current[field]) {
      throw new Error(`Administrator Controller identity changed (${field})`);
    }
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
