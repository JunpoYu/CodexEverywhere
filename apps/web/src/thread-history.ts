import type {
  ThreadReadResponse,
  ThreadResumeResponse,
  Turn,
  TurnsPage,
} from "@codex-everywhere/codex-app-server-schema/v2";

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_SYNC_TURN_LIMIT = 5;

export type ThreadHistoryMode = "none" | "initializing" | "paged" | "legacy";

export type ThreadHistoryClient = {
  request<T>(method: string, payload: unknown): Promise<T>;
};

export type PaginatedThreadResumeResponse = ThreadResumeResponse & {
  initialTurnsPage?: TurnsPage | null;
};

export type OpenThreadHistory = {
  detail: ThreadResumeResponse;
  nextCursor: string | undefined;
  paged: boolean;
};

export type ThreadRepairSnapshot = {
  detail: ThreadReadResponse;
  displayTurns: Turn[];
  reconciliationTurns: Turn[];
  turnsAuthoritative: boolean;
  mode: "paged" | "legacy";
  nextCursor: string | undefined;
};

export async function readThreadRepairSnapshot(
  client: ThreadHistoryClient,
  threadId: string,
  mode: "paged" | "legacy",
): Promise<ThreadRepairSnapshot> {
  if (mode === "paged") {
    try {
      const [detail, page] = await Promise.all([
        client.request<ThreadReadResponse>("thread/read", {
          threadId,
          includeTurns: false,
        }),
        client.request<TurnsPage>("thread/turns/list", {
          threadId,
          limit: HISTORY_SYNC_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
        }),
      ]);
      const turns = newestPageInReadingOrder(page);
      return {
        detail,
        displayTurns: turns,
        reconciliationTurns: turns,
        turnsAuthoritative: page.nextCursor == null,
        mode: "paged",
        nextCursor: page.nextCursor ?? undefined,
      };
    } catch (error) {
      if (!isTurnsPaginationUnsupported(error)) throw error;
    }
  }

  const detail = await client.request<ThreadReadResponse>("thread/read", {
    threadId,
    includeTurns: true,
  });
  return {
    detail,
    displayTurns: newestTurnsWithinLimit(detail.thread.turns),
    reconciliationTurns: detail.thread.turns,
    turnsAuthoritative: true,
    mode: "legacy",
    nextCursor: undefined,
  };
}

export function retainRepairHistoryCursor(
  currentCursor: string | undefined,
  repairCursor: string | undefined,
  exhausted: boolean,
  exhaustedBoundaryVisible: boolean,
): string | undefined {
  return (
    currentCursor ??
    (exhausted && exhaustedBoundaryVisible ? undefined : repairCursor)
  );
}

export async function resumeThreadHistory(
  client: ThreadHistoryClient,
  threadId: string,
): Promise<OpenThreadHistory> {
  let resumed: PaginatedThreadResumeResponse | undefined;
  try {
    resumed = await client.request<PaginatedThreadResumeResponse>(
      "thread/resume",
      {
        threadId,
        excludeTurns: true,
        initialTurnsPage: {
          limit: HISTORY_PAGE_SIZE,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
    );
    const page =
      resumed.initialTurnsPage ??
      (await client.request<TurnsPage>("thread/turns/list", {
        threadId,
        limit: HISTORY_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "full",
      }));
    return {
      detail: withThreadTurns(resumed, newestPageInReadingOrder(page)),
      nextCursor: page.nextCursor ?? undefined,
      paged: true,
    };
  } catch (error) {
    if (!isTurnsPaginationUnsupported(error)) throw error;
    if (resumed) {
      return {
        detail: withThreadTurns(
          resumed,
          newestTurnsWithinLimit(resumed.thread.turns),
        ),
        nextCursor: undefined,
        paged: false,
      };
    }
    const detail = await client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
    });
    return {
      detail: withThreadTurns(
        detail,
        newestTurnsWithinLimit(detail.thread.turns),
      ),
      nextCursor: undefined,
      paged: false,
    };
  }
}

export async function readEphemeralThreadHistory(
  client: ThreadHistoryClient,
  threadId: string,
  fallback: ThreadResumeResponse,
): Promise<OpenThreadHistory> {
  let detail = await client.request<ThreadReadResponse>("thread/read", {
    threadId,
    includeTurns: false,
  });
  if (detail.thread.status.type === "active") {
    try {
      return await resumeThreadHistory(client, threadId);
    } catch (error) {
      // An ephemeral turn can finish between the read and resume. Recheck the
      // live in-memory thread before treating the missing rollout as fatal.
      detail = await client.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (detail.thread.status.type === "active") throw error;
    }
  }
  const page = await client.request<TurnsPage>("thread/turns/list", {
    threadId,
    limit: HISTORY_PAGE_SIZE,
    sortDirection: "desc",
    itemsView: "full",
  });
  return {
    detail: {
      ...fallback,
      thread: {
        ...detail.thread,
        turns: newestPageInReadingOrder(page),
      },
    },
    nextCursor: page.nextCursor ?? undefined,
    paged: true,
  };
}

export function newestPageInReadingOrder(page: TurnsPage): Turn[] {
  return [...page.data].reverse();
}

export function newestTurnsWithinLimit(
  turns: readonly Turn[],
  limit = HISTORY_PAGE_SIZE,
): Turn[] {
  return turns.slice(-limit);
}

export function threadHistorySyncStrategy(
  mode: ThreadHistoryMode,
): "skip" | "initialize" | "paged" | "legacy" {
  if (mode === "initializing") return "initialize";
  if (mode === "paged") return "paged";
  if (mode === "legacy") return "legacy";
  return "skip";
}

export function legacyHistorySyncIsCurrent(
  requestedMode: ThreadHistoryMode,
  currentMode: ThreadHistoryMode,
): boolean {
  return requestedMode === "legacy" && currentMode === requestedMode;
}

export function isTurnsPaginationUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unsupported gateway method: thread\/turns\/list|method not found|unknown method|unknown field.*(?:excludeTurns|initialTurnsPage)|invalid params.*(?:excludeTurns|initialTurnsPage)/iu.test(
    message,
  );
}

function withThreadTurns(
  detail: ThreadResumeResponse,
  turns: Turn[],
): ThreadResumeResponse {
  return { ...detail, thread: { ...detail.thread, turns } };
}
