export type CoalescedTask = () => Promise<void>;

/**
 * Keep at most one task execution active. Calls received while it is running
 * are collapsed into exactly one follow-up execution so the latest state is
 * still observed without building an unbounded request queue.
 */
export function createCoalescedTask(task: CoalescedTask): CoalescedTask {
  let active: Promise<void> | undefined;
  let rerunRequested = false;

  return () => {
    if (active) {
      rerunRequested = true;
      return active;
    }

    active = (async () => {
      do {
        rerunRequested = false;
        await task();
      } while (rerunRequested);
    })().finally(() => {
      active = undefined;
    });
    return active;
  };
}
