import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  isUserTimelineItem,
  type TimelineItem,
} from "./timeline-item-model.js";
import { TimelineItemView } from "./TimelineItemView.js";
import styles from "./TimelineViewport.module.css";

const FOLLOW_LATEST_THRESHOLD = 80;

type ViewportMode =
  "initializing" | "following" | "detached" | "restoring" | "jumping";

export interface TimelineViewportHandle {
  loadEarlier(): boolean;
  scrollToItem(itemId: string): boolean;
  scrollToLatest(): void;
}

export const TimelineViewport = forwardRef<
  TimelineViewportHandle,
  {
    readonly hasEarlierHistory: boolean;
    readonly historyDisabled?: boolean;
    readonly historyError?: string | undefined;
    readonly historyStatus: "idle" | "loading" | "failed";
    readonly items: readonly TimelineItem[];
    readonly onActiveUserItemChange?:
      ((itemId: string | undefined) => void) | undefined;
    /** Returns whether the actor accepted or is already serving the request. */
    readonly onLoadEarlier: () => boolean;
  }
>(function TimelineViewport(input, forwardedRef) {
  const containerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const itemElements = useRef(new Map<string, HTMLElement>());
  const itemsRef = useRef(input.items);
  itemsRef.current = input.items;
  const activeCallbackRef = useRef(input.onActiveUserItemChange);
  activeCallbackRef.current = input.onActiveUserItemChange;
  const activeItemIdRef = useRef<string | undefined>(undefined);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const focusFrameRef = useRef<number | undefined>(undefined);
  const anchorFrameRef = useRef<number | undefined>(undefined);
  const prependAnchorRef = useRef<
    | {
        readonly itemId?: string;
        readonly offset: number;
        readonly scrollHeight: number;
      }
    | undefined
  >(undefined);
  const [mode, setModeState] = useState<ViewportMode>("initializing");
  const modeRef = useRef<ViewportMode>("initializing");
  const [jumpTargetId, setJumpTargetId] = useState<string | undefined>();

  const setMode = useCallback((next: ViewportMode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const container = containerRef.current;
      if (container === null) return;
      setMode("following");
      container.scrollTo({ top: container.scrollHeight, behavior });
    },
    [setMode],
  );

  const updateActiveItem = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    const containerRect = container.getBoundingClientRect();
    const marker =
      containerRect.top + Math.min(container.clientHeight * 0.28, 190);
    let activeItemId: string | undefined;
    for (const item of itemsRef.current) {
      if (!isUserTimelineItem(item)) continue;
      const element = itemElements.current.get(item.id);
      if (element === undefined) continue;
      if (element.getBoundingClientRect().top <= marker) activeItemId = item.id;
      else break;
    }
    if (activeItemId === undefined) {
      activeItemId = itemsRef.current.find(isUserTimelineItem)?.id;
    }
    if (activeItemIdRef.current === activeItemId) return;
    activeItemIdRef.current = activeItemId;
    activeCallbackRef.current?.(activeItemId);
  }, []);

  const scheduleViewportUpdate = useCallback(() => {
    if (scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const container = containerRef.current;
      if (container === null) return;
      const distance =
        container.scrollHeight - container.clientHeight - container.scrollTop;
      if (
        modeRef.current !== "initializing" &&
        modeRef.current !== "restoring"
      ) {
        setMode(distance <= FOLLOW_LATEST_THRESHOLD ? "following" : "detached");
      }
      updateActiveItem();
    });
  }, [setMode, updateActiveItem]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const anchor = prependAnchorRef.current;
    if (anchor !== undefined) {
      const element =
        anchor.itemId === undefined
          ? undefined
          : itemElements.current.get(anchor.itemId);
      if (element === undefined) {
        container.scrollTop += container.scrollHeight - anchor.scrollHeight;
      } else {
        restoreElementOffset(container, element, anchor.offset);
        if (anchorFrameRef.current !== undefined) {
          window.cancelAnimationFrame(anchorFrameRef.current);
        }
        anchorFrameRef.current = window.requestAnimationFrame(() => {
          anchorFrameRef.current = undefined;
          if (container.isConnected && element.isConnected) {
            restoreElementOffset(container, element, anchor.offset);
            updateActiveItem();
          }
        });
      }
      prependAnchorRef.current = undefined;
      setMode("detached");
      updateActiveItem();
      return;
    }
    if (modeRef.current === "initializing") {
      scrollToLatest();
      updateActiveItem();
      return;
    }
    if (modeRef.current === "following") {
      container.scrollTop = container.scrollHeight;
      updateActiveItem();
    }
  }, [input.items, scrollToLatest, setMode, updateActiveItem]);

  useLayoutEffect(() => {
    if (
      input.historyStatus !== "loading" &&
      prependAnchorRef.current !== undefined
    ) {
      prependAnchorRef.current = undefined;
      setMode("detached");
    }
  }, [input.historyStatus, setMode]);

  useEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (modeRef.current === "following") {
        const container = containerRef.current;
        if (container !== null) container.scrollTop = container.scrollHeight;
      }
      updateActiveItem();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [updateActiveItem]);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (focusFrameRef.current !== undefined) {
        window.cancelAnimationFrame(focusFrameRef.current);
      }
      if (anchorFrameRef.current !== undefined) {
        window.cancelAnimationFrame(anchorFrameRef.current);
      }
    },
    [],
  );

  const loadEarlier = useCallback((): boolean => {
    const container = containerRef.current;
    if (
      container === null ||
      input.historyDisabled === true ||
      input.historyStatus === "loading" ||
      !input.hasEarlierHistory
    ) {
      return false;
    }
    const containerRect = container.getBoundingClientRect();
    let firstVisible:
      { readonly id: string; readonly offset: number } | undefined;
    for (const item of input.items) {
      const element = itemElements.current.get(item.id);
      if (element === undefined) continue;
      const rect = element.getBoundingClientRect();
      if (rect.bottom >= containerRect.top + 1) {
        firstVisible = { id: item.id, offset: rect.top - containerRect.top };
        break;
      }
    }
    prependAnchorRef.current = {
      ...(firstVisible === undefined ? {} : { itemId: firstVisible.id }),
      offset: firstVisible?.offset ?? container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
    setMode("restoring");
    if (!input.onLoadEarlier()) {
      prependAnchorRef.current = undefined;
      const distance =
        container.scrollHeight - container.clientHeight - container.scrollTop;
      setMode(distance <= FOLLOW_LATEST_THRESHOLD ? "following" : "detached");
      return false;
    }
    return true;
  }, [
    input.hasEarlierHistory,
    input.historyDisabled,
    input.historyStatus,
    input.items,
    input.onLoadEarlier,
    setMode,
  ]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      loadEarlier,
      scrollToItem(itemId) {
        const element = itemElements.current.get(itemId);
        const container = containerRef.current;
        if (element === undefined || container === null) return false;
        const latestId = itemsRef.current.at(-1)?.id;
        setMode(itemId === latestId ? "following" : "jumping");
        setJumpTargetId(itemId);
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const top =
          container.scrollTop +
          elementRect.top -
          containerRect.top -
          (container.clientHeight - elementRect.height) / 2;
        container.scrollTo({
          top,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        if (focusFrameRef.current !== undefined) {
          window.cancelAnimationFrame(focusFrameRef.current);
        }
        focusFrameRef.current = window.requestAnimationFrame(() => {
          focusFrameRef.current = undefined;
          if (element.isConnected) element.focus({ preventScroll: true });
        });
        return true;
      },
      scrollToLatest() {
        scrollToLatest(prefersReducedMotion() ? "auto" : "smooth");
      },
    }),
    [loadEarlier, scrollToLatest, setMode],
  );

  return (
    <div className={styles.frame}>
      <section
        aria-label="任务时间线"
        aria-live="polite"
        className={`timeline ${styles.viewport}`}
        ref={containerRef}
        onScroll={scheduleViewportUpdate}
      >
        <div className={styles.content} ref={contentRef}>
          {input.hasEarlierHistory ? (
            <button
              className={styles.loadEarlier}
              disabled={
                input.historyDisabled === true ||
                input.historyStatus === "loading"
              }
              type="button"
              onClick={() => void loadEarlier()}
            >
              {input.historyStatus === "loading"
                ? "正在加载更早记录…"
                : input.historyStatus === "failed"
                  ? "重试加载更早记录"
                  : "加载更早记录"}
            </button>
          ) : null}
          {input.historyError === undefined ? null : (
            <p className={styles.historyError} role="alert">
              {input.historyError}
            </p>
          )}
          {input.items.map((item) => (
            <TimelineItemView
              className={`${styles.item}${jumpTargetId === item.id ? ` ${styles.jumpTarget}` : ""}`}
              elementRef={(element) => {
                if (element === null) itemElements.current.delete(item.id);
                else itemElements.current.set(item.id, element);
              }}
              item={item}
              key={item.id}
              onAnimationEnd={() => {
                if (jumpTargetId === item.id) setJumpTargetId(undefined);
              }}
            />
          ))}
        </div>
      </section>
      {mode === "detached" || mode === "jumping" ? (
        <button
          className={styles.latest}
          type="button"
          onClick={() =>
            scrollToLatest(prefersReducedMotion() ? "auto" : "smooth")
          }
        >
          回到最新
        </button>
      ) : null}
    </div>
  );
});

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function restoreElementOffset(
  container: HTMLElement,
  element: HTMLElement,
  expectedOffset: number,
): void {
  const offset =
    element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollTop += offset - expectedOffset;
}
