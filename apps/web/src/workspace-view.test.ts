import { describe, expect, it } from "vitest";

import {
  ALL_WORKSPACES,
  threadsInWorkspace,
  workspaceContainsCwd,
  workspaceForCwd,
} from "./workspace-view.js";

describe("workspace session scope", () => {
  const threads = [
    { id: "root", cwd: "/public/home/user/project" },
    { id: "child", cwd: "/public/home/user/project/packages/web" },
    { id: "other", cwd: "/public/home/user/project-old" },
  ];

  it("includes nested directories without matching sibling prefixes", () => {
    expect(
      workspaceContainsCwd("/public/home/user/project", threads[1]!.cwd),
    ).toBe(true);
    expect(
      workspaceContainsCwd("/public/home/user/project", threads[2]!.cwd),
    ).toBe(false);
    expect(
      threadsInWorkspace(threads, "/public/home/user/project").map(
        (thread) => thread.id,
      ),
    ).toEqual(["root", "child"]);
  });

  it("supports an explicit all-workspaces scope", () => {
    expect(threadsInWorkspace(threads, ALL_WORKSPACES)).toHaveLength(3);
  });

  it("uses the most specific registered root for an active thread", () => {
    expect(
      workspaceForCwd(
        ["/public/home/user", "/public/home/user/project"],
        "/public/home/user/project/packages/web",
      ),
    ).toBe("/public/home/user/project");
  });
});
