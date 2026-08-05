const CACHE = "codex-everywhere-v37";
const CORE = ["/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
      const response = await fetch("/", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to precache the PWA shell");
      await cache.put("/", response.clone());
      const html = await response.text();
      const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)]
        .map((match) => new URL(match[1], self.location.origin))
        .filter((url) => url.origin === self.location.origin)
        .map((url) => `${url.pathname}${url.search}`)
        .filter((url) => !CORE.includes(url));
      await Promise.all(
        [...new Set(assets)].map(async (url) => {
          const asset = await fetch(url, { cache: "no-store" });
          if (asset.ok) await cache.put(url, asset);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== CACHE)
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !isShellResource(request)
  ) {
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(
          request.mode === "navigate" ? "/" : request,
        );
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});

function isShellResource(request) {
  return (
    request.mode === "navigate" ||
    ["document", "script", "style", "image", "font", "manifest"].includes(
      request.destination,
    )
  );
}
