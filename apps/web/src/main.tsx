import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { navigate, redirectHashRoute } from "./lib/route.ts";
import { ThemeProvider } from "./lib/theme.tsx";
import "./index.css";

// An old hash link ("/#/s/<id>") becomes its path ("/s/<id>") before anything reads the address.
redirectHashRoute();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);

// Service worker: app shell only (see public/sw.js). Skipped in dev so it never serves stale modules.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}

// A notification clicked while the app is open asks the window to move to its place (when the worker can't navigate it itself).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; path?: unknown } | null;
    const path = data?.type === "navigate" && typeof data.path === "string" ? data.path : "";
    if ((path.startsWith("/") && !path.startsWith("//")) || path.startsWith("#/")) navigate(path);
  });
}
