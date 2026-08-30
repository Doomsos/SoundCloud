/**
 * Encrypted-HLS playback. Port of `WebviewDrmEngine` from
 * `lib/core/audio/drm_engine.dart`.
 *
 * SoundCloud serves some tracks only as encrypted HLS. Their manifests carry
 * a PlayReady header alongside the Widevine one, and WebView2 ships a
 * PlayReady CDM, so Shaka Player can decode them - decryption stays inside
 * Microsoft's CDM and we only drive transport.
 *
 * The Flutter build needed ~290 lines to reach this point: EME is only handed
 * out in a secure context and a `file://` page cannot reach the licence
 * server, so it ran a loopback HTTP server to host the player page, opened a
 * *hidden second WebView2 window*, pushed commands in through
 * `evaluateJavaScript`, and read state back by polling `scState()` every
 * 200ms because the plugin's message handler is a no-op on Windows.
 *
 * None of that is needed here. The app's own webview is already a secure
 * context, so Shaka attaches to an ordinary audio element in-process and
 * reports state through normal media events. What survives from the original
 * is the part that was genuinely hard-won: the licence endpoint, the
 * PlayReady key system, and the request filter that signs licence calls with
 * the anonymous `client_id`.
 *
 * A track heard once is not re-fetched either: `AudioCache::store_drm` keeps
 * the encrypted segments on disk and `loadCached` replays them through the
 * same CDM. Nothing is decrypted going in or coming out - the licence round
 * trip is the one part of a DRM load that caching cannot remove.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type shakaNs from "shaka-player/dist/shaka-player.compiled";

import type { CachedDrmStream } from "@/models";
import { AudioEngine, Emitter } from "./engine";

const LICENSE_SERVER = "https://license.media-streaming.soundcloud.cloud/playback/playready";
/** The one CDM WebView2 ships. The `cbc-` variants are FairPlay/Widevine. */
const KEY_SYSTEM = "com.microsoft.playready";
/** A cached manifest is loaded as a blob, which has no extension to sniff. */
const HLS_MIME = "application/x-mpegurl";
/** The placeholder `AudioCache::hit_drm` leaves where each media URI was. */
const LOCAL_URI = /wf-local:(\d+)/g;

const TICK_MS = 100;

type Shaka = typeof shakaNs;

let shakaModule: Shaka | null = null;
let polyfilled = false;

/**
 * Shaka is ~660 KB and only DRM tracks need it, so it is fetched on first use
 * rather than shipped in the main chunk. Cached after the first load.
 */
async function loadShaka(): Promise<Shaka> {
  if (!shakaModule) {
    const mod = await import("shaka-player/dist/shaka-player.compiled");
    shakaModule = (mod.default ?? mod) as Shaka;
  }
  return shakaModule;
}

/**
 * Turns a cached manifest into one Shaka can load: every `wf-local:<n>`
 * becomes the asset-protocol URL of the segment it stands for.
 *
 * Kept out of the engine, and handed its resolver, so the substitution can be
 * tested without a webview. `toUrl` is `convertFileSrc` in the app.
 */
export function localiseManifest(
  entry: CachedDrmStream,
  toUrl: (path: string) => string,
): string {
  return entry.manifest.replace(LOCAL_URI, (_match, index: string) => {
    const path = entry.files[Number(index)];
    if (!path) {
      throw new Error(`cached manifest wants segment ${index}, which is not in the entry`);
    }
    return toUrl(path);
  });
}

export class DrmAudioEngine implements AudioEngine {
  private readonly el: HTMLAudioElement;
  private player: shakaNs.Player | null = null;

  private readonly position = new Emitter<number>();
  private readonly buffered = new Emitter<number>();
  private readonly playing = new Emitter<boolean>();
  private readonly completed = new Emitter<void>();

  private userVolume = 1;
  private ticker: number | null = null;
  private disposed = false;
  private booting: Promise<void> | null = null;

  /** Supplies the anonymous client_id the licence request must carry. */
  constructor(private readonly clientId: () => Promise<string>) {
    const el = new Audio();
    el.preload = "auto";
    this.el = el;
    this.bind();
  }

  onPosition = (cb: (ms: number) => void) => this.position.listen(cb);
  onBuffered = (cb: (ms: number) => void) => this.buffered.listen(cb);
  onPlaying = (cb: (p: boolean) => void) => this.playing.listen(cb);
  onCompleted = (cb: () => void) => this.completed.listen(cb);

  /**
   * Always false. One CDM session means one decoder, so there is nothing to
   * preload into; the head start for the next track is its segments reaching
   * disk instead. The player controller reads this to fall back to a hard cut.
   */
  get hasPreload(): boolean {
    return false;
  }

