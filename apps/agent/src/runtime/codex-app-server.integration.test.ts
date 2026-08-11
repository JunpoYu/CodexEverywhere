import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostStateStore } from "../host/state-store.js";
import { ThreadPermissionRegistry } from "../host/thread-permissions.js";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import { CodexAppServerProcess } from "./codex-app-server-process.js";
import {
  startTuiPermissionProxy,
  tuiThreadPermissionOptions,
  type TuiPermissionProxy,
} from "./tui-permission-proxy.js";

type ThreadStartResponse = {
  thread: { id: string };
  approvalPolicy?: unknown;
  sandbox?: { type: string };
};
type PaginatedThreadResumeResponse = ThreadStartResponse & {
  initialTurnsPage?: { data: unknown[]; nextCursor: string | null } | null;
};
type ThreadUnsubscribeResponse = {
  status: "notLoaded" | "notSubscribed" | "unsubscribed";
};
type ThreadListResponse = {
  data: Array<{ id: string; cwd: string }>;
};
type TurnStartResponse = { turn: { id: string } };
type TurnCompletedParams = {
  threadId: string;
  turn: { id: string; status: string };
};

const temporaryDirectories: string[] = [];
const processes: CodexAppServerProcess[] = [];
const clients: CodexAppServerClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const processHandle of processes.splice(0)) await processHandle.stop();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

