import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerClient } from "./codex-app-server-client.js";
import { CodexAppServerProcess } from "./codex-app-server-process.js";

type ThreadStartResponse = { thread: { id: string } };
type ThreadUnsubscribeResponse = {
  status: "notLoaded" | "notSubscribed" | "unsubscribed";
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
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(): Promise<{
  processHandle: CodexAppServerProcess;
  socketPath: string;
  workspace: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ce-app-server-test-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "app-server.sock");
  const workspace = join(directory, "workspace");
  const codexHome = join(directory, "codex-home");
  await mkdir(workspace);
  await mkdir(codexHome, { mode: 0o700 });

  const sourceCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  await copyFile(
    join(sourceCodexHome, "auth.json"),
    join(codexHome, "auth.json"),
  );

  const processHandle = await CodexAppServerProcess.start({
    socketPath,
    cwd: directory,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  processes.push(processHandle);
  return { processHandle, socketPath, workspace };
}

async function connect(
  socketPath: string,
  name: string,
): Promise<CodexAppServerClient> {
  const client = await CodexAppServerClient.connectUnix(socketPath, { name });
  clients.push(client);
  return client;
}

describe("real Codex app-server contract", () => {
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

      const resumed = await clientB.request<ThreadStartResponse>(
        "thread/resume",
        {
          threadId,
          cwd: workspace,
        },
      );
      expect(resumed.thread.id).toBe(threadId);

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

  it.skipIf(process.env.CE_RUN_MODEL_INTEGRATION !== "1")(
    "keeps an active turn running while the controlling client reconnects",
    async () => {
      const { socketPath, workspace } = await startServer();
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
