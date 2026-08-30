/**
 * Routes. Port of `lib/app/router.dart`.
 *
 * `HashRouter` rather than `BrowserRouter`: the app is served from Tauri's
 * custom protocol with no server to rewrite deep paths, and the tray card is
 * opened as `index.html#/tray`, which only a hash route can address.
 *
 * The Dart build's `--dart-define=START=/route` boot flag has a direct
 * equivalent here - append the hash to the dev URL, or set `VITE_START`.
 */

import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "@/shell/AppShell";
import { Artist } from "@/routes/Artist";
import { Feed } from "@/routes/Feed";
import { Home } from "@/routes/Home";
import { Library } from "@/routes/Library";
import { Logs } from "@/routes/Logs";
import { Playlist } from "@/routes/Playlist";
import { Search } from "@/routes/Search";
import { Settings } from "@/routes/Settings";
import { Stats } from "@/routes/Stats";
import { TrackPage } from "@/routes/Track";
import { TrayPopup } from "@/routes/TrayPopup";

export function App() {
  return (
    <HashRouter>
      <Routes>
        {/* The tray card renders on its own, with no shell around it. */}
        <Route path="/tray" element={<TrayPopup />} />
        {/* Logs are full-bleed, as they were a top-level route in Dart. */}
        <Route path="/logs" element={<Logs />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<Home />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/library" element={<Library />} />
          <Route path="/track/:id" element={<TrackPage />} />
          <Route path="/artist/:handle" element={<Artist />} />
          <Route path="/search" element={<Search />} />
          <Route path="/playlist/:id" element={<Playlist />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
