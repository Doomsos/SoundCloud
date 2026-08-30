/**
 * Link handling: the clipboard watcher, recent searches, and deep links.
 * Ports `core/deeplinks/clipboard_watcher.dart`, `deep_links.dart` and
 * `features/omnibox/recent_queries.dart`.
 */

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { create } from "zustand";

import * as api from "@/api/client";

const KEY_RECENT = "recent_searches";
const KEY_CLIPBOARD_WATCH = "clipboardWatch";
const MAX_RECENT = 10;
const POLL_MS = 1500;

// ---- recent searches -----------------------------------------------------

interface RecentState {
  queries: string[];
  restore(): Promise<void>;
  add(q: string): void;
  clear(): void;
}

export const useRecentQueries = create<RecentState>((set, get) => ({
  queries: [],

  async restore() {
    const raw = await api.safe(() => api.prefsGetString(KEY_RECENT), null, "recents");
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        set({ queries: parsed.filter((x): x is string => typeof x === "string") });
      }
    } catch {
      /* a corrupt entry just means no history */
    }
  },

  add(q) {
    const qt = q.trim();
    if (!qt) return;
    // Re-searching something moves it to the front rather than duplicating.
    const next = [qt, ...get().queries.filter((e) => e !== qt)].slice(0, MAX_RECENT);
    set({ queries: next });
    void api.safe(
      () => api.prefsSetString(KEY_RECENT, JSON.stringify(next)),
      undefined,
      "recents write",
    );
  },

  clear() {
    set({ queries: [] });
    void api.safe(() => api.prefsRemove(KEY_RECENT), undefined, "recents clear");
  },
}));

// ---- clipboard watcher ---------------------------------------------------

/**
 * Whether a clipboard string is a SoundCloud link worth offering to open.
 *
 * Deliberately strict about whitespace: copying a paragraph that happens to
 * mention soundcloud.com should not raise a toast.
 */
export function isSoundcloudUrl(s: string): boolean {
  if (/\s/.test(s)) return false;
  const marker = "soundcloud.com/";
  const i = s.toLowerCase().indexOf(marker);
  if (i < 0) return false;
  // A bare domain with no path points at nothing in particular.
  return s.slice(i + marker.length).length > 0;
}

export interface ClipboardLink {
  seq: number;
  url: string;
}

interface ClipboardState {
  enabled: boolean;
  link: ClipboardLink | null;
  restore(): Promise<void>;
  setEnabled(on: boolean): void;
  /** Suppresses the toast for a URL this app just put on the clipboard. */
  markSeen(url: string): void;
  start(): () => void;
}

let lastSeen: string | null = null;
let seq = 0;

export const useClipboardWatcher = create<ClipboardState>((set, get) => ({
  enabled: true,
  link: null,

  async restore() {
    const v = await api.safe(() => api.prefsGetBool(KEY_CLIPBOARD_WATCH), null, "clipboard");
    if (v !== null) set({ enabled: v });
  },

  setEnabled(on) {
    if (get().enabled === on) return;
    set({ enabled: on });
    void api.safe(
      () => api.prefsSetBool(KEY_CLIPBOARD_WATCH, on),
      undefined,
      "clipboard pref",
    );
  },

  markSeen(url) {
    lastSeen = url.trim();
  },

  start() {
    // Prime `lastSeen` so whatever is already on the clipboard at launch does
    // not immediately fire a toast.
    void readText()
      .then((t) => {
        lastSeen = t?.trim() ?? null;
      })
      .catch(() => {});

    const id = window.setInterval(async () => {
      if (!get().enabled) return;
      let text: string | null = null;
      try {
        text = (await readText())?.trim() ?? null;
      } catch {
        return;
      }
      if (!text || text === lastSeen) return;
      lastSeen = text;
      if (isSoundcloudUrl(text)) {
        set({ link: { seq: ++seq, url: text } });
      }
    }, POLL_MS);

    return () => window.clearInterval(id);
  },
}));

// ---- deep links ----------------------------------------------------------

/**
 * Maps a `soundcloud://` or `https://soundcloud.com/...` URL to an in-app
 * route. Port of `DeepLinkService._routeFor`.
 *
 * The shapes it understands, in order: an embedded `?url=`, a
 * `soundcloud://<kind>/<id>` triple, the whole URL re-pointed at https, and
 * finally any soundcloud.com link resolved through the API.
 */
export async function routeForDeepLink(raw: string): Promise<string | null> {
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    return null;
  }

  if (uri.protocol === "soundcloud:") {
    const embedded = uri.searchParams.get("url");
    if (embedded) return api.resolveUrl(embedded);

    const kind = uri.hostname;
    const seg = uri.pathname.split("/").filter(Boolean)[0] ?? "";
    if (seg) {
      if (kind === "track") return `/track/${seg}`;
      if (kind === "playlist") return `/playlist/${encodeURIComponent(seg)}`;
      if (kind === "artist") return `/artist/${encodeURIComponent(seg)}`;
    }
    return api.resolveUrl(raw.replace(/^soundcloud:\/\//, "https://"));
  }

  if (uri.hostname.includes("soundcloud.com")) return api.resolveUrl(raw);
  return null;
}
