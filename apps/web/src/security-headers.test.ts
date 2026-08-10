import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const nginxConfigs = [
  "../../../deploy/nginx/codex-everywhere.conf",
  "../../../deploy/nginx/direct-host.conf",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const indexHtml = readFileSync(
  new URL("../index.html", import.meta.url),
  "utf8",
);

describe("production content security policy", () => {
  it("allows KaTeX layout attributes without allowing inline scripts or style elements", () => {
    for (const config of nginxConfigs) {
      expect(config).toContain("style-src 'self';");
      expect(config).toContain("style-src-attr 'unsafe-inline';");
      expect(config).not.toContain("style-src 'self' 'unsafe-inline'");
      expect(config).toContain("script-src 'self' 'wasm-unsafe-eval';");
    }
  });

  it("loads the pre-paint theme bootstrap as a CSP-compatible same-origin script", () => {
    expect(indexHtml).toContain('<script src="/theme-bootstrap.js"></script>');
    expect(indexHtml).not.toMatch(/<script>(?:.|\n)*<\/script>/u);
  });
});