  private bind(): void {
    const publish = () => {
      this.position.emit(this.el.currentTime * 1000);
      try {
        const b = this.el.buffered;
        this.buffered.emit(b.length ? b.end(b.length - 1) * 1000 : 0);
      } catch {
        this.buffered.emit(0);
      }
    };

    this.el.addEventListener("timeupdate", publish);
    this.el.addEventListener("progress", publish);
    this.el.addEventListener("play", () => {
      this.playing.emit(true);
      if (this.ticker === null) {
        this.ticker = window.setInterval(publish, TICK_MS);
      }
    });
    this.el.addEventListener("pause", () => {
      this.playing.emit(false);
      this.stopTicker();
    });
    this.el.addEventListener("ended", () => {
      this.playing.emit(false);
      this.stopTicker();
      this.completed.emit();
    });
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    window.clearInterval(this.ticker);
    this.ticker = null;
  }

  /** Builds the Shaka player once, and reuses it for every later track. */
  private ensureReady(): Promise<void> {
    if (this.booting) return this.booting;

    this.booting = (async () => {
      const shaka = await loadShaka();
      if (!polyfilled) {
        shaka.polyfill.installAll();
        polyfilled = true;
      }
      if (!shaka.Player.isBrowserSupported()) {
        throw new Error("this webview cannot play DRM audio");
      }

      const player = new shaka.Player();
      await player.attach(this.el);
      player.addEventListener("error", (event) => {
        const detail = (event as unknown as { detail?: { code?: number } }).detail;
        console.warn(`[drm] shaka error ${detail?.code ?? "?"}`);
      });
      this.player = player;
    })().catch((e) => {
      // Leave it unset so the next play retries rather than latching failed.
      this.booting = null;
      throw e;
    });

    return this.booting;
  }

  /**
   * Builds the Shaka player before it is needed. The module is ~660 KB and
   * the CDM handshake is not free, so doing both while another track plays
   * takes them off the critical path of the next one.
   */
  async prepare(): Promise<void> {
    try {
      await this.ensureReady();
    } catch {
      /* the next load reports it against the track it belongs to */
    }
  }

  /** `url` is the `ctr-encrypted-hls` manifest for the track. */
  async load(url: string): Promise<void> {
    await this.loadUri(url);
  }

  /**
   * Plays an encrypted stream off disk. The segments are still ciphertext, so
   * this skips the transfer only - Shaka goes to SoundCloud for a licence
   * exactly as it would for a fresh stream.
   *
   * The manifest is handed over as a blob rather than read from disk, because
   * the asset-protocol URLs its segments need can only be spelled here. A
   * stored playlist always ends in `EXT-X-ENDLIST`, so Shaka reads it once and
   * the blob can be released as soon as the load settles.
   */
  async loadCached(entry: CachedDrmStream): Promise<void> {
    const text = localiseManifest(entry, convertFileSrc);
    const url = URL.createObjectURL(new Blob([text], { type: HLS_MIME }));
    try {
      await this.loadUri(url, HLS_MIME);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async loadUri(uri: string, mimeType?: string): Promise<void> {
    await this.ensureReady();
    const player = this.player;
    if (!player) throw new Error("DRM player did not come up");

    const shaka = await loadShaka();
    const cid = await this.clientId();

    player.configure({ drm: { servers: { [KEY_SYSTEM]: LICENSE_SERVER } } });

    const net = player.getNetworkingEngine();
    if (net) {
      // Re-registered per load so the filter always closes over a current id.
      net.clearAllRequestFilters();
      net.registerRequestFilter((type, request) => {
        if (type !== shaka.net.NetworkingEngine.RequestType.LICENSE) return;
        const first = request.uris[0];
        if (!first) return;
        const u = new URL(first);
        u.searchParams.set("client_id", cid);
        request.uris[0] = u.toString();
      });
    }

    await player.load(uri, null, mimeType);
    this.el.volume = this.userVolume;
    try {
      await this.el.play();
    } catch (e) {
      console.warn("[drm] play rejected", e);
    }
  }

  async pause(): Promise<void> {
    this.el.pause();
  }

  async resume(): Promise<void> {
    try {
      await this.el.play();
    } catch {
      /* the pause/play events carry the real state */
    }
  }

  async seek(ms: number): Promise<void> {
    try {
      this.el.currentTime = ms / 1000;
    } catch {
      /* seeking before the manifest loads is a no-op */
    }
  }

  async setVolume(volume: number): Promise<void> {
    this.userVolume = Math.min(1, Math.max(0, volume));
    this.el.volume = this.userVolume;
  }

  async stop(): Promise<void> {
    this.stopTicker();
    this.el.pause();
    try {
      await this.player?.unload();
    } catch {
      /* unloading an already-empty player is fine */
    }
    this.playing.emit(false);
  }

  /** No second decoder to fill. See `hasPreload`. */
  async preloadNext(): Promise<void> {}

  /** Nothing to swap to; the controller falls back to a plain `next()`. */
  async swapToNext(): Promise<void> {}

  dispose(): void {
    this.disposed = true;
    this.stopTicker();
    void this.player?.destroy();
    this.player = null;
    this.el.pause();
    this.el.removeAttribute("src");
    this.position.clear();
    this.buffered.clear();
    this.playing.clear();
    this.completed.clear();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}
