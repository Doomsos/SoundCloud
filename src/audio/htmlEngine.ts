/**
 * Plain-stream playback. Port of `JustAudioEngine` from
 * `lib/core/audio/audio_engine.dart`.
 *
 * Two decks, exactly as the Dart original ran two `AudioPlayer`s: one plays
 * while the other pre-buffers the next track, and `swapToNext` crossfades
 * between them. That gives gapless playback without ever stalling the active
 * deck to load.
 *
 * Crossfading rides `HTMLMediaElement.volume` rather than Web Audio gain
 * nodes. `createMediaElementSource` requires a CORS-clean stream and silently
 * outputs silence when it does not get one, and SoundCloud's media CDN does
 * not reliably grant that for the progressive transcoding - so the safe path
 * is also the one that matches what `setVolume` did before.
 */

import type HlsType from "hls.js";

import { AudioEngine, Emitter, isHls } from "./engine";

/** How often position is republished while playing. */
const TICK_MS = 100;
/** Steps used to shape a crossfade ramp. */
const RAMP_STEP_MS = 25;

type HlsCtor = typeof HlsType;
let hlsModule: HlsCtor | null = null;

/**
 * Most tracks play from the progressive transcoding, which needs no library
 * at all, so hls.js is fetched only when an HLS candidate is actually reached.
 */
async function loadHls(): Promise<HlsCtor> {
  if (!hlsModule) {
    const mod = await import("hls.js");
    hlsModule = (mod.default ?? mod) as HlsCtor;
  }
  return hlsModule;
}

class Deck {
  readonly el: HTMLAudioElement;
  private hls: HlsType | null = null;

  constructor(label: string) {
    const el = new Audio();
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    // Nothing renders these; they exist only to decode.
    el.dataset.deck = label;
    this.el = el;
  }

  async load(url: string): Promise<void> {
    this.detachHls();

    if (isHls(url) && !this.el.canPlayType("application/vnd.apple.mpegurl")) {
      // Chromium has no native HLS, and the fMP4/AAC candidates are HLS.
      const Hls = await loadHls();
      if (!Hls.isSupported()) throw new Error("HLS is not supported here");
      const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      this.hls = hls;
      await new Promise<void>((resolve, reject) => {
        hls.on(Hls.Events.MANIFEST_PARSED, () => resolve());
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) reject(new Error(`hls: ${data.type}/${data.details}`));
        });
        hls.loadSource(url);
        hls.attachMedia(this.el);
      });
      return;
    }

    this.el.src = url;
    await new Promise<void>((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const bad = () => {
        cleanup();
        reject(new Error(`could not load ${url.slice(0, 80)}`));
      };
      const cleanup = () => {
        this.el.removeEventListener("loadedmetadata", ok);
        this.el.removeEventListener("error", bad);
      };
      this.el.addEventListener("loadedmetadata", ok, { once: true });
      this.el.addEventListener("error", bad, { once: true });
      this.el.load();
    });
  }

  private detachHls(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  }

  reset(): void {
    this.detachHls();
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
  }

  destroy(): void {
    this.reset();
  }

  get bufferedMs(): number {
    try {
      const b = this.el.buffered;
      return b.length ? b.end(b.length - 1) * 1000 : 0;
    } catch {
      return 0;
    }
  }
}

export class HtmlAudioEngine implements AudioEngine {
  private readonly a = new Deck("a");
  private readonly b = new Deck("b");
  private active: Deck;

  private readonly position = new Emitter<number>();
  private readonly buffered = new Emitter<number>();
  private readonly playing = new Emitter<boolean>();
  private readonly completed = new Emitter<void>();

  private userVolume = 1;
  private preloadReady = false;
  /** Invalidates an in-flight crossfade when another swap starts. */
  private swapGen = 0;
  private ticker: number | null = null;
  private unbind: (() => void) | null = null;
  private disposed = false;

  constructor() {
    this.active = this.a;
    this.bindActive();
  }

  private get inactive(): Deck {
    return this.active === this.a ? this.b : this.a;
  }

  onPosition = (cb: (ms: number) => void) => this.position.listen(cb);
  onBuffered = (cb: (ms: number) => void) => this.buffered.listen(cb);
  onPlaying = (cb: (p: boolean) => void) => this.playing.listen(cb);
  onCompleted = (cb: () => void) => this.completed.listen(cb);

  get hasPreload(): boolean {
    return this.preloadReady;
  }

