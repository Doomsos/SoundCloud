/**
 * OS media integration. Replaces the `audio_service` handler of the Dart build.
 *
 * `navigator.mediaSession` is what puts the track in Windows' SMTC flyout and
 * on the macOS Now Playing card, and it is what makes the hardware media keys
 * reach the app. It needs no extra process, unlike the Dart build's
 * background audio service.
 */

import type { Track } from "@/models";

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(ms: number): void;
  seekBy(deltaMs: number): void;
}

const supported = (): boolean =>
  typeof navigator !== "undefined" && "mediaSession" in navigator;

export function installMediaSession(h: MediaSessionHandlers): void {
  if (!supported()) return;
  const ms = navigator.mediaSession;

  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Chromium rejects handlers it does not implement; the rest still work.
    }
  };

  set("play", () => h.play());
  set("pause", () => h.pause());
  set("nexttrack", () => h.next());
  set("previoustrack", () => h.previous());
  set("seekto", (details) => {
    if (typeof details.seekTime === "number") h.seekTo(details.seekTime * 1000);
  });
  set("seekforward", (details) => h.seekBy((details.seekOffset ?? 5) * 1000));
  set("seekbackward", (details) => h.seekBy(-(details.seekOffset ?? 5) * 1000));
  set("stop", () => h.pause());
}

/** Mirrors the current track into the OS. Call on every track change. */
export function updateMetadata(track: Track | null): void {
  if (!supported()) return;
  const ms = navigator.mediaSession;

  if (!track) {
    ms.metadata = null;
    ms.playbackState = "none";
    return;
  }

  ms.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.genre,
    // A single large artwork entry is enough; the OS rescales it.
    artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: "500x500", type: "image/jpeg" }] : [],
  });
}

export function updatePlaybackState(isPlaying: boolean): void {
  if (!supported()) return;
  navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
}

/**
 * Feeds the scrubber in the OS overlay. Guarded because Chromium throws if
 * position exceeds duration, which a slightly over-reporting stream will do.
 */
export function updatePosition(positionMs: number, durationMs: number, playing: boolean): void {
  if (!supported() || durationMs <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: durationMs / 1000,
      position: Math.min(positionMs, durationMs) / 1000,
      playbackRate: playing ? 1 : 0,
    });
  } catch {
    /* a transient out-of-range position is not worth surfacing */
  }
}
