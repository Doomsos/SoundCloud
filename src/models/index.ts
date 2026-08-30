/**
 * TypeScript mirrors of `src-tauri/src/models.rs`.
 *
 * These are the exact shapes serde emits, so they are read-only data: what
 * Dart exposed as computed getters (`locked`, `artistHandle`, `isCircular`)
 * arrives as real fields, already resolved by Rust.
 */

export type TrackLock = "none" | "goPlus" | "drm";

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistPermalink?: string;
  durationMs: number;
  likes: number;
  reposts: number;
  plays: number;
  genre: string;
  postedAt: string;
  description: string;
  waveform: number[];
  waveformUrl?: string;
  coverUrl?: string;
  streamCandidates: string[];
  /** Encrypted-HLS manifests, used only when `lock` is `"drm"`. */
  drmCandidates: string[];
  permalinkUrl?: string;
  lock: TrackLock;
  minted: boolean;
  /** `artistPermalink` when set, else the display name. */
  artistHandle: string;
  /** Drives the GO+ badge. */
  goPlus: boolean;
  /**
   * True only when the track genuinely cannot play. DRM is *not* a lock - it
   * routes to the Shaka engine - so this is the Go+ wall alone.
   */
  locked: boolean;
}

export interface Artist {
  id: string;
  handle: string;
  name: string;
  followers: number;
  trackCount: number;
  likesCount: number;
  playlistCount: number;
  followingsCount: number;
  verified: boolean;
  avatarUrl?: string;
  coverSeed: string;
}

export type CollectionKind = "mix" | "album" | "playlist" | "station" | "autoMix";
export type CollectionTarget = "track" | "playlist" | "artist";

export interface Collection {
  id: string;
  title: string;
  subtitle: string;
  kind: CollectionKind;
  trackCount: number;
  mixLabel?: string;
  wordmark?: string;
  minted: boolean;
  coverUrl?: string;
  target: CollectionTarget;
  handle?: string;
  circular?: boolean;
  isCircular: boolean;
  coverSeed: string;
}

export interface Comment {
  id: string;
  author: string;
  timecodeMs: number;
  text: string;
  authorSeed: string;
}

export type FeedAction = "posted" | "reposted";

export interface FeedPost {
  id: string;
  actor: string;
  action: FeedAction;
  timeAgo: string;
  track: Track;
  tag: string;
  comments: number;
  actionLabel: string;
  actorSeed: string;
}

export interface Shelf {
  title: string;
  items: Collection[];
}

export interface HomeData {
  stream: Track[];
  shelves: Shelf[];
}

export interface LibraryData {
  recentlyPlayed: Collection[];
  likes: Collection[];
  playlists: Collection[];
  albums: Collection[];
  stations: Collection[];
  following: Collection[];
  history: Track[];
}

export interface TrackDetail {
  track: Track;
  comments: Comment[];
  related: Track[];
}

export interface ArtistProfile {
  artist: Artist;
  tracks: Track[];
  albums: Collection[];
  playlists: Collection[];
}

export interface RailData {
  me?: Artist;
  likes: Track[];
  history: Track[];
}

export interface SearchResults {
  tracks: Track[];
  artists: Artist[];
  playlists: Collection[];
}

export interface PlaylistDetail {
  playlist: Collection;
  tracks: Track[];
}

export interface LikesPage {
  tracks: Track[];
  nextHref?: string;
}

/** `blocked` means SoundCloud refused the write, not that the network failed. */
export type LikeOutcome = "ok" | "failed" | "blocked";

export interface AuthStatus {
  authenticated: boolean;
  hasClientId: boolean;
  compiledIn: boolean;
}

export interface LastfmSession {
  key: string;
  name: string;
}

export interface LogEntry {
  at: number;
  level: string;
  target: string;
  message: string;
}

/**
 * A cached encrypted stream, mirroring `CachedDrmStream` in `core/cache.rs`.
 *
 * `manifest` still holds `wf-local:<n>` placeholders where the media URIs
 * were, and `files[n]` is the absolute path each one stands for. Rust cannot
 * write the final URLs itself - only the webview can spell an asset-protocol
 * URL - so `localiseManifest` joins the two halves before Shaka sees them.
 */
export interface CachedDrmStream {
  manifest: string;
  files: string[];
}

/** Why a track could not be played, for the toast in the shell. */
export interface Unplayable {
  seq: number;
  title: string;
  lock: TrackLock;
}

export const trackDuration = (t: Track): number => t.durationMs;

/** `fraction` from `comment.dart`. */
export const commentFraction = (c: Comment, trackMs: number): number =>
  trackMs === 0 ? 0 : Math.min(1, Math.max(0, c.timecodeMs / trackMs));
