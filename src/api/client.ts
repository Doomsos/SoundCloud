/**
 * The Rust IPC surface, typed. One function per `#[tauri::command]` in
 * `src-tauri/src/commands.rs`.
 *
 * Everything that touches the network lives on the Rust side, which means the
 * frontend never deals with CORS, the `client_id` dance, or OAuth headers -
 * it just awaits domain objects.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ArtistProfile,
  AuthStatus,
  CachedDrmStream,
  FeedPost,
  HomeData,
  LastfmSession,
  LibraryData,
  LikeOutcome,
  LikesPage,
  LogEntry,
  PlaylistDetail,
  RailData,
  SearchResults,
  Track,
  TrackDetail,
} from "@/models";

// ---- reads ---------------------------------------------------------------

export const home = () => invoke<HomeData>("api_home");
export const library = () => invoke<LibraryData>("api_library");
export const feed = () => invoke<FeedPost[]>("api_feed");
export const rail = () => invoke<RailData>("api_rail");

export const trackDetail = (id: string) => invoke<TrackDetail>("api_track_detail", { id });
export const artistProfile = (handle: string) =>
  invoke<ArtistProfile>("api_artist_profile", { handle });
export const search = (query: string) => invoke<SearchResults>("api_search", { query });
export const playlist = (id: string) => invoke<PlaylistDetail>("api_playlist", { id });
export const allPlaylistTracks = (id: string) =>
  invoke<Track[]>("api_all_playlist_tracks", { id });

export const historyPage = (limit = 50, offset = 0) =>
  invoke<Track[]>("api_history_page", { limit, offset });
export const likesPage = (nextHref?: string, limit = 50) =>
  invoke<LikesPage>("api_likes_page", { nextHref: nextHref ?? null, limit });
export const repostedTrackIds = () => invoke<string[]>("api_reposted_track_ids");

export const fetchWaveform = (url: string) =>
  invoke<number[] | null>("api_fetch_waveform", { url });

/** `null` means this candidate is dead - try the next one. */
export const resolveStreamUrl = (transcodingUrl: string) =>
  invoke<string | null>("api_resolve_stream_url", { transcodingUrl });

/** Maps a soundcloud.com link to an in-app route. */
export const resolveUrl = (url: string) => invoke<string | null>("api_resolve_url", { url });

/**
 * The scraped anonymous client_id. Shaka needs it in the browser to sign
 * PlayReady licence requests. Not the same thing as `authGetClientId`, which
 * is the OAuth *application* id used for signing in.
 */
export const invokeAnonClientId = () => invoke<string>("api_anon_client_id");

export const appDataDir = () => invoke<string>("app_data_dir");
export const revealDataDir = () => invoke<void>("reveal_data_dir");

// ---- writes --------------------------------------------------------------

export const setLiked = (trackId: string, liked: boolean) =>
  invoke<LikeOutcome>("api_set_liked", { trackId, liked });
export const setReposted = (trackId: string, reposted: boolean) =>
  invoke<LikeOutcome>("api_set_reposted", { trackId, reposted });

// ---- auth ----------------------------------------------------------------

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const authRestore = () => invoke<AuthStatus>("auth_restore");
/** Runs the full PKCE browser flow; resolves once the callback lands. */
export const authSignIn = () => invoke<AuthStatus>("auth_sign_in");
export const authSignInWithToken = (token: string) =>
  invoke<AuthStatus>("auth_sign_in_with_token", { token });
export const authSignOut = () => invoke<AuthStatus>("auth_sign_out");
export const authVerifyToken = (token: string) => invoke<boolean>("auth_verify_token", { token });
export const authGetClientId = () => invoke<string>("auth_get_client_id");
export const authSaveClientId = (id: string) => invoke<void>("auth_save_client_id", { id });

// ---- prefs ---------------------------------------------------------------

export const prefsGetString = (key: string) =>
  invoke<string | null>("prefs_get_string", { key });
export const prefsSetString = (key: string, value: string) =>
  invoke<void>("prefs_set_string", { key, value });
