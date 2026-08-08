import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const timelineSource = readFileSync(
  new URL("./thread-view.ts", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");

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
});
