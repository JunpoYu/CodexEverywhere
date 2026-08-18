import { announcePwaUpdate } from "./pwa-update.js";

const PWA_ASSET_CACHE = "codex-everywhere-v45";

void registerServiceWorker();

void import("./v4/bootstrap.js");

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "PWA_CACHE_VERSION_REQUEST") {
      return;
    }
    event.ports[0]?.postMessage({
      cacheName: PWA_ASSET_CACHE,
    });
  });
  let hadController = navigator.serviceWorker.controller !== null;
  let activationRequested = false;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (activationRequested) {
      if (reloading) return;
      reloading = true;
      window.location.reload();
      return;
    }
    if (!hadController) {
      hadController = true;
      return;
    }
    // Another tab may have activated the worker. This tab still waits for an
    // explicit, safety-checked refresh instead of discarding local state.
    announcePwaUpdate(() => window.location.reload());
  });
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    const offer = (worker: ServiceWorker): void => {
      announcePwaUpdate(() => {
        activationRequested = true;
        worker.postMessage({ type: "SKIP_WAITING" });
      });
    };
    if (registration.waiting && navigator.serviceWorker.controller)
      offer(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (
          installing.state === "installed" &&
          navigator.serviceWorker.controller
        )
          offer(registration.waiting ?? installing);
      });
    });
    await registration.update();
  } catch {
    // The Web app remains usable when service workers are unavailable.
  }
}
