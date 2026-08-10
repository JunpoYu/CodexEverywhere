export type ThreadStartMarkerStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

const THREAD_START_MARKER_KEY = "codex-everywhere:thread-start-unresolved";
const THREAD_START_MARKER_VALUE = JSON.stringify({
  version: 1,
  unresolved: true,
});

/**
 * The presence of the reserved key is fail-closed, including for a future or
 * malformed value. Its fixed value intentionally contains no operation id,
 * prompt, cwd, identity, or Host profile.
 */
export function hasUnresolvedThreadStartMarker(
  storage: ThreadStartMarkerStorage | undefined,
): boolean {
  try {
    if (!storage) return false;
    return storage.getItem(THREAD_START_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

export function markThreadStartUnresolved(
  storage: ThreadStartMarkerStorage | undefined,
): void {
  try {
    storage?.setItem(THREAD_START_MARKER_KEY, THREAD_START_MARKER_VALUE);
  } catch {
    // Browsers may reject sessionStorage in hardened or private contexts. The
    // caller keeps the same safety state in memory for the current page.
  }
}

export function clearUnresolvedThreadStartMarker(
  storage: ThreadStartMarkerStorage | undefined,
): void {
  try {
    storage?.removeItem(THREAD_START_MARKER_KEY);
  } catch {
    // A storage failure must not break a known response or explicit abandon.
  }
}