async function startServer(options: { withAuth?: boolean } = {}): Promise<{
  processHandle: CodexAppServerProcess;
  socketPath: string;
  workspace: string;
  directory: string;
  codexHome: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ce-app-server-test-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "app-server.sock");
  const workspace = join(directory, "workspace");
  const codexHome = join(directory, "codex-home");
  await mkdir(workspace);
  await mkdir(codexHome, { mode: 0o700 });

  if (options.withAuth) {
    const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    await copyFile(
      join(sourceCodexHome, "auth.json"),
      join(codexHome, "auth.json"),
    );
  }

  const processHandle = await CodexAppServerProcess.start({
    socketPath,
    cwd: directory,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  processes.push(processHandle);
  return { processHandle, socketPath, workspace, directory, codexHome };
}

async function connect(
  socketPath: string,
  name: string,
): Promise<CodexAppServerClient> {
  const client = await CodexAppServerClient.connectUnix(socketPath, {
    name,
    experimentalApi: true,
  });
  clients.push(client);
  return client;
}

describe("real Codex app-server contract", () => {
  it("keeps explicit thread permissions after a complete app-server restart", async () => {
    const { processHandle, socketPath, workspace, directory, codexHome } =
      await startServer();
    const firstClient = await connect(socketPath, "ce_restart_permissions_a");
    let secondClient: CodexAppServerClient | undefined;
    let threadId: string | undefined;

    try {
      const started = await firstClient.request<ThreadStartResponse>(
        "thread/start",
        {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: false,
        },
      );
      threadId = started.thread.id;
      await firstClient.request("thread/name/set", {
        threadId,
        name: "Permission Restart Contract",
      });
      await firstClient.close();
      await processHandle.stop();
      await rm(socketPath, { force: true });

      const restarted = await CodexAppServerProcess.start({
        socketPath,
        cwd: directory,
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      processes.push(restarted);
      secondClient = await connect(socketPath, "ce_restart_permissions_b");

      const resumed = await secondClient.request<ThreadStartResponse>(
        "thread/resume",
        {
          threadId,
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      );
      expect(resumed.approvalPolicy).toBe("never");
      expect(resumed.sandbox?.type).toBe("dangerFullAccess");

      const resumedAgain = await secondClient.request<ThreadStartResponse>(
        "thread/resume",
        { threadId },
      );
      expect(resumedAgain.approvalPolicy).toBe("never");
      expect(resumedAgain.sandbox?.type).toBe("dangerFullAccess");
    } finally {
      if (threadId !== undefined) {
        await secondClient
          ?.request("thread/delete", { threadId })
          .catch(() => undefined);
      }
    }
  });

  it("shares one persistent thread between two clients", async () => {
    const { socketPath, workspace } = await startServer();
    const clientA = await connect(socketPath, "ce_contract_a");
    const clientB = await connect(socketPath, "ce_contract_b");
    let threadId: string | undefined;

    try {
      const started = await clientA.request<ThreadStartResponse>(
        "thread/start",
        {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: false,
        },
      );
      threadId = started.thread.id;
      await clientA.request("thread/name/set", {
        threadId,
        name: "Contract Test Initial",
      });
      const stateListed = await clientA.request<ThreadListResponse>(
        "thread/list",
        {
          cwd: workspace,
          limit: 100,
          sourceKinds: ["cli", "vscode", "appServer"],
          useStateDbOnly: true,
        },
      );
      expect(stateListed.data).toEqual(expect.any(Array));

      const resumed = await clientB.request<PaginatedThreadResumeResponse>(
        "thread/resume",
        {
          threadId,
          cwd: workspace,
          excludeTurns: true,
          initialTurnsPage: {
            limit: 20,
            sortDirection: "desc",
            itemsView: "full",
          },
        },
      );
      expect(resumed.thread.id).toBe(threadId);
      expect(resumed.initialTurnsPage?.data).toEqual([]);
      expect(resumed.approvalPolicy).toBe("never");
      expect(resumed.sandbox?.type).toBe("dangerFullAccess");

      const settingsNotificationA = clientA.waitForNotification(
        (notification) =>
          notification.method === "thread/settings/updated" &&
          (notification.params as { threadId?: string }).threadId === threadId,
      );
      const settingsNotificationB = clientB.waitForNotification(
        (notification) =>
          notification.method === "thread/settings/updated" &&
          (notification.params as { threadId?: string }).threadId === threadId,
      );
      await clientB.request("thread/settings/update", {
        threadId,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      await expect(settingsNotificationA).resolves.toMatchObject({
        params: {
          threadSettings: {
            approvalPolicy: "on-request",
            sandboxPolicy: { type: "readOnly" },
          },
        },
      });
      await expect(settingsNotificationB).resolves.toMatchObject({
        params: {
          threadSettings: {
            approvalPolicy: "on-request",
            sandboxPolicy: { type: "readOnly" },
          },
        },
      });

      const settingsResumed = await clientA.request<ThreadStartResponse>(
        "thread/resume",
        { threadId },
      );
      expect(settingsResumed.approvalPolicy).toBe("on-request");
      expect(settingsResumed.sandbox?.type).toBe("readOnly");

      const notificationA = clientA.waitForNotification(
        (notification) =>
          notification.method === "thread/name/updated" &&
          (notification.params as { threadId?: string }).threadId === threadId,
      );
      const notificationB = clientB.waitForNotification(
        (notification) =>
          notification.method === "thread/name/updated" &&
          (notification.params as { threadId?: string }).threadId === threadId,
      );

      await clientA.request("thread/name/set", {
        threadId,
        name: "Contract Test Shared",
      });
      await expect(notificationA).resolves.toMatchObject({
        method: "thread/name/updated",
      });
      await expect(notificationB).resolves.toMatchObject({
        method: "thread/name/updated",
      });

      await expect(
        clientA.request<ThreadUnsubscribeResponse>("thread/unsubscribe", {
          threadId,
        }),
      ).resolves.toEqual({ status: "unsubscribed" });
      const remainingSubscriberNotification = clientB.waitForNotification(
        (notification) =>
          notification.method === "thread/name/updated" &&
          (notification.params as { threadId?: string }).threadId === threadId,
      );
      await clientB.request("thread/name/set", {
        threadId,
        name: "Contract Test Remaining Subscriber",
      });
      await expect(remainingSubscriberNotification).resolves.toMatchObject({
        method: "thread/name/updated",
      });
    } finally {
      if (threadId !== undefined) {
        await clientB
          .request("thread/delete", { threadId })
          .catch(() => undefined);
      }
    }
  });

  it("keeps stored permissions when the official TUI resumes a thread", async () => {
    const { processHandle, socketPath, workspace, directory, codexHome } =
      await startServer();
    const webClient = await connect(socketPath, "ce_permission_web");
    const state = await HostStateStore.open(
      join(directory, "codex-everywhere-state.sqlite"),
    );
    const registry = new ThreadPermissionRegistry(state);
    let permissionProxy: TuiPermissionProxy | undefined;
    let cleanupClient: CodexAppServerClient = webClient;
    let threadId: string | undefined;

    try {
      const started = await webClient.request<ThreadStartResponse>(
        "thread/start",
        {
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: false,
        },
      );
      threadId = started.thread.id;
      await registry.saveResponse(started);
      await webClient.request("thread/name/set", {
        threadId,
        name: "Permission Inheritance Contract",
      });
      const tuiRuntime = await mkdtemp(join(tmpdir(), "ce-tui-runtime-"));
      temporaryDirectories.push(tuiRuntime);
      permissionProxy = await startTuiPermissionProxy({
        upstreamSocketPath: socketPath,
        runtimeDir: tuiRuntime,
        ...tuiThreadPermissionOptions(registry),
      });
      const tuiClient = await connect(
        permissionProxy.socketPath,
        "ce_permission_tui",
      );

      const resumed = await tuiClient.request<ThreadStartResponse>(
        "thread/resume",
        {
          threadId,
          cwd: workspace,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "read-only",
          permissions: "read-only",
        },
      );
      expect(resumed.approvalPolicy).toBe("never");
      expect(resumed.sandbox?.type).toBe("dangerFullAccess");

      const explicitlyUpdated = webClient.waitForNotification(
        (notification) =>
          notification.method === "thread/settings/updated" &&
          (notification.params as { threadId?: string }).threadId === threadId,
      );
      await tuiClient.request("thread/settings/update", {
        threadId,
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      await expect(explicitlyUpdated).resolves.toMatchObject({
        params: {
          threadSettings: {
            approvalPolicy: "on-request",
            sandboxPolicy: { type: "readOnly" },
          },
        },
      });
      await expect(registry.read(threadId)).resolves.toMatchObject({
        approvalPolicy: "on-request",
        sandbox: "read-only",
      });

      await tuiClient.close();
      await permissionProxy.close();
      permissionProxy = undefined;
      await webClient.close();
      await processHandle.stop();
      await rm(socketPath, { force: true });

      const restarted = await CodexAppServerProcess.start({
        socketPath,
        cwd: directory,
        env: { ...process.env, CODEX_HOME: codexHome },
      });
      processes.push(restarted);
      permissionProxy = await startTuiPermissionProxy({
        upstreamSocketPath: socketPath,
        runtimeDir: tuiRuntime,
        ...tuiThreadPermissionOptions(registry),
      });
      const restartedTui = await connect(
        permissionProxy.socketPath,
        "ce_permission_tui_restarted",
      );
      cleanupClient = restartedTui;
      const resumedAfterRestart =
        await restartedTui.request<ThreadStartResponse>("thread/resume", {
          threadId,
          cwd: workspace,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
      expect(resumedAfterRestart.approvalPolicy).toBe("on-request");
      expect(resumedAfterRestart.sandbox?.type).toBe("readOnly");
    } finally {
      if (threadId !== undefined) {
        await cleanupClient
          .request("thread/delete", { threadId })
          .catch(() => undefined);
      }
      await permissionProxy?.close();
      await state.close();
    }
  });

  it.skipIf(process.env.CE_RUN_MODEL_INTEGRATION !== "1")(
    "keeps an active turn running while the controlling client reconnects",
    async () => {
      const { socketPath, workspace } = await startServer({ withAuth: true });
      const clientA = await connect(socketPath, "ce_lifecycle_a");
      let threadId: string | undefined;

      try {
        const started = await clientA.request<ThreadStartResponse>(
          "thread/start",
          {
            cwd: workspace,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            ephemeral: false,
          },
        );
        threadId = started.thread.id;
        const turn = await clientA.request<TurnStartResponse>("turn/start", {
          threadId,
          cwd: workspace,
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
          input: [
            {
              type: "text",
              text: "Run the shell command `sleep 3`. Then reply with exactly CE_RECONNECT_OK.",
            },
          ],
        });

        await clientA.close();
        clients.splice(clients.indexOf(clientA), 1);
        await new Promise((resolve) => setTimeout(resolve, 500));

        const clientB = await connect(socketPath, "ce_lifecycle_b");
        await clientB.request("thread/resume", { threadId, cwd: workspace });
        const completed =
          await clientB.waitForNotification<TurnCompletedParams>(
            (notification) =>
              notification.method === "turn/completed" &&
              notification.params.threadId === threadId &&
              notification.params.turn.id === turn.turn.id,
            90_000,
          );

        expect(completed.params.turn.status).toBe("completed");
        await clientB.request("thread/delete", { threadId });
        threadId = undefined;
      } finally {
        if (threadId !== undefined) {
          const cleanup = await connect(socketPath, "ce_lifecycle_cleanup");
          await cleanup
            .request("thread/delete", { threadId })
            .catch(() => undefined);
        }
      }
    },
  );
});
