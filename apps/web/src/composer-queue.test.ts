import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const timelineSource = readFileSync(
  new URL("./thread-view.ts", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");
const queueSteerVisibilitySource = readFileSync(
  new URL("./queue-steer-visibility.ts", import.meta.url),
  "utf8",
);

describe("composer queue tray", () => {
  it("keeps pending messages next to the composer instead of in history", () => {
    expect(source).toContain('id="composer-queue"');
    expect(source).toContain('id="composer-queue-list"');
    expect(source).toContain("renderComposerQueue()");
    expect(source).toContain(
      'client.request<{ removed: boolean }>("queue/remove"',
    );
    expect(timelineSource).not.toContain("upsertQueuedUser");
    expect(timelineSource).not.toContain("queued-message");
    expect(styles).toContain(".composer-queue-item");
  });

  it("places the running turn stop action inside composer actions", () => {
    const composer = source.slice(source.indexOf('<div class="composer">'));
    const dialogs = composer.indexOf('<dialog id="settings-dialog"');
    const composerMarkup = composer.slice(0, dialogs);
    expect(composerMarkup).toContain('id="interrupt-turn"');
    expect(composerMarkup.indexOf('id="interrupt-turn"')).toBeGreaterThan(
      composerMarkup.indexOf('class="composer-actions"'),
    );
    expect(styles).toContain(".stop-action");
  });

  it("locks queue items while delivery is active or indeterminate", () => {
    const renderQueue = source.slice(
      source.indexOf("function renderComposerQueue"),
      source.indexOf("async function interruptActiveTurn"),
    );
    const acknowledge = source.slice(
      source.indexOf("async function acknowledgeIndeterminateQueuedMessage"),
      source.indexOf("function renderEvent"),
    );

    expect(queueSteerVisibilitySource).toContain('| "delivering"');
    expect(queueSteerVisibilitySource).toContain('| "indeterminate"');
    expect(renderQueue).toContain("正在提交给 Codex；此时不能移除或转为 Steer");
    expect(renderQueue).toContain(
      "投递结果无法确认；不会自动重发，请核对后再放弃记录",
    );
    expect(renderQueue).toContain("消息尚未提交，宿主机队列已安全暂停");
    expect(renderQueue).not.toContain("可移除后重新发送");
    expect(renderQueue.indexOf('item.status === "delivering"')).toBeLessThan(
      renderQueue.indexOf("const canSteer"),
    );
    expect(renderQueue.indexOf('item.status === "indeterminate"')).toBeLessThan(
      renderQueue.indexOf("const canSteer"),
    );
    expect(renderQueue).toContain("核对后放弃记录");
    expect(acknowledge).toContain("window.confirm");
    expect(acknowledge).toContain("acknowledgeIndeterminate: true");
    expect(styles).toContain(".composer-queue-item.delivering");
    expect(styles).toContain(".composer-queue-item.indeterminate");
    expect(styles).toContain(".queue-tray-acknowledge");
  });

  it("hides Steer behind an earlier unresolved dispatch in the same thread", () => {
    const renderQueue = source.slice(
      source.indexOf("function renderComposerQueue"),
      source.indexOf("async function interruptActiveTurn"),
    );
    const readQueue = source.slice(
      source.indexOf("async function renderQueuedMessages"),
      source.indexOf("function renderComposerQueue"),
    );

    expect(readQueue).not.toContain('if (item.status === "running") continue');
    expect(renderQueue).toContain("steerableQueueItemIds(items)");
    expect(renderQueue).toContain("steerableItemIds.has(item.id)");
    expect(renderQueue.indexOf("steerableItemIds.has(item.id)")).toBeLessThan(
      renderQueue.indexOf('steer.textContent = "转为 Steer"'),
    );
    expect(renderQueue).toContain(
      'remove.addEventListener("click", () => void removeQueuedMessage(item.id))',
    );
  });

  it("updates durable queue delivery states from Agent events", () => {
    const events = source.slice(
      source.indexOf("function renderEvent"),
      source.indexOf('event.type === "codex/thread/status/changed"'),
    );
    expect(events).toContain('event.type === "queue/delivering"');
    expect(events).toContain('event.type === "queue/indeterminate"');
    expect(events).toContain('? "delivering" : "indeterminate"');
    expect(events).toContain("renderQueuedMessages(activeThreadId");
  });
});
