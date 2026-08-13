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
});
