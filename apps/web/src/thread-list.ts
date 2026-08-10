import type { ThreadListParams } from "@codex-everywhere/codex-app-server-schema/v2";

export const FAST_THREAD_LIST_TIMEOUT_MS = 45_000;
export const LEGACY_THREAD_LIST_TIMEOUT_MS = 120_000;

export type ThreadListRequester = {
  request(
    method: string,
    payload: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
};

type ThreadListResult = { data: unknown[]; nextCursor?: string | null };

const legacyClients = new WeakSet<ThreadListRequester>();

/**
 * Normal history refreshes should use Codex's state database instead of
 * scanning every JSONL rollout to repair metadata. Older app-server versions
 * that reject the field retain the legacy behavior with a longer timeout.
 */
export async function requestThreadList<T extends ThreadListResult>(
  client: ThreadListRequester,
  params: ThreadListParams,
): Promise<T> {
  const { useStateDbOnly: _ignored, ...legacyParams } = params;
  if (legacyClients.has(client)) {
    return (await client.request("thread/list", legacyParams, {
      timeoutMs: LEGACY_THREAD_LIST_TIMEOUT_MS,
    })) as T;
  }

  try {
    const stateResult = (await client.request(
      "thread/list",
      { ...legacyParams, useStateDbOnly: true },
      { timeoutMs: FAST_THREAD_LIST_TIMEOUT_MS },
    )) as T;
    if (
      stateResult.data.length > 0 ||
      stateResult.nextCursor ||
      legacyParams.cursor
    ) {
      return stateResult;
    }
    return (await client.request("thread/list", legacyParams, {
      timeoutMs: LEGACY_THREAD_LIST_TIMEOUT_MS,
    })) as T;
  } catch (error) {
    if (!isUnsupportedStateDbOnly(error)) throw error;
    legacyClients.add(client);
    return (await client.request("thread/list", legacyParams, {
      timeoutMs: LEGACY_THREAD_LIST_TIMEOUT_MS,
    })) as T;
  }
}

export function mergeThreadPages<T extends { id: string }>(
  current: readonly T[],
  next: readonly T[],
): T[] {
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of next) merged.set(thread.id, thread);
  return [...merged.values()];
}

export function isUnsupportedStateDbOnly(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /useStateDbOnly|use_state_db_only/iu.test(message) &&
    /invalid|unknown|unexpected|unsupported|unrecognized/iu.test(message)
  );
}

export function threadListErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /archived|searchTerm|search_term|cursor/iu.test(message) &&
    /invalid|unknown|unexpected|unsupported|unrecognized/iu.test(message)
  ) {
    return "当前 Codex 版本不支持完整的归档搜索或分页；最近会话仍可使用，请升级宿主机上的 Codex 后重试。";
  }
  if (
    /thread\/list/iu.test(message) &&
    /timed out|timeout|超时/iu.test(message)
  ) {
    return "会话历史读取超时，已保留当前列表。稍后重试；正在运行的对话不会受影响。";
  }
  return message || "会话历史读取失败";
}
