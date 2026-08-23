import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// When a new service worker takes over (skipWaiting + clientsClaim), reload so the
// fresh bundle is served instead of the stale cached one that was already executing.
// Guard: if controllerchange fires while the page is still loading (e.g. a Cmd+R
// that triggers clientsClaim mid-navigation), skip the reload — the current load
// is already being served by the new SW. Only reload an already-complete page.
if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing || document.readyState !== "complete") return;
    refreshing = true;
    window.location.reload();
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
