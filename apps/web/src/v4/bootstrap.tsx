import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/global.css";

import { mountPwaUpdatePrompt } from "../pwa-update.js";
import { App } from "./ui/App.js";

const container = document.getElementById("app");
if (!(container instanceof HTMLDivElement)) {
  throw new Error("CodexEverywhere app root is missing");
}

const unmountPwaUpdatePrompt = mountPwaUpdatePrompt();
window.addEventListener("pagehide", unmountPwaUpdatePrompt, { once: true });

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
