import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("composer session metadata", () => {
  it("keeps editable session settings beside the input instead of a header row", () => {
    expect(source).not.toContain('id="thread-overview"');
    expect(source).toContain('id="composer-session-meta"');
    expect(source).toContain('id="thread-permission-summary"');
    expect(source).toContain('id="thread-model-summary"');
    expect(source).toContain('id="thread-permission-pending"');
    expect(source).toContain('openThreadSettings("permissions")');
    expect(source).toContain('openThreadSettings("model")');
  });

  it("renders an accessible circular context indicator with warning levels", () => {
    expect(source).toContain('role="progressbar"');
    expect(source).toContain('aria-valuemax="100"');
    expect(source).toContain('id="thread-context-ring"');
    expect(source).toContain('"--context-progress"');
    expect(styles).toContain("conic-gradient(");
    expect(styles).toContain(".session-context.warning");
    expect(styles).toContain(".session-context.danger");
  });
});
