/**
 * Playback state. Port of `PlayerController` from
 * `lib/features/player/player_controller.dart`.
 *
 * Zustand replaces Riverpod's `Notifier`. The queue sequencing that Dart kept
 * in private fields lives in `QueueModel` (see `state/queue.ts`) - separated
 * so it can be tested without an audio device - and the remaining bookkeeping
 * sits in `room`, deliberately outside the store because mutating it must not
 * re-render anything on its own.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";

import * as api from "@/api/client";
import { DrmAudioEngine } from "@/audio/drmEngine";
import { AudioEngine } from "@/audio/engine";
import { HtmlAudioEngine } from "@/audio/htmlEngine";
import type { LikeOutcome, Track, Unplayable } from "@/models";
import { useLikesStore } from "./likesStore";
import { usePrefsStore } from "./prefsStore";
import { QueueModel, isGenuineCompletion, shouldStartCrossfade } from "./queue";

/** Consecutive dead tracks before the player stops auto-skipping. */
const MAX_DEAD_SKIPS = 3;
/** Below this, `previous()` restarts the track instead of stepping back. */
const RESTART_BEFORE_SECS = 3;
/** Where the last-played track is remembered, as `{"id","positionMs"}`. */
const KEY_LAST_PLAYED = "player_last_played";
/** Position is written no more often than this; ticks arrive every 100 ms. */
const REMEMBER_EVERY_MS = 5000;

export interface PlayerState {
  track: Track | null;
  isPlaying: boolean;
  /** Milliseconds. */
  position: number;
  buffered: number;
  shuffle: boolean;
  repeat: boolean;
  liked: boolean;
  volume: number;
  muted: boolean;
  unplayable: Unplayable | null;
  /** Bumped whenever the queue changes, so views re-read `upcoming()`. */
  queueVersion: number;
}

export const progressOf = (s: PlayerState): number => {
  const total = s.track?.durationMs ?? 0;
  return total === 0 ? 0 : Math.min(1, Math.max(0, s.position / total));
};

export const bufferedFractionOf = (s: PlayerState): number => {
  const total = s.track?.durationMs ?? 0;
  return total === 0 ? 0 : Math.min(1, Math.max(0, s.buffered / total));
};

