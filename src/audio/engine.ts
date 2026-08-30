/**
 * The playback contract. Port of `abstract interface class AudioEngine` in
 * `lib/core/audio/audio_engine.dart`.
 *
 * Dart exposed four broadcast streams; here they are subscriptions that hand
 * back an unsubscribe function, which is the same thing with the lifetime made
 * explicit. Positions stay in **milliseconds** across this boundary, matching
 * the Dart `Duration` contract, even though the media elements underneath
 * work in seconds.
 */

export interface AudioEngine {
  onPosition(cb: (ms: number) => void): () => void;
  onBuffered(cb: (ms: number) => void): () => void;
  onPlaying(cb: (playing: boolean) => void): () => void;
  onCompleted(cb: () => void): () => void;

  load(url: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  stop(): Promise<void>;

  /** `null` clears any pending preload. */
  preloadNext(url: string | null): Promise<void>;
  swapToNext(crossfadeMs?: number): Promise<void>;
  readonly hasPreload: boolean;

  dispose(): void;
}

/** Minimal typed event source; one per stream on the engines. */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  listen(cb: (value: T) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(value: T): void {
    // Copied before iterating: a listener may unsubscribe itself in response,
    // which would otherwise mutate the set mid-loop.
    for (const cb of [...this.listeners]) {
      try {
        cb(value);
      } catch (e) {
        console.error("audio listener threw", e);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const isHls = (url: string): boolean => url.includes(".m3u8");

/** Tauri serves cached files over the asset protocol, not `file:`. */
export const isLocal = (url: string): boolean =>
  url.startsWith("asset:") || url.startsWith("http://asset.localhost");