export const prefsGetBool = (key: string) => invoke<boolean | null>("prefs_get_bool", { key });
export const prefsSetBool = (key: string, value: boolean) =>
  invoke<void>("prefs_set_bool", { key, value });
export const prefsGetInt = (key: string) => invoke<number | null>("prefs_get_int", { key });
export const prefsSetInt = (key: string, value: number) =>
  invoke<void>("prefs_set_int", { key, value });
export const prefsRemove = (key: string) => invoke<void>("prefs_remove", { key });

// ---- cache ---------------------------------------------------------------

/** Absolute path of the cached file, or null. Pass it through `convertFileSrc`. */
export const cacheHit = (trackId: string) => invoke<string | null>("cache_hit", { trackId });
/** Fire-and-forget: returns as soon as the download is queued. */
export const cacheStore = (trackId: string, url: string) =>
  invoke<void>("cache_store", { trackId, url });
/**
 * The cached encrypted stream for a track, or null. Its manifest still needs
 * `localiseManifest` before Shaka can load it.
 */
export const cacheHitDrm = (trackId: string) =>
  invoke<CachedDrmStream | null>("cache_hit_drm", { trackId });
/** Fire-and-forget: the encrypted segments are fetched behind playback. */
export const cacheStoreDrm = (trackId: string, manifestUrl: string) =>
  invoke<void>("cache_store_drm", { trackId, manifestUrl });
/** Drops a cached copy that turned out not to play. */
export const cacheForget = (trackId: string) => invoke<void>("cache_forget", { trackId });
export const cacheSize = () => invoke<number>("cache_size");
export const cacheTrim = () => invoke<void>("cache_trim");
export const cacheClear = () => invoke<void>("cache_clear");

// ---- logs ----------------------------------------------------------------

export const logsSnapshot = () => invoke<LogEntry[]>("logs_snapshot");
export const logsClear = () => invoke<void>("logs_clear");
export const logWrite = (level: string, target: string, message: string) =>
  invoke<void>("log_write", { level, target, message });

// ---- last.fm -------------------------------------------------------------

export const lastfmConfigured = () => invoke<boolean>("lastfm_configured");
export const lastfmSession = () => invoke<LastfmSession | null>("lastfm_session");
export const lastfmBeginAuth = () => invoke<string>("lastfm_begin_auth");
export const lastfmCompleteAuth = (token: string) =>
  invoke<LastfmSession | null>("lastfm_complete_auth", { token });
export const lastfmSignOut = () => invoke<void>("lastfm_sign_out");

export interface LastfmTick {
  trackId: string | null;
  artist: string;
  title: string;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  elapsedSecs: number;
  startedAtUnix: number;
}
/** One player tick; Rust decides whether anything is actually due. */
export const lastfmTick = (t: LastfmTick) => invoke<void>("lastfm_tick", { ...t });

// ---- window / app --------------------------------------------------------

export const appQuit = () => invoke<void>("app_quit");
export const windowHideToTray = () => invoke<void>("window_hide_to_tray");
export const windowShow = () => invoke<void>("window_show");
export const windowSetTitle = (title: string) => invoke<void>("window_set_title", { title });
/** Two-line tray tooltip: title over artist, or the app name when idle. */
export const traySetTooltip = (title: string, artist: string) =>
  invoke<void>("tray_set_tooltip", { title, artist });
export const openExternal = (url: string) => invoke<void>("open_external", { url });

/**
 * Opens soundcloud.com in an app-owned webview so a captcha or bot check can
 * be cleared. This is the "verify" action offered when a write comes back
 * `blocked`.
 */
export const openVerificationWindow = () => invoke<void>("open_verification_window");

/**
 * Wraps a call so a failure is logged and folded into a fallback instead of
 * rejecting. This is the `_safe` of the Dart API layer, on the UI side: a
 * dead section should render empty, not tear down the screen.
 */
export async function safe<T>(op: () => Promise<T>, fallback: T, what = "call"): Promise<T> {
  try {
    return await op();
  } catch (e) {
    void logWrite("WARN", "ui", `${what} failed: ${String(e)}`);
    return fallback;
  }
}
