/**
 * Entry point. Port of `lib/main.dart`.
 *
 * The Dart original had to re-enter itself for the tray window
 * (`args.first == 'multi_window'`) because `desktop_multi_window` re-ran the
 * whole entrypoint per window. Here every window loads the same bundle and
 * the route decides what it is, so the only special case left is skipping
 * app-wide bootstrap for the tray card.
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import * as api from "@/api/client";
import { useAuthStore } from "@/state/authStore";
import { usePlayerStore } from "@/state/playerStore";
import { usePrefsStore } from "@/state/prefsStore";
import "@/theme/tokens.css";
import "@/theme/animations.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The Rust layer already degrades gracefully - a failed section comes
      // back empty rather than throwing - so a retry here mostly just delays
      // the render. One is enough for a genuine blip.
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const isTrayWindow = window.location.hash.startsWith("#/tray");

if (!isTrayWindow) {
  // Restores the stored token, then loads likes and reposts behind it.
  void useAuthStore.getState().restore();
  void usePrefsStore.getState().restore();
  // Opens on whatever was playing last, paused, instead of on an empty
  // player - the same track soundcloud.com shows when you come back to it.
  void usePlayerStore.getState().restoreLast();

  // Surface anything the UI throws into the same log the Rust side writes to.
  window.addEventListener("error", (e) => {
    void api.logWrite("ERROR", "ui", `${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    void api.logWrite("ERROR", "ui", `unhandled rejection: ${String(e.reason)}`);
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