interface PlayerActions {
  play(track: Track, queue?: Track[]): void;
  restoreLast(): Promise<void>;
  toggle(): void;
  next(): void;
  previous(): void;
  seekFraction(fraction: number): void;
  seekBy(deltaMs: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  setShuffle(on: boolean): void;
  toggleRepeat(): void;
  toggleLike(): Promise<LikeOutcome>;
  addToQueue(t: Track): void;
  playNext(t: Track): void;
  removeFromQueue(trackId: string): void;
  reorderUpcoming(oldIndex: number, newIndex: number): void;
  upcoming(): Track[];
  currentQueueIndex(): number;
  dispose(): void;
}

/** The non-reactive half of the controller: Dart's private fields. */
const room = {
  q: new QueueModel(),
  swapping: false,
  loadToken: 0,
  preloadToken: 0,
  unplayableSeq: 0,
  startedAt: null as number | null,
  /** Furthest position reached, used to tell a real ending from a stall. */
  maxPosMs: 0,
  deadStreak: 0,
  /** Whose audio an engine actually holds. A restored track has none yet. */
  loadedId: null as string | null,
  /** Where the next load starts, so a restored track picks up where it left. */
  resumeAtMs: 0,
  /** When the last-played note was written; see `remember`. */
  rememberedAt: 0,
  engines: null as { html: HtmlAudioEngine; drm: DrmAudioEngine } | null,
  unsubs: [] as Array<() => void>,
};

function engines() {
  if (!room.engines) {
    room.engines = {
      html: new HtmlAudioEngine(),
      drm: new DrmAudioEngine(() => api.invokeAnonClientId()),
    };
    bindEngine(room.engines.html);
    bindEngine(room.engines.drm);
  }
  return room.engines;
}

/**
 * DRM tracks play through Shaka against the PlayReady CDM; everything else
 * goes through the plain dual-deck engine. Both satisfy `AudioEngine`, so
 * nothing below cares which is live.
 */
const engineFor = (track: Track | null | undefined): AudioEngine =>
  track?.lock === "drm" ? engines().drm : engines().html;

/** Silences whichever engine is *not* about to play, so switching between a
 *  normal and a DRM track cannot leave two sources running. */
async function stopOtherEngine(track: Track): Promise<void> {
  const keep = engineFor(track);
  for (const e of [engines().html, engines().drm] as AudioEngine[]) {
    if (e === keep) continue;
    try {
      await e.stop();
    } catch {
      /* stopping an idle engine is not an error */
    }
  }
}

export const usePlayerStore = create<PlayerState & PlayerActions>((set, get) => ({
  track: null,
  isPlaying: false,
  position: 0,
  buffered: 0,
  shuffle: false,
  repeat: false,
  liked: false,
  volume: 1,
  muted: false,
  unplayable: null,
  queueVersion: 0,

  play(track, queue) {
    room.q.start(track, queue);
    activate(track);
  },

  /**
   * Opens on whatever was playing when the app last closed - paused, at the
   * position it stopped - so the player is not empty on launch. Falls back to
   * the play history SoundCloud itself keeps, which is what the website shows
   * in the same spot, when this install has nothing of its own yet.
   *
   * No audio is loaded: that would spend a stream resolve on a track the user
   * may never press play on. `toggle` loads it on the first press instead.
   */
  async restoreLast() {
    if (get().track) return;

    const stored = parseLastPlayed(
      await api.safe(() => api.prefsGetString(KEY_LAST_PLAYED), null, "last played"),
    );

    let track: Track | null = null;
    let position = 0;
    if (stored) {
      const detail = await api.safe(() => api.trackDetail(stored.id), null, "last played");
      track = detail?.track ?? null;
      position = clampPosition(stored.positionMs, track?.durationMs ?? 0);
    } else {
      const [recent] = await api.safe(() => api.historyPage(1, 0), [], "last played");
      track = recent ?? null;
    }

    // Fetching took a moment. If the user pressed play meanwhile, they win.
    if (!track || get().track) return;

    room.q.start(track);
    room.loadedId = null;
    room.resumeAtMs = position;
    room.maxPosMs = 0;
    set({
      track,
      isPlaying: false,
      position,
      buffered: 0,
      liked: useLikesStore.getState().has(track.id),
      queueVersion: get().queueVersion + 1,
    });
  },

  toggle() {
    const s = get();
    if (!s.track) return;

    // Restored from the last session: it is on screen but no engine holds it
    // yet, so the first press has to load rather than resume. Gated on being
    // stopped, so a pause landing mid-load does not start a second one.
    if (!s.isPlaying && room.loadedId !== s.track.id) {
      room.resumeAtMs = s.position;
      set({ isPlaying: true });
      void load(s.track);
      return;
    }

    const engine = engineFor(s.track);
    if (s.isPlaying) {
      void engine.pause();
      set({ isPlaying: false });
      // Paused is where the user meant to stop, so record it exactly.
      remember(s.track.id, s.position, true);
    } else {
      void engine.resume();
      set({ isPlaying: true });
    }
  },

  next() {
    const track = room.q.upNext();
    if (!track) return;
    room.q.stepForward(track);
    activate(track);
  },

  previous() {
    const s = get();
    // Past the grace window, "previous" means "start this one again" - the
    // same rule every other player uses.
    if (s.position > RESTART_BEFORE_SECS * 1000) {
      void engineFor(s.track).seek(0);
      set({ position: 0 });
      return;
    }
    const prev = room.q.stepBack();
    if (prev) activate(prev);
  },

  seekFraction(fraction) {
    const total = get().track?.durationMs ?? 0;
    if (total === 0) return;
    const pos = Math.round(Math.min(1, Math.max(0, fraction)) * total);
    void engineFor(get().track).seek(pos);
    set({ position: pos });
  },

  seekBy(deltaMs) {
    const s = get();
    const total = s.track?.durationMs ?? 0;
    if (total === 0) return;
    const pos = Math.min(total, Math.max(0, s.position + deltaMs));
    void engineFor(s.track).seek(pos);
    set({ position: pos });
  },

  setVolume(volume) {
    const v = Math.min(1, Math.max(0, volume));
    set({ volume: v, muted: false });
    // Linear, because `HTMLMediaElement.volume` is already a linear amplitude
    // and that is what a browser's own controls feed it. A perceptual curve
    // here felt better in isolation but made the same slider position far
    // quieter than the web player - cubic is -18 dB at half, against -6.
    void engineFor(get().track).setVolume(v);
  },

  toggleMute() {
    const s = get();
    if (s.muted) {
      set({ muted: false });
      void engineFor(s.track).setVolume(s.volume);
    } else {
      set({ muted: true });
      void engineFor(s.track).setVolume(0);
    }
  },

  toggleShuffle() {
    get().setShuffle(!get().shuffle);
  },

  setShuffle(on) {
    if (get().shuffle === on) return;
    set({ shuffle: on });
    room.q.setShuffle(on);
    const t = get().track;
    if (t) void preloadAfter(t);
  },

  toggleRepeat() {
    set({ repeat: !get().repeat });
  },

  async toggleLike() {
    const track = get().track;
    if (!track) return "failed";
    set({ liked: !get().liked });
    return useLikesStore.getState().toggle(track.id);
  },

  addToQueue(t) {
    if (room.q.add(t)) bumpQueue();
  },

  playNext(t) {
    room.q.playNext(t, get().track?.id);
    bumpQueue();
  },

  removeFromQueue(trackId) {
    if (room.q.remove(trackId, get().track?.id)) bumpQueue();
  },

  reorderUpcoming(oldIndex, newIndex) {
    if (room.q.reorderUpcoming(oldIndex, newIndex, get().track?.id)) bumpQueue();
  },

  upcoming() {
    return room.q.upcoming(get().track?.id);
  },

  currentQueueIndex() {
    return room.q.currentQueueIndex(get().track?.id);
  },

  dispose() {
    for (const u of room.unsubs) u();
    room.unsubs = [];
    room.engines?.html.dispose();
    room.engines?.drm.dispose();
    room.engines = null;
  },
}));

// ---------------------------------------------------------------- internals

const setState = usePlayerStore.setState;
const getState = usePlayerStore.getState;

const bumpQueue = () => setState({ queueVersion: getState().queueVersion + 1 });

interface LastPlayed {
  id: string;
  positionMs: number;
}

/** Tolerant on purpose: a note written by an older build, or half-written,
 *  should open an empty player rather than break the launch. */
function parseLastPlayed(raw: string | null): LastPlayed | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastPlayed>;
    if (typeof v?.id !== "string" || v.id === "") return null;
    const ms = typeof v.positionMs === "number" && Number.isFinite(v.positionMs) ? v.positionMs : 0;
    return { id: v.id, positionMs: Math.max(0, Math.round(ms)) };
  } catch {
    return null;
  }
}

