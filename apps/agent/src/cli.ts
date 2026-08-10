#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { routeIdFromCapability } from "@codex-everywhere/protocol/relay-capability";

import {
  directTransport,
  initializeHost,
  readHostConfig,
  relayTransport,
  withDirectTransport,
  withRelayTransport,
  writeHostConfig,
} from "./host/config.js";
import { DeviceRegistry } from "./host/devices.js";
import { PasskeyRegistry } from "./host/passkeys.js";
import { resolveHostPaths } from "./host/paths.js";
import { loadOrCreateHostIdentity } from "./host/identity.js";
import {
  HostProvisioningRequiredError,
  readPairingHostConfig,
} from "./host/pairing-config.js";
import { HostStateStore } from "./host/state-store.js";
import { WorkspaceRegistry } from "./host/workspaces.js";
import { ThreadPermissionRegistry } from "./host/thread-permissions.js";
import { isProcessAlive, readProcessRecord } from "./host/process-files.js";
import { installWatchdog } from "./host/watchdog.js";
import { runDoctor } from "./host/doctor.js";
import {
  codexProcessEnvironment,
  createProxyNetworkConfig,
} from "./host/network.js";
import {
  runAgentService,
  startAgentService,
  stopAgentService,
} from "./runtime/agent-service.js";
import {
  ensureAppServer,
  probeAppServer,
} from "./runtime/app-server-supervisor.js";
import { probeCodexInstallation } from "./runtime/codex-install.js";
import { tuiArguments, tuiExitGuidance } from "./runtime/tui-launch.js";
import {
  startTuiPermissionProxy,
  tuiThreadPermissionOptions,
} from "./runtime/tui-permission-proxy.js";
import { inspectSshUnixAccount } from "./admin/unix-accounts.js";
import {
  bootstrapUnixUser,
  validateExistingUserState,
} from "./admin/user-bootstrap.js";
import {
  installHostProvisioner,
  inspectInstalledProvisionerCredential,
  issueSelfProvisioningGrant,
  setHostProvisionerDefaultCodexNetwork,
} from "./admin/self-provision.js";
import {
  applySelfProvisioningGrant,
  requestSelfProvisioningGrant,
} from "./runtime/self-service-provisioning.js";
import {
  RootlessProvisionerUnavailableError,
  requestRootlessSelfProvisioningGrant,
} from "./runtime/rootless-self-provisioning.js";
import {
  installRootlessProvisioner,
  resolveRootlessProvisionerPaths,
  runRootlessProvisioner,
  setRootlessProvisionerDefaultCodexNetwork,
} from "./admin/rootless-provisioner.js";
import {
  installRootlessProvisionerWatchdog,
  rootlessProvisionerStatus,
  stopRootlessProvisioner,
} from "./runtime/rootless-provisioner-service.js";
import {
  installAdminController,
  loadAdminControllerConfig,
  loadAdminInstallation,
  resolveAdminControllerPaths,
} from "./admin/controller-config.js";
import { installAdminSystemIntegration } from "./admin/controller-install.js";
import {
  AdminControlService,
  type AdminHelperRequest,
} from "./admin/control-service.js";
import { ADMIN_STATE_FILE } from "./admin/access-policy.js";
import { AdminUserRegistry } from "./admin/registry.js";
import {
  runAdminControllerService,
  startAdminControllerService,
  stopAdminControllerService,
} from "./runtime/admin-controller-service.js";

const program = new Command();
const paths = resolveHostPaths();

program
  .name("ce")
  .description("CodexEverywhere host agent and TUI launcher")
  .version(packageVersion());

const agent = program
  .command("agent")
  .description("Manage the local host agent");

function packageVersion(): string {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    value &&
    typeof value === "object" &&
    "version" in value &&
    typeof value.version === "string"
  )
    return value.version;
  throw new Error("Agent package version is missing");
}

agent
  .command("install-service")
  .description("Install the tmux/crontab user watchdog")
  .action(async () => {
    await initializeHost(paths);
    const result = await installWatchdog(paths, {
      nodePath: process.execPath,
      cliPath: cliEntryPoint(),
    });
    process.stdout.write(
      `Installed watchdog: ${result.scriptPath}\ntmux session: ${result.sessionName}\n`,
    );
  });

agent
  .command("init")
  .description("Initialize local host state")
  .action(async () => {
    const config = await initializeHost(paths);
    await withWorkspaceRegistry(async () => undefined);
    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    process.stdout.write(
      `Initialized CodexEverywhere host ${config.nodeId}\nFingerprint: ${identity.fingerprint}\nState: ${paths.home}\nRuntime: ${paths.runtimeDir}\n`,
    );
  });

