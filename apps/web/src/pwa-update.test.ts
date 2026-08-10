import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { pwaUpdateBlockedReason } from "./pwa-update.js";

describe("safe PWA updates", () => {
  it("blocks refresh while a one-time secret is visible", () => {
    expect(
      pwaUpdateBlockedReason({
        oneTimeSecretVisible: true,
        draftPresent: false,
        operationPending: false,
      }),
    ).toContain("一次性凭据");
  });

  it("blocks refresh while a mutation outcome is unresolved", () => {
    expect(
      pwaUpdateBlockedReason({
        oneTimeSecretVisible: false,
        draftPresent: false,
        operationPending: true,
      }),
    ).toContain("待确认");
  });

  it("allows an explicit refresh once the page is safe", () => {
    expect(
      pwaUpdateBlockedReason({
        oneTimeSecretVisible: false,
        draftPresent: false,
        operationPending: false,
      }),
    ).toBeUndefined();
  });

  it("keeps a newly installed worker waiting for explicit activation", () => {
    const worker = readFileSync(
      new URL("../public/sw.js", import.meta.url),
      "utf8",
    );
    const installHandler = worker.slice(
      worker.indexOf('self.addEventListener("install"'),
      worker.indexOf('self.addEventListener("message"'),
    );
    expect(installHandler).not.toContain("skipWaiting");
    expect(worker).toContain('event.data?.type === "SKIP_WAITING"');
  });
});
