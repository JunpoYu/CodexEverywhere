import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("thread discovery contracts", () => {
  it("exposes paged current and archived history without adding deletion controls", () => {
    expect(mainSource).toContain('id="show-current-threads"');
    expect(mainSource).toContain('id="show-archived-threads"');
    expect(mainSource).toContain('id="load-more-threads"');
    expect(mainSource).toContain('"thread/unarchive"');
    expect(mainSource).toContain("page.nextCursor");
    expect(mainSource).not.toContain('id="delete-thread"');
  });

  it("keeps the default list compatible and isolates optional archive search failures", () => {
    expect(mainSource).toContain("...(archived ? { archived: true } : {})");
    expect(mainSource).toContain("Promise.allSettled");
    expect(mainSource).toContain("archiveClassificationUnknown");
  });

  it("probes UUID targets directly instead of relying on the first title page", () => {
    const discovery = mainSource.slice(
      mainSource.indexOf("async function searchThreadsAcrossArchive"),
      mainSource.indexOf("async function executeGoalCommand"),
    );
    expect(discovery).toContain('"thread/read"');
    expect(discovery).toContain("includeTurns: false");
    expect(discovery).toContain("threadListContainsId");
    expect(discovery).toContain("nextCursor");
  });
});
