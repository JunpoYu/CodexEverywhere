import "katex/dist/katex.min.css";
import "./style.css";

void registerServiceWorker();

if (location.pathname === "/admin" || location.pathname.startsWith("/admin/")) {
  void import("./admin-main.js");
} else {
  void import("./main.js");
}

async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  if (hadController) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    await registration.update();
  } catch {
    // The Web app remains usable when service workers are unavailable.
  }
}
