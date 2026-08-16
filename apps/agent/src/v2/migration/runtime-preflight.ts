import type { ThreadListResponse } from "@codex-everywhere/codex-app-server-schema/v2";

import type { HostPaths } from "../../host/paths.js";
import { isProcessAlive, readProcessRecord } from "../../host/process-files.js";
import { probeAppServer } from "../../runtime/app-server-supervisor.js";
import { CodexAppServerClient } from "../../runtime/codex-app-server-client.js";
import type { MigrationRuntimeState } from "./state-migrator.js";

export async function inspectUserMigrationRuntime(
  paths: Pick<HostPaths, "agentPidFile" | "appServerSocket">,
): Promise<MigrationRuntimeState> {
  const agentRecord = await readProcessRecord(paths.agentPidFile);
  const agentRunning = agentRecord
    ? await isProcessAlive(agentRecord.pid)
    : false;
  const runningTurns = await countActiveAppServerThreads(paths.appServerSocket);
  return {
    // v0.3 does not expose its in-memory Side registry. Requiring the process
    // to stop is the only fail-closed external proof that every Side viewer
    // and unresolved interaction broker has been released.
    activeSideSessions: agentRunning ? 1 : 0,
    runningTurns,
    unresolvedInteractions: 0,
    deliveringQueue: 0,
    pendingMutations: 0,
    loginFlows: 0,
    activeLeases: agentRunning ? 1 : 0,
  };
}

export async function inspectAdminMigrationRuntime(
  controllerPidFile: string,
): Promise<MigrationRuntimeState> {
  const record = await readProcessRecord(controllerPidFile);
  const running = record ? await isProcessAlive(record.pid) : false;
  return {
    activeSideSessions: 0,
    runningTurns: 0,
    unresolvedInteractions: 0,
    deliveringQueue: 0,
    pendingMutations: 0,
    loginFlows: 0,
    activeLeases: running ? 1 : 0,
  };
}

async function countActiveAppServerThreads(
  socketPath: string,
): Promise<number> {
  if (!(await probeAppServer(socketPath))) return 0;
  const client = await CodexAppServerClient.connectUnix(socketPath, {
    name: "codex_everywhere_migration_preflight",
    title: "CodexEverywhere Migration Preflight",
    version: "0.4.0",
    timeoutMs: 5_000,
  });
  try {
    let cursor: string | null = null;
    let active = 0;
    let pages = 0;
    do {
      const response: ThreadListResponse =
        await client.request<ThreadListResponse>(
          "thread/list",
          {
            cursor,
            limit: 200,
            archived: false,
            useStateDbOnly: true,
          },
          { timeoutMs: 5_000 },
        );
      active += response.data.filter(
        (thread) => thread.status.type === "active",
      ).length;
      cursor = response.nextCursor;
      pages += 1;
      if (pages > 1_000) {
        throw new Error("App-server thread listing exceeded preflight bounds");
      }
    } while (cursor !== null);
    return active;
  } finally {
    await client.close();
  }
}
