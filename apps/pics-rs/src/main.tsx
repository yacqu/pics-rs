import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { usePreferencesStore } from "@/stores/preferencesStore";
import "@/index.css";

// Hydrate persisted preferences (and apply the theme) before first paint where
// possible; the store still renders with sensible defaults if this is slow.
void usePreferencesStore.getState().hydrate();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
