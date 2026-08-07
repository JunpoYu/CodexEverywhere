import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("user settings center", () => {
  it("consolidates global settings behind one explicit topbar action", () => {
    expect(source).toContain('id="settings-button"');
    expect(source).toContain('id="settings-dialog"');
    expect(source).not.toContain('id="settings-menu"');
    expect(source).toContain("新会话默认权限");
    expect(source).toContain("工作目录");
    expect(source).toContain("Web 身份与恢复");
  });

  it("shows inherited permissions before a new session is created", () => {
    expect(source).toContain('id="new-session-permission-summary"');
    expect(source).toContain('"preferences/read"');
    expect(source).toContain('"preferences/session-permissions/update"');
    expect(styles).toContain(".settings-center-grid");
    expect(styles).toContain(".settings-default-fields");
  });
});