/** A position at or near the end starts the track over instead of opening on
 *  its last second - the same grace window `previous()` uses. */
function clampPosition(saved: number, durationMs: number): number {
  if (!Number.isFinite(saved) || saved <= 0) return 0;
  if (durationMs > 0 && saved > durationMs - RESTART_BEFORE_SECS * 1000) return 0;
  return Math.round(saved);
}

/**
 * Records what is playing so the next launch opens on it. Writes go behind
 * the UI and are rate limited, because position arrives ten times a second;
 * `force` is for the moments that must be exact - a pause, or a new track.
 */
function remember(trackId: string, positionMs: number, force = false): void {
  const now = Date.now();
  if (!force && now - room.rememberedAt < REMEMBER_EVERY_MS) return;
  room.rememberedAt = now;

  const note: LastPlayed = { id: trackId, positionMs: Math.max(0, Math.round(positionMs)) };
  void api.safe(
    () => api.prefsSetString(KEY_LAST_PLAYED, JSON.stringify(note)),
    undefined,
    "remember last played",
  );
}

/** The tail every successful load shares. */
function afterLoad(track: Track, engine: AudioEngine): void {
  room.loadedId = track.id;
  room.startedAt = Date.now();
  room.deadStreak = 0;
  if (room.resumeAtMs > 0) {
    void engine.seek(room.resumeAtMs);
    setState({ position: room.resumeAtMs });
  }
  room.resumeAtMs = 0;
  void preloadAfter(track);
}

function activate(track: Track): void {
  room.maxPosMs = 0;
  // A deliberate pick starts at the top, whatever was restored before it.
  room.resumeAtMs = 0;
  room.loadedId = null;
  remember(track.id, 0, true);
  setState({
    track,
    isPlaying: true,
    position: 0,
    buffered: 0,
    liked: useLikesStore.getState().has(track.id),
    queueVersion: getState().queueVersion + 1,
  });
  void load(track);
}

