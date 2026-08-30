/**
 * Liked and reposted track ids. Port of `liked_tracks.dart` and
 * `reposted_tracks.dart`.
 *
 * Both keep the whole id set in memory so a heart or repost icon anywhere in
 * the app can be rendered without a per-row request, and both write
 * optimistically: the icon flips immediately and rolls back only if
 * SoundCloud refuses.
 */

import { create } from "zustand";

import * as api from "@/api/client";
import type { LikeOutcome } from "@/models";

/** Likes are paged; this bounds a very large library. 40 x 50 = 2000 tracks. */
const MAX_PAGES = 40;
const PAGE_SIZE = 50;

interface LikesState {
  ids: Set<string>;
  loading: boolean;
  has(id: string): boolean;
  load(): Promise<void>;
  toggle(trackId: string): Promise<LikeOutcome>;
  reset(): void;
}

let likesToken = 0;

export const useLikesStore = create<LikesState>((set, get) => ({
  ids: new Set(),
  loading: false,

  has: (id) => get().ids.has(id),

  async load() {
    const token = ++likesToken;
    set({ loading: true });
    const acc = new Set<string>();
    let cursor: string | undefined;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await api.likesPage(cursor, PAGE_SIZE);
        // A newer load started (sign-in/out); this one's results are stale.
        if (token !== likesToken) return;
        if (res.tracks.length === 0) break;
        for (const t of res.tracks) acc.add(t.id);
        // Published per page so hearts fill in as the library streams in.
        set({ ids: new Set(acc) });
        cursor = res.nextHref;
        if (!cursor) break;
      }
    } finally {
      if (token === likesToken) set({ loading: false });
    }
  },

  async toggle(trackId) {
    const like = !get().ids.has(trackId);
    const optimistic = new Set(get().ids);
    if (like) optimistic.add(trackId);
    else optimistic.delete(trackId);
    set({ ids: optimistic });

    const outcome = await api.setLiked(trackId, like);
    if (outcome !== "ok") {
      const rolledBack = new Set(get().ids);
      if (like) rolledBack.delete(trackId);
      else rolledBack.add(trackId);
      set({ ids: rolledBack });
    }
    return outcome;
  },

  reset() {
    likesToken++;
    set({ ids: new Set(), loading: false });
  },
}));

interface RepostsState {
  ids: Set<string>;
  has(id: string): boolean;
  load(): Promise<void>;
  toggle(trackId: string): Promise<LikeOutcome>;
  reset(): void;
}

export const useRepostsStore = create<RepostsState>((set, get) => ({
  ids: new Set(),

  has: (id) => get().ids.has(id),

  async load() {
    const ids = await api.safe(() => api.repostedTrackIds(), [], "reposts");
    set({ ids: new Set(ids) });
  },

  async toggle(trackId) {
    const repost = !get().ids.has(trackId);
    const optimistic = new Set(get().ids);
    if (repost) optimistic.add(trackId);
    else optimistic.delete(trackId);
    set({ ids: optimistic });

    const outcome = await api.setReposted(trackId, repost);
    if (outcome !== "ok") {
      const rolledBack = new Set(get().ids);
      if (repost) rolledBack.delete(trackId);
      else rolledBack.add(trackId);
      set({ ids: rolledBack });
    }
    return outcome;
  },

  reset() {
    set({ ids: new Set() });
  },
}));
