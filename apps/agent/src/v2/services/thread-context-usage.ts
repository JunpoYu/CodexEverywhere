import type { ThreadTokenUsageUpdatedNotification } from "@codex-everywhere/codex-app-server-schema/v2";
import {
  threadContextUsageSchema,
  type ThreadContextUsage,
} from "@codex-everywhere/protocol/v2";

/** Projects the app-server payload into CE's stable, minimal UI contract. */
export function projectThreadContextUsage(
  notification: ThreadTokenUsageUpdatedNotification,
): ThreadContextUsage | undefined {
  const projected = threadContextUsageSchema.safeParse({
    version: 1,
    turnId: notification.turnId,
    currentTokens: notification.tokenUsage.last.totalTokens,
    cumulativeTokens: notification.tokenUsage.total.totalTokens,
    modelContextWindow: notification.tokenUsage.modelContextWindow,
  });
  return projected.success ? projected.data : undefined;
}