agent
  .command("status")
  .description("Show local host health")
  .action(async () => {
    let config;
    try {
      config = await readHostConfig(paths);
    } catch (error) {
      if (isMissingFile(error)) {
        process.stdout.write(
          "CodexEverywhere is not initialized. Run: ce agent init\n",
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    const workspaceCount = await withWorkspaceRegistry(
      async (registry) => (await registry.list()).length,
    );
    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    const agentRecord = await readProcessRecord(paths.agentPidFile);
    const appServer = (await probeAppServer(paths.appServerSocket))
      ? "healthy"
      : "stopped or unhealthy";
    process.stdout.write(
      [
        `Node: ${config.nodeId}`,
        `Transport: ${config.transport.mode}`,
        `Fingerprint: ${identity.fingerprint}`,
        `Workspace roots: ${workspaceCount}`,
        `Agent: ${agentRecord && isProcessAlive(agentRecord.pid) ? `running (PID ${agentRecord.pid})` : "stopped"}`,
        `app-server: ${appServer}`,
        `State: ${paths.home}`,
      ].join("\n") + "\n",
    );
  });

agent
  .command("ensure")
  .description("Idempotently ensure the Agent and app-server")
  .action(async () => {
    const config = await initializeHost(paths);
    await withWorkspaceRegistry(async () => undefined);
    await loadOrCreateHostIdentity(paths.keysDir);
    if (config.transport.mode !== "unconfigured") {
      const result = await startAgentService(paths, cliEntryPoint());
      process.stdout.write(
        `${result.started ? "Started" : "Agent is already running"} (PID ${result.pid})\n`,
      );
      return;
    }
    const result = await ensureConfiguredAppServer();
    process.stdout.write(
      result.started
        ? `Started Codex app-server (PID ${result.pid})\n`
        : "Codex app-server is already healthy.\n",
    );
  });

agent
  .command("start")
  .description("Start the host Agent in the background")
  .action(async () => {
    const result = await startAgentService(paths, cliEntryPoint());
    process.stdout.write(
      `${result.started ? "Started" : "Agent is already running"} (PID ${result.pid})\n`,
    );
  });

agent
  .command("stop")
  .description("Stop the host Agent without stopping app-server")
  .action(async () => {
    const stopped = await stopAgentService(paths);
    process.stdout.write(
      stopped ? "Agent stopped.\n" : "Agent is not running.\n",
    );
  });

agent
  .command("serve", { hidden: true })
  .description("Run the host Agent in the foreground")
  .action(async () => runAgentService(paths));

const provisioner = program
  .command("provisioner")
  .description("Manage the rootless Unix-user provisioner");

provisioner
  .command("install")
  .requiredOption("--origin <origin>", "Shared HTTPS PWA origin")
  .requiredOption("--relay-endpoint <endpoint>", "Shared Relay WSS endpoint")
  .option(
    "--credential-stdin",
    "Read the host provisioner credential from standard input",
  )
  .option(
    "--default-codex-proxy <url>",
    "Non-secret default proxy for newly initialized users",
  )
  .description("Install a provisioner credential under the current Unix user")
  .action(
    async (options: {
      origin: string;
      relayEndpoint: string;
      credentialStdin?: boolean;
      defaultCodexProxy?: string;
    }) => {
      if (process.getuid?.() === 0)
        throw new Error("Rootless provisioner must not be installed as root");
      if (!options.credentialStdin)
        throw new Error("provisioner install requires --credential-stdin");
      const raw = await readSecretFromStdin("Host provisioner credential");
      const installed = await installRootlessProvisioner({
        origin: options.origin,
        relayEndpoint: options.relayEndpoint,
        credential: JSON.parse(raw) as unknown,
        ...(options.defaultCodexProxy
          ? {
              defaultCodexNetwork: createProxyNetworkConfig({
                httpsProxy: options.defaultCodexProxy,
              }),
            }
          : {}),
      });
      process.stdout.write(
        `Installed rootless provisioner for ${installed.credential.installationId}.\n`,
      );
    },
  );

provisioner
  .command("install-service")
  .description("Install and start the rootless provisioner watchdog")
  .action(async () => {
    const result = await installRootlessProvisionerWatchdog({
      nodePath: process.execPath,
      cliPath: cliEntryPoint(),
    });
    process.stdout.write(
      `Installed provisioner watchdog: ${result.scriptPath}\ntmux session: ${result.sessionName}\n`,
    );
  });

provisioner
  .command("set-default-proxy")
  .argument("<url>", "Host-local HTTP/HTTPS proxy URL")
  .description("Set the Codex proxy default for newly initialized users")
  .action(async (url: string) => {
    const network = createProxyNetworkConfig({ httpsProxy: url });
    await setRootlessProvisionerDefaultCodexNetwork(network);
    process.stdout.write(`Rootless provisioner default proxy: ${url}\n`);
  });

provisioner
  .command("status")
  .description("Show rootless provisioner health")
  .action(async () => {
    const provisionerPaths = resolveRootlessProvisionerPaths();
    const status = await rootlessProvisionerStatus(provisionerPaths);
    process.stdout.write(
      status.running
        ? `Rootless provisioner is running (PID ${String(status.pid)}).\n`
        : "Rootless provisioner is stopped.\n",
    );
    const credential = await inspectInstalledProvisionerCredential(
      provisionerPaths.configFile,
    );
    process.stdout.write(
      `${credential.remainingMs <= 30 * 86_400_000 ? "WARN" : "OK"}\tHost provisioner credential\t${credential.installationId} expires at ${credential.expiresAt}\n`,
    );
    if (!status.running || credential.remainingMs <= 0) process.exitCode = 1;
  });

provisioner
  .command("stop")
  .description("Stop the rootless provisioner")
  .action(async () => {
    const stopped = await stopRootlessProvisioner();
    process.stdout.write(
      stopped
        ? "Rootless provisioner stopped.\n"
        : "Rootless provisioner is not running.\n",
    );
  });

provisioner
  .command("serve", { hidden: true })
  .description("Run the rootless provisioner in the foreground")
  .action(async () =>
    runRootlessProvisioner(resolveRootlessProvisionerPaths()),
  );

const workspace = program
  .command("workspace")
  .description("Manage workspace roots");

workspace
  .command("add")
  .argument("<directory>")
  .description("Register an allowed workspace root")
  .action(async (directory: string) => {
    await initializeHost(paths);
    const result = await withWorkspaceRegistry((registry) =>
      registry.add(directory),
    );
    process.stdout.write(
      `${result.added ? "Added" : "Already registered"}: ${result.root}\n`,
    );
  });

program
  .command("tui")
  .argument("[directory]", "Workspace directory", process.cwd())
  .option("--thread <thread>", "Resume a thread by ID or name")
  .option("--new", "Start a new thread instead of resuming one")
  .description("Resume a thread in the official TUI on the shared app-server")
  .addHelpText("after", `\n${tuiExitGuidance()}\n`)
  .action(
    async (directory: string, options: { thread?: string; new?: boolean }) => {
      await readHostConfig(paths);
      const workspacePath = await withWorkspaceRegistry((registry) =>
        registry.resolve(directory),
      );
      const runtime = await currentCodexRuntime();
      await ensureAppServer(paths, runtime);
      process.stderr.write(`\n${tuiExitGuidance()}\n\n`);
      const tuiState = await HostStateStore.open(paths.stateFile);
      let permissionProxy:
        Awaited<ReturnType<typeof startTuiPermissionProxy>> | undefined;
      try {
        const threadPermissions = new ThreadPermissionRegistry(tuiState);
        permissionProxy = await startTuiPermissionProxy({
          upstreamSocketPath: paths.appServerSocket,
          runtimeDir: paths.runtimeDir,
          ...tuiThreadPermissionOptions(threadPermissions),
        });
        process.exitCode = await runInteractive(
          runtime.codexBinary,
          tuiArguments({
            socketPath: permissionProxy.socketPath,
            workspacePath,
            ...(options.thread ? { thread: options.thread } : {}),
            newThread: options.new ?? false,
          }),
          runtime.env,
        );
      } finally {
        await permissionProxy?.close();
        await tuiState.close();
      }
    },
  );

workspace
  .command("remove")
  .argument("<directory>")
  .description("Remove an allowed workspace root")
  .action(async (directory: string) => {
    await readHostConfig(paths);
    const result = await withWorkspaceRegistry((registry) =>
      registry.remove(directory),
    );
    process.stdout.write(
      `${result.removed ? "Removed" : "Not registered"}: ${result.root}\n`,
    );
  });

workspace
  .command("list")
  .description("List allowed workspace roots")
  .action(async () => {
    await readHostConfig(paths);
    const roots = await withWorkspaceRegistry((registry) => registry.list());
    process.stdout.write(
      roots.length === 0
        ? "No workspace roots registered.\n"
        : `${roots.join("\n")}\n`,
    );
  });

const transport = program
  .command("transport")
  .description("Configure host transport");

transport
  .command("direct")
  .argument("<endpoint>", "Public WSS endpoint")
  .option("--listen-host <host>", "Local gateway bind host", "127.0.0.1")
  .option("--listen-port <port>", "Local gateway bind port", parsePort, 7345)
  .description("Configure a preferred Direct ingress while retaining Relay")
  .action(
    async (
      endpoint: string,
      options: { listenHost: string; listenPort: number },
    ) => {
      assertWebSocketEndpoint(endpoint);
      const config = await initializeHost(paths);
      await writeHostConfig(paths, {
        ...config,
        transport: withDirectTransport(config.transport, {
          endpoint,
          listenHost: options.listenHost,
          listenPort: options.listenPort,
        }),
      });
      process.stdout.write(`Direct transport configured: ${endpoint}\n`);
    },
  );

transport
  .command("relay")
  .argument("<endpoint>", "Relay WSS endpoint")
  .option("--capability <capability>", "Self-contained route capability")
  .option(
    "--capability-stdin",
    "Read the route capability from standard input without echoing it",
  )
  .description("Configure an optional Relay fallback while retaining Direct")
  .action(
    async (
      endpoint: string,
      options: { capability?: string; capabilityStdin?: boolean },
    ) => {
      assertWebSocketEndpoint(endpoint);
      if (Boolean(options.capability) === Boolean(options.capabilityStdin)) {
        throw new Error(
          "Provide exactly one of --capability or --capability-stdin",
        );
      }
      const capability = options.capabilityStdin
        ? await readSecretFromStdin("Relay capability")
        : options.capability!;
      const routeId = routeIdFromCapability(capability);
      const config = await initializeHost(paths);
      await writeHostConfig(paths, {
        ...config,
        transport: withRelayTransport(config.transport, {
          endpoint,
          routeId,
          routeCapability: capability,
        }),
      });
      process.stdout.write(`Relay transport configured: ${endpoint}\n`);
    },
  );

const admin = program
  .command("admin")
  .description("Manage the shared host installation from a privileged shell");

admin
  .command("inspect-user")
  .argument("<username>", "Existing SSH/Unix username")
  .description("Check whether an NSS account can use CodexEverywhere")
  .action(async (username: string) => {
    const result = await inspectSshUnixAccount(username);
    if (!result.eligible) {
      process.stdout.write(`Ineligible: ${result.reason}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Eligible: ${result.account.username} (UID ${result.account.uid}, home ${result.account.home})\n`,
    );
  });

admin
  .command("bootstrap-user")
  .argument("<username>", "Existing SSH/Unix username")
  .requiredOption("--origin <origin>", "Shared HTTPS PWA origin")
  .requiredOption("--relay-endpoint <endpoint>", "Shared Relay WSS endpoint")
  .option(
    "--capability-stdin",
    "Read this user's route capability from standard input",
  )
  .description("Initialize and start one isolated user Agent")
  .action(
    async (
      username: string,
      options: {
        origin: string;
        relayEndpoint: string;
        capabilityStdin?: boolean;
      },
    ) => {
      if (process.getuid?.() !== 0) {
        throw new Error("admin bootstrap-user must run as root");
      }
      if (!options.capabilityStdin) {
        throw new Error("bootstrap-user requires --capability-stdin");
      }
      const eligibility = await inspectSshUnixAccount(username);
      if (!eligibility.eligible) {
        throw new Error(`Unix account is not eligible: ${eligibility.reason}`);
      }
      const account = eligibility.account;
      const home = await stat(account.home);
      if (!home.isDirectory() || home.uid !== account.uid) {
        throw new Error("Unix account home is not owned by the target user");
      }
      const resumed = await validateExistingUserState(account);
      assertWebSocketEndpoint(options.relayEndpoint);
      const origin = new URL(options.origin);
      if (
        origin.protocol !== "https:" ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      ) {
        throw new Error("PWA origin must be an HTTPS origin without a path");
      }
      const routeCapability = await readSecretFromStdin("Relay capability");
      await bootstrapUnixUser({
        account,
        nodePath: process.execPath,
        cliPath: cliEntryPoint(),
        origin: origin.origin,
        relayEndpoint: options.relayEndpoint,
        routeCapability,
      });
      const adminState = await HostStateStore.open(ADMIN_STATE_FILE);
      try {
        await new AdminUserRegistry(adminState).register(account);
      } finally {
        await adminState.close();
      }
      process.stdout.write(
        `${resumed ? "Repaired provisioning for" : "Bootstrapped"} ${account.username}. The user can now run: ce device pair\n`,
      );
    },
  );

admin
  .command("install-provisioner")
  .requiredOption("--origin <origin>", "Shared HTTPS PWA origin")
  .requiredOption("--relay-endpoint <endpoint>", "Shared Relay WSS endpoint")
  .option(
    "--credential-stdin",
    "Read the host provisioner credential from standard input",
  )
  .option(
    "--default-codex-proxy <url>",
    "Non-secret default proxy for newly initialized users",
  )
  .description("Install one root-only credential for Unix-user self-service")
  .action(
    async (options: {
      origin: string;
      relayEndpoint: string;
      credentialStdin?: boolean;
      defaultCodexProxy?: string;
    }) => {
      if (process.getuid?.() !== 0) {
        throw new Error("admin install-provisioner must run as root");
      }
      if (!options.credentialStdin) {
        throw new Error("install-provisioner requires --credential-stdin");
      }
      const raw = await readSecretFromStdin("Host provisioner credential");
      const installed = await installHostProvisioner({
        origin: options.origin,
        relayEndpoint: options.relayEndpoint,
        credential: JSON.parse(raw) as unknown,
        ...(options.defaultCodexProxy
          ? {
              defaultCodexNetwork: createProxyNetworkConfig({
                httpsProxy: options.defaultCodexProxy,
              }),
            }
          : {}),
      });
      process.stdout.write(
        `Installed self-service provisioner for ${installed.credential.installationId}. Existing SSH users can now run: ce device pair\n`,
      );
    },
  );

admin
  .command("set-provisioner-default-proxy")
  .argument("<url>", "Non-secret host-local HTTP/HTTPS proxy URL")
  .description("Set the Codex proxy default for newly initialized users")
  .action(async (url: string) => {
    if (process.getuid?.() !== 0) {
      throw new Error("admin set-provisioner-default-proxy must run as root");
    }
    const network = createProxyNetworkConfig({ httpsProxy: url });
    await setHostProvisionerDefaultCodexNetwork(network);
    process.stdout.write(
      `Newly initialized users will default to Codex proxy ${network.mode === "proxy" ? network.httpsProxy : "direct"}.\n`,
    );
  });

admin
  .command("self-provision", { hidden: true })
  .description("Issue one route to the Unix user authenticated by sudo")
  .action(async () => {
    if (process.getuid?.() !== 0) {
      throw new Error("admin self-provision must run as root");
    }
    process.stdout.write(
      `${JSON.stringify(await issueSelfProvisioningGrant())}\n`,
    );
  });

admin
  .command("install-controller")
  .argument("<run-as-user>", "Existing Unix account that runs the Controller")
  .requiredOption("--handle <handle>", "Administrator login handle")
  .description("Install the isolated host administrator control plane")
  .action(async (runAsUser: string, options: { handle: string }) => {
    if (process.getuid?.() !== 0)
      throw new Error("admin install-controller must run as root");
    const config = await installAdminController({
      runAsUser,
      adminHandle: options.handle,
    });
    await installAdminSystemIntegration(config);
    process.stdout.write(
      [
        `Installed Administrator Controller for ${config.serverName}.`,
        `Run as ${config.runAsUser}: CE_ADMIN_HOME=${config.home} ce admin web pair`,
        `Open ${config.origin}/admin to register the first administrator Passkey and password.`,
      ].join("\n") + "\n",
    );
  });

const adminWeb = admin
  .command("web")
  .description("Manage the host administrator Web Controller");

adminWeb
  .command("serve", { hidden: true })
  .description("Run the Administrator Controller in the foreground")
  .action(async () => runAdminControllerService());

adminWeb
  .command("start")
  .description("Start the Administrator Controller")
  .action(async () => {
    const result = await startAdminControllerService(cliEntryPoint());
    process.stdout.write(
      `${result.started ? "Started" : "Administrator Controller is already running"} (PID ${result.pid})\n`,
    );
  });

adminWeb
  .command("stop")
  .description("Stop the Administrator Controller")
  .action(async () => {
    const stopped = await stopAdminControllerService();
    process.stdout.write(
      stopped
        ? "Administrator Controller stopped.\n"
        : "Administrator Controller is not running.\n",
    );
  });

adminWeb
  .command("restart")
  .description("Restart the Administrator Controller")
  .action(async () => {
    await stopAdminControllerService();
    const result = await startAdminControllerService(cliEntryPoint());
    process.stdout.write(
      `Administrator Controller restarted (PID ${result.pid})\n`,
    );
  });

adminWeb
  .command("status")
  .description("Show Administrator Controller status")
  .action(async () => {
    const config = await loadAdminControllerConfig();
    const adminPaths = resolveAdminControllerPaths(
      config.home,
      config.runAsUid,
    );
    const record = await readProcessRecord(adminPaths.pidFile);
    process.stdout.write(
      [
        `Server: ${config.serverName}`,
        `Administrator handle: ${config.adminHandle}`,
        `Controller: ${record && isProcessAlive(record.pid) ? `running (PID ${record.pid})` : "stopped"}`,
        `State: ${config.home}`,
      ].join("\n") + "\n",
    );
  });

adminWeb
  .command("pair")
  .description("Issue a one-time administrator browser pairing grant")
  .action(async () => {
    const config = await loadAdminControllerConfig();
    if (process.getuid?.() !== config.runAsUid)
      throw new Error(`Run this command as ${config.runAsUser}`);
    await startAdminControllerService(cliEntryPoint());
    const adminPaths = resolveAdminControllerPaths(
      config.home,
      config.runAsUid,
    );
    const identity = await loadOrCreateHostIdentity(adminPaths.keysDir);
    const state = await HostStateStore.open(adminPaths.stateFile);
    try {
      const grant = await new DeviceRegistry(state).issuePairing();
      process.stdout.write(
        `${JSON.stringify(
          {
            version: 1,
            principal: "host-admin",
            transport: "relay",
            endpoint: config.relayEndpoint,
            relayEndpoint: config.relayEndpoint,
            routeId: config.routeId,
            nodeId: config.nodeId,
            userId: `admin:${config.installationId}`,
            loginName: config.adminHandle,
            hostPublicKey: Buffer.from(identity.keyPair.publicKey).toString(
              "base64url",
            ),
            hostFingerprint: identity.fingerprint,
            ...grant,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await state.close();
    }
  });

admin
  .command("helper", { hidden: true })
  .description("Execute one restricted administrator operation")
  .action(async () => {
    if (process.getuid?.() !== 0)
      throw new Error("Administrator helper must run as root");
    const installation = await loadAdminInstallation();
    if (
      process.env.SUDO_USER !== installation.runAsUser ||
      process.env.SUDO_UID !== String(installation.runAsUid)
    )
      throw new Error("Administrator helper caller is not authorized");
    const raw = await readSecretFromStdin("Administrator helper request");
    const request = JSON.parse(raw) as AdminHelperRequest;
    const state = await HostStateStore.open(ADMIN_STATE_FILE);
    try {
      const service = new AdminControlService(state, {
        installationId: installation.installationId,
        serverName: installation.serverName,
        nodePath: process.execPath,
        cliPath: cliEntryPoint(),
      });
      process.stdout.write(
        `${JSON.stringify(await service.execute(request))}\n`,
      );
    } finally {
      await state.close();
    }
  });

admin
  .command("maintenance", { hidden: true })
  .description("Apply due administrator lifecycle operations")
  .action(async () => {
    if (process.getuid?.() !== 0)
      throw new Error("Administrator maintenance must run as root");
    const installation = await loadAdminInstallation();
    const state = await HostStateStore.open(ADMIN_STATE_FILE);
    try {
      const service = new AdminControlService(state, {
        installationId: installation.installationId,
        serverName: installation.serverName,
        nodePath: process.execPath,
        cliPath: cliEntryPoint(),
      });
      await service.maintenance();
    } finally {
      await state.close();
    }
  });

transport
  .command("status")
  .description("Show configured transport")
  .action(async () => {
    const config = await readHostConfig(paths);
    const direct = directTransport(config.transport);
    const relay = relayTransport(config.transport);
    process.stdout.write(
      [
        `Mode: ${config.transport.mode}`,
        ...(direct ? [`Direct endpoint: ${direct.endpoint}`] : []),
        ...(relay
          ? [
              `Relay endpoint: ${relay.endpoint}`,
              `Relay route: ${relay.routeId}`,
            ]
          : []),
      ].join("\n") + "\n",
    );
  });

const device = program
  .command("device")
  .description("Manage trusted browser devices");

const auth = program
  .command("auth")
  .description("Configure host Web authentication");

auth
  .command("configure")
  .argument("<origin>", "PWA origin, for example https://codex.example.com")
  .option("--rp-id <rp-id>", "WebAuthn relying-party domain")
  .description("Configure the Passkey origin verified by this host")
  .action(async (originValue: string, options: { rpId?: string }) => {
    const origin = new URL(originValue);
    if (origin.pathname !== "/" || origin.search || origin.hash)
      throw new Error(
        "Passkey origin must not contain a path, query, or fragment",
      );
    if (origin.protocol !== "https:" && origin.hostname !== "localhost")
      throw new Error("Passkeys require HTTPS (except localhost development)");
    const rpId = options.rpId ?? origin.hostname;
    if (rpId !== origin.hostname && !origin.hostname.endsWith(`.${rpId}`))
      throw new Error(
        "RP ID must equal or be a parent domain of the PWA origin",
      );
    const config = await initializeHost(paths);
    await writeHostConfig(paths, {
      ...config,
      webAuthn: { origin: origin.origin, rpId },
    });
    process.stdout.write(
      `Passkey origin configured: ${origin.origin} (${rpId})\n`,
    );
  });

auth
  .command("reset-recovery-codes")
  .description(
    "Administratively invalidate the old recovery code and issue a new one",
  )
  .action(async () => {
    const config = await readHostConfig(paths);
    if (!config.webAuthn)
      throw new Error(
        "Configure Passkey origin before resetting recovery codes",
      );
    const recoveryCodes = await withState((state) =>
      new PasskeyRegistry(state, {
        ...config.webAuthn!,
        nodeId: config.nodeId,
        userName: userInfo().username,
        userDisplayName: `${userInfo().username} · ${hostname()}`,
      }).rotateRecoveryCodes("local-admin"),
    );
    process.stdout.write(
      `The previous recovery code is now invalid. Deliver this code securely; it will not be shown again:\n\n${recoveryCodes[0]}\n`,
    );
  });

auth
  .command("issue-admin-recovery-ticket", { hidden: true })
  .option("--json", "Write a machine-readable result")
  .description("Issue a short-lived administrator recovery handoff")
  .action(async (options: { json?: boolean }) => {
    await assertRootManagedRecoveryInvocation();
    const config = await readHostConfig(paths);
    if (!config.webAuthn)
      throw new Error("Configure Passkey origin before recovering Web access");
    const result = await withState((state) =>
      new PasskeyRegistry(state, {
        ...config.webAuthn!,
        nodeId: config.nodeId,
        userName: userInfo().username,
        userDisplayName: `${userInfo().username} · ${hostname()}`,
      }).issueAdminRecoveryTicket("host-admin"),
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result)}\n`
        : `${result.handoffCode}\nExpires: ${result.expiresAt}\n`,
    );
  });

device
  .command("pair")
  .description("Issue a one-time device pairing grant")
  .action(async () => {
    const username = userInfo().username;
    let config;
    try {
      config = await readPairingHostConfig(paths, username);
    } catch (error) {
      if (!(error instanceof HostProvisioningRequiredError)) throw error;
      let selfProvisioning;
      try {
        selfProvisioning = await requestRootlessSelfProvisioningGrant();
      } catch (rootlessError) {
        if (!(rootlessError instanceof RootlessProvisionerUnavailableError))
          throw rootlessError;
        selfProvisioning = await requestSelfProvisioningGrant();
      }
      await applySelfProvisioningGrant(paths, selfProvisioning);
      config = await readPairingHostConfig(paths, username);
    }
    const runtime = { nodePath: process.execPath, cliPath: cliEntryPoint() };
    await installWatchdog(paths, runtime);
    await startAgentService(paths, runtime.cliPath);
    const identity = await loadOrCreateHostIdentity(paths.keysDir);
    const direct = directTransport(config.transport);
    const relay = relayTransport(config.transport);
    const grant = await withState((state) =>
      new DeviceRegistry(state).issuePairing(),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          version: 1,
          transport: relay ? "relay" : "direct",
          endpoint: (relay ?? direct)!.endpoint,
          ...(relay ? { routeId: relay.routeId } : {}),
          ...(direct ? { directEndpoint: direct.endpoint } : {}),
          ...(relay ? { relayEndpoint: relay.endpoint } : {}),
          nodeId: config.nodeId,
          userId: `unix:${process.getuid?.() ?? "unknown"}`,
          loginName: userInfo().username,
          hostPublicKey: Buffer.from(identity.keyPair.publicKey).toString(
            "base64url",
          ),
          hostFingerprint: identity.fingerprint,
          ...grant,
        },
        null,
        2,
      )}\n`,
    );
  });

program
  .command("doctor")
  .description("Check CodexEverywhere and HPC runtime prerequisites")
  .action(async () => {
    const config = await initializeHost(paths);
    const workspaceCount = await withWorkspaceRegistry(
      async (registry) => (await registry.list()).length,
    );
    const checks = await runDoctor(paths, config, workspaceCount);
    for (const check of checks) {
      process.stdout.write(
        `${check.ok ? "OK" : check.required ? "FAIL" : "WARN"}\t${check.name}\t${check.detail}\n`,
      );
    }
    if (checks.some((check) => check.required && !check.ok))
      process.exitCode = 1;
  });

device
  .command("list")
  .description("List trusted devices")
  .action(async () => {
    const devices = await withState((state) =>
      new DeviceRegistry(state).list(),
    );
    process.stdout.write(
      devices.length === 0
        ? "No trusted devices.\n"
        : `${devices
            .map(
              ({ id, name, createdAt, revokedAt }) =>
                `${id}\t${name}\t${revokedAt ? `revoked ${revokedAt}` : `trusted ${createdAt}`}`,
            )
            .join("\n")}\n`,
    );
  });

device
  .command("revoke")
  .argument("<device-id>")
  .description("Revoke a trusted device")
  .action(async (deviceId: string) => {
    const revoked = await withState((state) =>
      new DeviceRegistry(state).revoke(deviceId),
    );
    process.stdout.write(
      `${revoked ? "Revoked" : "Not active"}: ${deviceId}\n`,
    );
  });

try {
  await program.parseAsync();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

async function withWorkspaceRegistry<T>(
  operation: (registry: WorkspaceRegistry) => Promise<T>,
): Promise<T> {
  return withState((state) => operation(new WorkspaceRegistry(state)));
}

async function withState<T>(
  operation: (state: HostStateStore) => Promise<T>,
): Promise<T> {
  const state = await HostStateStore.open(paths.stateFile);
  try {
    return await operation(state);
  } finally {
    await state.close();
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TCP port: ${value}`);
  }
  return port;
}

function assertWebSocketEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error(
      "Transport endpoint must use wss:// (or ws:// for local development)",
    );
  }
}

