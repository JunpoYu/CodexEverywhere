import type {
  ThreadResumeResponse,
  Turn,
  TurnsPage,
} from "@codex-everywhere/codex-app-server-schema/v2";

export const HISTORY_PAGE_SIZE = 20;
export const HISTORY_SYNC_TURN_LIMIT = 5;

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
      return { detail: resumed, nextCursor: undefined, paged: false };
    }
    const detail = await client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
    });
    return { detail, nextCursor: undefined, paged: false };
  }
}

export function newestPageInReadingOrder(page: TurnsPage): Turn[] {
  return [...page.data].reverse();
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
