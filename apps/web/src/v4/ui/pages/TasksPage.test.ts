import { describe, expect, it } from "vitest";

import { defaultPermissionsChanged } from "./TasksPage.js";

describe("TasksPage default permissions", () => {
  it("ignores unrelated preference revisions", () => {
    expect(
      defaultPermissionsChanged(
        { sandbox: "workspace-write", approvalPolicy: "on-request" },
        { sandbox: "workspace-write", approvalPolicy: "on-request" },
      ),
    ).toBe(false);
  });

  it("requires confirmation when either default permission changes", () => {
    expect(
      defaultPermissionsChanged(
        { sandbox: "workspace-write", approvalPolicy: "on-request" },
        { sandbox: "read-only", approvalPolicy: "on-request" },
      ),
    ).toBe(true);
  });
});