function cliEntryPoint(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine ce CLI entry point");
  return entry;
}

async function readSecretFromStdin(label: string): Promise<string> {
  let value = "";
  if (process.stdin.isTTY) {
    process.stderr.write(`${label}: `);
    setTerminalEcho(false);
    try {
      const input = createInterface({ input: process.stdin });
      try {
        value = await input.question("");
      } finally {
        input.close();
      }
    } finally {
      setTerminalEcho(true);
      process.stderr.write("\n");
    }
  } else {
    for await (const chunk of process.stdin) {
      value += String(chunk);
      if (value.length > 64 * 1024) {
        throw new Error(`${label} is too large`);
      }
    }
  }
  const secret = value.trim();
  if (!secret) throw new Error(`${label} is required`);
  return secret;
}

async function assertRootManagedRecoveryInvocation(): Promise<void> {
  if (process.env.CE_ADMIN_RECOVERY !== "1")
    throw new Error(
      "Administrator recovery must be started from the control plane",
    );
  try {
    const parentStatus = await readFile(`/proc/${process.ppid}/status`, "utf8");
    const owner = /^Uid:\s+(\d+)/mu.exec(parentStatus)?.[1];
    if (owner !== "0") throw new Error("Parent process is not privileged");
  } catch (error) {
    throw new Error(
      "Administrator recovery must be invoked by the root-only helper",
      { cause: error },
    );
  }
}

function setTerminalEcho(enabled: boolean): void {
  execFileSync("/bin/stty", [enabled ? "echo" : "-echo"], {
    stdio: ["inherit", "ignore", "ignore"],
  });
}

async function runInteractive(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(command, args, { env, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited from signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function currentCodexRuntime(): Promise<{
  codexBinary: string;
  env: NodeJS.ProcessEnv;
}> {
  const config = await readHostConfig(paths);
  const env = codexProcessEnvironment(config.network, {
    userHome: homedir(),
  });
  const installation = await probeCodexInstallation({ env });
  if (!installation.installed) {
    throw new Error(
      "Codex is not installed. Complete the Codex setup in the PWA first.",
    );
  }
  return { codexBinary: installation.binary, env };
}

async function ensureConfiguredAppServer(): Promise<{
  started: boolean;
  pid?: number;
}> {
  return ensureAppServer(paths, await currentCodexRuntime());
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
