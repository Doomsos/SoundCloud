/**
 * Persisted playback settings. Port of `playback_prefs.dart`.
 *
 * Values live in the same `prefs.json` under the same keys the Flutter build
 * used, so an existing install keeps its settings.
 */

import { create } from "zustand";

import * as api from "@/api/client";

const KEY_CROSSFADE = "playback_crossfade_ms";
/** The Dart controller clamped to this range; the settings slider matches. */
export const CROSSFADE_MAX_MS = 6000;

interface PrefsState {
  crossfadeMs: number;
  restored: boolean;
  restore(): Promise<void>;
  setCrossfadeMs(ms: number): void;
}

export const usePrefsStore = create<PrefsState>((set) => ({
  crossfadeMs: 0,
  restored: false,

  async restore() {
    const raw = await api.safe(() => api.prefsGetInt(KEY_CROSSFADE), null, "prefs");
    if (raw !== null && Number.isFinite(raw)) {
      set({ crossfadeMs: Math.min(CROSSFADE_MAX_MS, Math.max(0, raw)) });
    }
    set({ restored: true });
  },

  setCrossfadeMs(ms) {
    const v = Math.min(CROSSFADE_MAX_MS, Math.max(0, Math.round(ms)));
    set({ crossfadeMs: v });
    // Written behind the UI: a slider drag should never wait on disk.
    void api.safe(() => api.prefsSetInt(KEY_CROSSFADE, v), undefined, "prefs write");
  },
}));
