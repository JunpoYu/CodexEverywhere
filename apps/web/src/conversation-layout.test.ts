import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("conversation layout contract", () => {
  it("keeps the timeline and composer in explicit rows when optional chrome is hidden", () => {
    const marker = styles.indexOf(
      "Keep optional thread chrome from changing timeline/composer placement",
    );
    expect(marker).toBeGreaterThanOrEqual(0);
    const contract = styles.slice(marker);
    expect(contract).toContain('"thread-header"');
    expect(contract).toContain('"thread-overview"');
    expect(contract).toContain('"ssh-handoff"');
    expect(contract).toContain('"timeline"');
    expect(contract).toContain('"composer"');
    expect(contract).toMatch(/\.timeline\s*\{[^}]*min-height:\s*0;/su);
    expect(contract).toMatch(
      /\.composer\s*\{[^}]*min-height:\s*min-content;/su,
    );
    expect(contract).toContain("grid-area: timeline;");
    expect(contract).toContain("grid-area: composer;");
  });
});