async function load(track: Track): Promise<void> {
  const token = ++room.loadToken;
  await stopOtherEngine(track);

  // DRM tracks skip resolveStreamUrl: Shaka wants the manifest URL itself,
  // and fetches it - plus the licence - from inside the player.
  const drm = track.lock === "drm";
  const candidates = drm ? track.drmCandidates : track.streamCandidates;
  if (candidates.length === 0) {
    if (track.lock !== "none") {
      void api.logWrite("WARN", "player", lockReason(track));
      markUnplayable(token, track);
    }
    return;
  }

  const engine = engineFor(track);

  // Already on disk: skip resolveStreamUrl entirely and play from the cache.
  // That is the difference between two network round trips and starting at
  // once - and for an encrypted track it also skips pulling every segment
  // down again, leaving only the licence call, which no cache can remove.
  const cached = drm
    ? await api.safe(() => api.cacheHitDrm(track.id), null, "drm cache lookup")
    : await api.safe(() => api.cacheHit(track.id), null, "cache lookup");
  if (token !== room.loadToken) return;
  if (cached) {
    try {
      void api.logWrite("INFO", "player", `[cache] hit -> ${track.title}`);
      if (typeof cached === "string") await engine.load(convertFileSrc(cached));
      else await engines().drm.loadCached(cached);
      if (token !== room.loadToken) return;
      afterLoad(track, engine);
      return;
    } catch (e) {
      // Dropping the entry keeps this cost to the one play that found the
      // problem, instead of failing over to the network on every later one.
      void api.cacheForget(track.id);
      void api.logWrite(
        "WARN",
        "player",
        `cached copy failed, restreaming ${track.title}: ${String(e)}`,
      );
    }
  }

  for (const candidate of candidates) {
    try {
      // Same call for both: resolving a transcoding returns a media URL for
      // plain streams and the encrypted-HLS manifest for DRM ones.
      const url = await api.resolveStreamUrl(candidate);
      if (token !== room.loadToken) return;
      if (!url) continue;

      await engine.load(url);
      if (token !== room.loadToken) return;
      // The cache fills behind playback, so the next play starts local. For
      // an encrypted track that stores the ciphertext only - the licence is
      // fetched afresh every time it plays.
      if (drm) void api.cacheStoreDrm(track.id, url);
      else void api.cacheStore(track.id, url);

      afterLoad(track, engine);
      void api.cacheTrim();
      return;
    } catch (e) {
      void api.logWrite(
        "WARN",
        "player",
        `stream candidate failed for ${track.title}: ${String(e)}`,
      );
      if (token !== room.loadToken) return;
    }
  }

  void api.logWrite("WARN", "player", lockReason(track));
  markUnplayable(token, track);
}

function lockReason(track: Track): string {
  switch (track.lock) {
    case "goPlus":
      return `GO+ only (subscription): ${track.title}`;
    case "drm":
      return `DRM track could not be decoded: ${track.title}`;
    default:
      return `no playable stream: ${track.title}`;
  }
}

function markUnplayable(token: number, track: Track): void {
  if (token !== room.loadToken || getState().track?.id !== track.id) return;
  setState({
    isPlaying: false,
    unplayable: { seq: ++room.unplayableSeq, title: track.title, lock: track.lock },
  });
  // Skip past a dead track, but stop after a few in a row rather than racing
  // through the whole queue.
  if (room.q.queue.length > 1 && ++room.deadStreak < MAX_DEAD_SKIPS) {
    getState().next();
  }
}

async function preloadAfter(current: Track): Promise<void> {
  const token = ++room.preloadToken;
  const engine = engineFor(current);
  const n = room.q.upNext();

  // DRM plays through a single CDM session - there is nothing to preload
  // into, so the head start it gets is a warm cache rather than a full deck.
  if (!n || n.streamCandidates.length === 0 || n.lock !== "none") {
    await engine.preloadNext(null);
    if (n?.lock === "drm" && token === room.preloadToken) void warmDrmCache(n);
    return;
  }

  try {
    // A cached next track needs no resolve either: hand the file straight to
    // the idle deck so the swap is instant.
    const cached = await api.safe(() => api.cacheHit(n.id), null, "cache lookup");
    if (token !== room.preloadToken) return;
    if (cached) {
      await engine.preloadNext(convertFileSrc(cached));
      return;
    }
    const url = await api.resolveStreamUrl(n.streamCandidates[0]);
    if (token !== room.preloadToken) return;
    await engine.preloadNext(url ?? null);
  } catch {
    if (token === room.preloadToken) await engine.preloadNext(null);
  }
}

