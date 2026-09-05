const CACHE_PREFIX = "codex-everywhere-v";
const CACHE = "codex-everywhere-v56";
const ASSET_MANIFEST = "/asset-manifest.json";
const CORE = ["/manifest.webmanifest", "/icon.svg"];
const VERSION_REQUEST = "PWA_CACHE_VERSION_REQUEST";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE);
      const response = await fetch("/", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to precache the PWA shell");
      await cache.put("/", response.clone());
      const html = await response.text();
      const shellAssets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)]
        .map((match) => new URL(match[1], self.location.origin))
        .filter((url) => url.origin === self.location.origin)
        .map((url) => `${url.pathname}${url.search}`)
        .filter((url) => !CORE.includes(url));
      const manifestAssets = await buildManifestAssets(cache);
      await Promise.all(
        [...new Set([...shellAssets, ...manifestAssets])].map((url) =>
          fetchAndCache(cache, url),
        ),
      );
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const retained = await activeClientCacheNames();
      if (!retained) return;
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !retained.has(key))
          .map((key) => caches.delete(key)),
      );
    })(),
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
        if (responseMatchesRequest(request, response)) {
          await cache.put(request, response.clone());
          return response;
        }
        return (await matchVersionedCaches(request)) ?? response;
      } catch (error) {
        const cached = await matchVersionedCaches(
          request.mode === "navigate" ? "/" : request,
        );
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});

async function buildManifestAssets(cache) {
  const response = await fetch(ASSET_MANIFEST, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to precache the build manifest");
  await cache.put(ASSET_MANIFEST, response.clone());
  const manifest = await response.json();
  const assets = new Set();
  for (const entry of Object.values(manifest)) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid PWA build manifest");
    }
    addManifestAsset(assets, entry.file);
    for (const value of entry.css ?? []) addManifestAsset(assets, value);
    for (const value of entry.assets ?? []) addManifestAsset(assets, value);
  }
  return assets;
}

function addManifestAsset(assets, value) {
  if (typeof value !== "string" || value.length === 0) return;
  const url = new URL(
    value.startsWith("/") ? value : `/${value}`,
    self.location.origin,
  );
  if (url.origin === self.location.origin) assets.add(url.pathname);
}

async function fetchAndCache(cache, url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Unable to precache ${url}`);
  await cache.put(url, response);
}

async function activeClientCacheNames() {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  if (clients.length === 0) return new Set([CACHE]);
  const requests = clients.map((client) => requestClientCacheName(client));
  let timeoutId;
  try {
    const timeout = new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve(undefined), 2_000);
    });
    const responses = await Promise.race([
      Promise.all(requests.map((request) => request.promise)),
      timeout,
    ]);
    if (!responses || responses.some((cacheName) => cacheName === undefined)) {
      return undefined;
    }
    return new Set([CACHE, ...responses]);
  } finally {
    clearTimeout(timeoutId);
    for (const request of requests) request.close();
  }
}

function requestClientCacheName(client) {
  const channel = new MessageChannel();
  const promise = new Promise((resolve) => {
    channel.port1.onmessage = (event) => {
      const cacheName = event.data?.cacheName;
      resolve(
        typeof cacheName === "string" && cacheName.startsWith(CACHE_PREFIX)
          ? cacheName
          : undefined,
      );
    };
    client.postMessage({ type: VERSION_REQUEST }, [channel.port2]);
  });
  return { promise, close: () => channel.port1.close() };
}

async function matchVersionedCaches(request) {
  const keys = await caches.keys();
  const ordered = [
    CACHE,
    ...keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE),
  ];
  for (const key of ordered) {
    const response = await (await caches.open(key)).match(request);
    if (response) return response;
  }
  return undefined;
}

function responseMatchesRequest(request, response) {
  if (!response.ok) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (request.mode !== "navigate" && contentType.includes("text/html")) {
    return false;
  }
  if (request.destination === "script") {
    return contentType.includes("javascript");
  }
  if (request.destination === "style") return contentType.includes("text/css");
  if (request.destination === "manifest") {
    return contentType.includes("json") || contentType.includes("manifest");
  }
  return true;
}

function isShellResource(request) {
  return (
    request.mode === "navigate" ||
    ["document", "script", "style", "image", "font", "manifest"].includes(
      request.destination,
    )
  );
}
