import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("conversation layout contract", () => {
  it("keeps the timeline and composer in explicit rows when optional chrome is hidden", () => {
    const marker = styles.indexOf(
      "Keep optional handoff chrome from changing timeline/composer placement",
    );
    expect(marker).toBeGreaterThanOrEqual(0);
    const contract = styles.slice(marker);
    expect(contract).toContain('"thread-header"');
    expect(contract).not.toContain('"thread-overview"');
    expect(contract).toContain('"ssh-handoff"');
    expect(contract).toContain('"timeline"');
    expect(contract).toContain('"composer"');
    expect(contract).toContain('"timeline outline"');
    expect(contract).toContain('"composer outline"');
    expect(contract).toMatch(/\.timeline\s*\{[^}]*min-height:\s*0;/su);
    expect(contract).toMatch(
      /\.composer\s*\{[^}]*min-height:\s*min-content;/su,
    );
    expect(contract).toContain("grid-area: timeline;");
    expect(contract).toContain("grid-area: composer;");
    expect(contract).toContain("grid-area: outline;");
    expect(contract).toMatch(/\.content\s*\{[^}]*position:\s*relative;/su);
    expect(contract).toMatch(
      /\.jump-to-latest\s*\{[^}]*grid-area:\s*timeline;[^}]*align-self:\s*end;/su,
    );
    expect(contract).toMatch(
      /@media \(min-width: 1181px\)[\s\S]*\.content:not\(\.outline-available\)\s*>\s*\.thread-outline-action:not\(\[hidden\]\)\s*\{[^}]*position:\s*absolute;[^}]*right:\s*0;[^}]*display:\s*inline-flex;/su,
    );
    expect(contract).toMatch(
      /\.conversation-outline\s*>\s*header\s+\.icon-button\s*\{[^}]*display:\s*grid;/su,
    );
    expect(contract).toMatch(
      /@media \(max-width: 1180px\)[\s\S]*\.thread-outline-action:not\(\[hidden\]\)\s*\{[^}]*display:\s*inline-flex;/su,
    );
  });
});
