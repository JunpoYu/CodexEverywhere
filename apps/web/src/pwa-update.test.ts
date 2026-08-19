import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { forcePwaUpdateCheck, pwaUpdateBlockedReason } from "./pwa-update.js";

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

  it("forces an update check but keeps worker activation explicit", async () => {
    const postMessage = vi.fn();
    const update = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({
          update,
          waiting: { postMessage },
        })),
      },
    });

    await expect(forcePwaUpdateCheck()).resolves.toBe(true);
    expect(update).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  it("precaches lazy build assets and retains caches used by old tabs", () => {
    const worker = readFileSync(
      new URL("../public/sw.js", import.meta.url),
      "utf8",
    );
    const entry = readFileSync(new URL("./entry.ts", import.meta.url), "utf8");
    const viteConfig = readFileSync(
      new URL("../vite.config.ts", import.meta.url),
      "utf8",
    );

    expect(viteConfig).toContain('manifest: "asset-manifest.json"');
    expect(worker).toContain('const ASSET_MANIFEST = "/asset-manifest.json"');
    expect(worker).toContain("buildManifestAssets(cache)");
    expect(worker).toContain("matchVersionedCaches(request)");
    expect(worker).toContain('contentType.includes("text/html")');
    expect(worker).toContain("activeClientCacheNames()");
    expect(worker).toContain("if (!retained) return");
    const activation = worker.slice(
      worker.indexOf('self.addEventListener("activate"'),
      worker.indexOf('self.addEventListener("fetch"'),
    );
    expect(activation).toContain("!retained.has(key)");
    expect(activation).not.toContain("key !== CACHE");
    expect(entry).toContain('const PWA_ASSET_CACHE = "codex-everywhere-v50"');
    expect(entry).toContain("event.ports[0]?.postMessage");
    expect(worker).toContain('const CACHE = "codex-everywhere-v50"');
  });
});