/**
 * Gets the next encrypted track onto disk while the current one plays.
 *
 * With no second decoder to fill, this is the whole of what a DRM track can
 * be given in advance: its segments cached and Shaka already built. What is
 * left when it starts is the licence round trip.
 */
async function warmDrmCache(track: Track): Promise<void> {
  if (track.drmCandidates.length === 0) return;
  void engines().drm.prepare();

  const cached = await api.safe(() => api.cacheHitDrm(track.id), null, "drm cache lookup");
  if (cached) return;
  const url = await api.safe(
    () => api.resolveStreamUrl(track.drmCandidates[0]),
    null,
    "drm resolve",
  );
  if (url) void api.cacheStoreDrm(track.id, url);
}

async function advanceViaSwap(): Promise<void> {
  const n = room.q.upNext();
  if (!n) return;

  room.swapping = true;
  const crossfade = usePrefsStore.getState().crossfadeMs;
  room.loadToken++;
  room.q.stepForward(n);
  room.maxPosMs = 0;
  room.resumeAtMs = 0;
  // The idle deck already holds it; the swap does not go through `load`.
  room.loadedId = n.id;

  setState({
    track: n,
    position: 0,
    buffered: 0,
    isPlaying: true,
    liked: useLikesStore.getState().has(n.id),
    queueVersion: getState().queueVersion + 1,
  });
  room.startedAt = Date.now();
  room.deadStreak = 0;
  remember(n.id, 0, true);

  await engineFor(n).swapToNext(crossfade);
  void preloadAfter(n);
  room.swapping = false;
}

/** Wires one engine's streams into the store. Runs once per engine. */
function bindEngine(engine: AudioEngine): void {
  room.unsubs.push(
    engine.onPosition((ms) => {
      const s = getState();
      if (!s.track) return;
      const dur = s.track.durationMs;
      // Some streams over-report near the end; ignore anything past the
      // known duration rather than letting the scrubber overshoot.
      if (dur > 0 && ms > dur + 2000) return;
      if (ms > room.maxPosMs) room.maxPosMs = ms;
      setState({ position: ms });
      remember(s.track.id, ms);

      if (
        shouldStartCrossfade({
          positionMs: ms,
          durationMs: dur,
          crossfadeMs: usePrefsStore.getState().crossfadeMs,
          isPlaying: s.isPlaying,
          repeat: s.repeat,
          hasPreload: engineFor(s.track).hasPreload,
          swapping: room.swapping,
        })
      ) {
        void advanceViaSwap();
      }
    }),
  );

  room.unsubs.push(
    engine.onBuffered((ms) => {
      if (getState().track) setState({ buffered: ms });
    }),
  );

  room.unsubs.push(
    engine.onPlaying((playing) => {
      const s = getState();
      if (s.track && s.isPlaying !== playing) setState({ isPlaying: playing });
    }),
  );

  room.unsubs.push(
    engine.onCompleted(() => {
      if (room.swapping) return;
      const s = getState();

      const genuine = isGenuineCompletion({
        secondsSinceStart:
          room.startedAt === null ? 0 : (Date.now() - room.startedAt) / 1000,
        maxPositionMs: room.maxPosMs,
        durationMs: s.track?.durationMs ?? 0,
      });
      if (!genuine) return;

      const engineNow = engineFor(s.track);
      if (s.repeat) {
        void engineNow.seek(0);
        void engineNow.resume();
      } else if (engineNow.hasPreload) {
        void advanceViaSwap();
      } else {
        getState().next();
      }
    }),
  );
}

/** Exposed for tests: the two places a stored note can be malformed. */
export const __test = { parseLastPlayed, clampPosition };

/** Exposed for the queue panel, which needs the raw list. */
export const queueSnapshot = (): Track[] => [...room.q.queue];