  /** Re-points the event wiring at whichever deck is now live. */
  private bindActive(): void {
    this.unbind?.();
    const el = this.active.el;

    const onTime = () => this.publishPosition();
    const onProgress = () => this.buffered.emit(this.active.bufferedMs);
    const onPlay = () => {
      this.playing.emit(true);
      this.startTicker();
    };
    const onPause = () => {
      this.playing.emit(false);
      this.stopTicker();
    };
    const onEnded = () => {
      this.playing.emit(false);
      this.stopTicker();
      this.completed.emit();
    };

    el.addEventListener("timeupdate", onTime);
    el.addEventListener("progress", onProgress);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);

    this.unbind = () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }

  private publishPosition(): void {
    this.position.emit(this.active.el.currentTime * 1000);
    this.buffered.emit(this.active.bufferedMs);
  }

  /**
   * `timeupdate` alone fires about four times a second, which makes the
   * scrubber visibly step. This fills the gaps while audio is actually
   * playing, and stops the moment it is not.
   */
  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = window.setInterval(() => this.publishPosition(), TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    window.clearInterval(this.ticker);
    this.ticker = null;
  }

  async load(url: string): Promise<void> {
    this.swapGen++;
    this.preloadReady = false;
    this.inactive.reset();

    await this.active.load(url);
    this.active.el.volume = this.userVolume;
    await this.play(this.active);
  }

  private async play(deck: Deck): Promise<void> {
    try {
      await deck.el.play();
    } catch (e) {
      // Autoplay rejection and abort-on-reload both land here; neither is
      // fatal, and the play/pause events already reflect the real state.
      if ((e as DOMException)?.name !== "AbortError") {
        console.warn("play rejected", e);
      }
    }
  }

  async pause(): Promise<void> {
    this.active.el.pause();
  }

  async resume(): Promise<void> {
    await this.play(this.active);
  }

  async seek(ms: number): Promise<void> {
    try {
      this.active.el.currentTime = ms / 1000;
      this.publishPosition();
    } catch {
      /* seeking before metadata lands is a no-op, not an error */
    }
  }

  async setVolume(volume: number): Promise<void> {
    this.userVolume = Math.min(1, Math.max(0, volume));
    this.active.el.volume = this.userVolume;
  }

  async stop(): Promise<void> {
    this.swapGen++;
    this.stopTicker();
    this.active.reset();
    this.inactive.reset();
    this.preloadReady = false;
    this.playing.emit(false);
  }

  async preloadNext(url: string | null): Promise<void> {
    this.preloadReady = false;
    if (!url) {
      this.inactive.reset();
      return;
    }
    try {
      await this.inactive.load(url);
      this.inactive.el.volume = 0;
      this.preloadReady = true;
    } catch (e) {
      console.warn("preload failed", e);
      this.inactive.reset();
    }
  }

  /**
   * Hands over to the preloaded deck. With `crossfadeMs > 0` the two decks
   * overlap and ramp; with 0 it is a straight cut, which is what gapless
   * playback of a continuous mix wants.
   */
  async swapToNext(crossfadeMs = 0): Promise<void> {
    if (!this.preloadReady) return;
    const gen = ++this.swapGen;

    const from = this.active;
    const to = this.inactive;

    this.active = to;
    this.bindActive();
    this.preloadReady = false;

    to.el.volume = crossfadeMs > 0 ? 0 : this.userVolume;
    await this.play(to);

    if (crossfadeMs > 0) {
      await this.ramp(from, to, crossfadeMs, gen);
      // A newer swap started mid-ramp; it now owns both decks.
      if (gen !== this.swapGen) return;
    }

    from.reset();
    to.el.volume = this.userVolume;
  }

  private ramp(from: Deck, to: Deck, ms: number, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const steps = Math.max(1, Math.round(ms / RAMP_STEP_MS));
      let step = 0;
      const target = this.userVolume;

      const id = window.setInterval(() => {
        if (gen !== this.swapGen || this.disposed) {
          window.clearInterval(id);
          resolve();
          return;
        }
        step++;
        const t = Math.min(1, step / steps);
        to.el.volume = Math.min(1, Math.max(0, target * t));
        from.el.volume = Math.min(1, Math.max(0, target * (1 - t)));
        if (t >= 1) {
          window.clearInterval(id);
          resolve();
        }
      }, RAMP_STEP_MS);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopTicker();
    this.unbind?.();
    this.a.destroy();
    this.b.destroy();
    this.position.clear();
    this.buffered.clear();
    this.playing.clear();
    this.completed.clear();
  }
}
