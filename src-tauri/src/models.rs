//! Domain models. Direct port of `lib/shared/models/*.dart`.
//!
//! Everything here crosses the IPC boundary into the webview, so the field
//! names are serialised in camelCase to match the TypeScript mirror in
//! `src/models/`. Dart's computed getters (`locked`, `artistHandle`, ...)
//! become real serialised fields, because the frontend reads them as plain
//! data rather than calling back into Rust.

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

/// Why a track can't be played in full. Port of `TrackLock`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TrackLock {
    #[default]
    None,
    /// SoundCloud only hands us a 30s preview (`policy: SNIP`); playing it in
    /// full needs a Go+ subscription.
    GoPlus,
    /// Served only as encrypted HLS. Decoded through the webview's PlayReady
    /// CDM by the Shaka engine, so this routes playback rather than blocking it.
    Drm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_permalink: Option<String>,
    pub duration_ms: i64,
    pub likes: i64,
    pub reposts: i64,
    pub plays: i64,
    pub genre: String,
    pub posted_at: String,
    pub description: String,
    pub waveform: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub stream_candidates: Vec<String>,
    /// Encrypted-HLS manifests, used only when `lock` is `Drm`.
    #[serde(default)]
    pub drm_candidates: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permalink_url: Option<String>,
    pub lock: TrackLock,
    #[serde(default)]
    pub minted: bool,

    // --- Dart getters, materialised for the frontend ---
    /// `artistPermalink` when set, else the display name.
    pub artist_handle: String,
    /// True only for a Go+ subscription lock - drives the GO+ badge.
    pub go_plus: bool,
    /// True only when we genuinely cannot play the track. DRM is *not* a lock
    /// any more - it just routes to the Shaka engine - so this is the Go+ wall
    /// alone. Badges and tap-to-play guards key off it.
    pub locked: bool,
}

impl Track {
    /// Recomputes the fields the Dart original exposed as getters. Call this
    /// after building or mutating a `Track` so the serialised view stays true.
    pub fn seal(mut self) -> Self {
        self.artist_handle = match self.artist_permalink.as_deref() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => self.artist.clone(),
        };
        self.go_plus = self.lock == TrackLock::GoPlus;
        self.locked = self.lock == TrackLock::GoPlus;
        self
    }

    #[allow(dead_code)] // mirrors Dart's `Track.streamUrl`; the frontend reads the list directly
    pub fn stream_url(&self) -> Option<&str> {
        self.stream_candidates.first().map(String::as_str)
    }

    /// Decorative placeholder bars, used until the real waveform JSON loads.
    ///
    /// Deterministic in `seed` exactly as the Dart version was, though the
    /// PRNG differs: Dart's seeded `Random` is not specified across
    /// implementations, and this value is cosmetic, never compared.
    pub fn generate_waveform(seed: i64) -> Vec<f64> {
        const BARS: usize = 140;
        let mut rng = SeedRng::new(seed as u64);
        (0..BARS)
            .map(|i| {
                let t = i as f64 / BARS as f64;
                let envelope = 0.35 + 0.45 * ((t * PI * 3.0 + seed as f64).sin() * 0.5 + 0.5);
                let jitter = rng.next_f64() * 0.5;
                (envelope * 0.6 + jitter * 0.4).clamp(0.04, 1.0)
            })
            .collect()
    }
}

impl Default for Track {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            artist: String::new(),
            artist_permalink: None,
            duration_ms: 0,
            likes: 0,
            reposts: 0,
            plays: 0,
            genre: "electronic".into(),
            posted_at: "3 days ago".into(),
            description: String::new(),
            waveform: Vec::new(),
            waveform_url: None,
            cover_url: None,
            stream_candidates: Vec::new(),
            drm_candidates: Vec::new(),
            permalink_url: None,
            lock: TrackLock::None,
            minted: false,
            artist_handle: String::new(),
            go_plus: false,
            locked: false,
        }
    }
}

/// SplitMix64. Small, fast, and deterministic for a given seed.
struct SeedRng(u64);

impl SeedRng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1))
    }
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub followers: i64,
    #[serde(default)]
    pub track_count: i64,
    #[serde(default)]
    pub likes_count: i64,
    #[serde(default)]
    pub playlist_count: i64,
    #[serde(default)]
    pub followings_count: i64,
    #[serde(default)]
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// `artist-<id>`, the stable seed for generated cover art.
    pub cover_seed: String,
}

impl Artist {
    pub fn seal(mut self) -> Self {
        if self.name.is_empty() {
            self.name = self.handle.clone();
        }
        self.cover_seed = format!("artist-{}", self.id);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CollectionKind {
    Mix,
    Album,
    #[default]
    Playlist,
    Station,
    AutoMix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CollectionTarget {
    Track,
    #[default]
    Playlist,
    Artist,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub kind: CollectionKind,
    #[serde(default)]
    pub track_count: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mix_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wordmark: Option<String>,
    #[serde(default)]
    pub minted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_url: Option<String>,
    pub target: CollectionTarget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    /// Explicit override; `None` falls back to the station/artist rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circular: Option<bool>,
    // --- getters ---
    pub is_circular: bool,
    pub cover_seed: String,
}

impl Collection {
    pub fn seal(mut self) -> Self {
        self.is_circular = self.circular.unwrap_or(
            self.kind == CollectionKind::Station || self.target == CollectionTarget::Artist,
        );
        self.cover_seed = self.id.clone();
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub author: String,
    pub timecode_ms: i64,
    pub text: String,
    /// `c-<author>`, the seed for the generated avatar.
    pub author_seed: String,
}

impl Comment {
    pub fn seal(mut self) -> Self {
        self.author_seed = format!("c-{}", self.author);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FeedAction {
    #[default]
    Posted,
    Reposted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPost {
    pub id: String,
    pub actor: String,
    pub action: FeedAction,
    pub time_ago: String,
    pub track: Track,
    pub tag: String,
    #[serde(default)]
    pub comments: i64,
    // --- getters ---
    pub action_label: String,
    pub actor_seed: String,
}

impl FeedPost {
    pub fn seal(mut self) -> Self {
        self.action_label = match self.action {
            FeedAction::Reposted => "reposted a track".into(),
            FeedAction::Posted => "posted a track".into(),
        };
        self.actor_seed = format!("actor-{}", self.id);
        self
    }
}

/// `typedef Shelf` from `soundcloud_api.dart`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub title: String,
    pub items: Vec<Collection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HomeData {
    pub stream: Vec<Track>,
    pub shelves: Vec<Shelf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibraryData {
    pub recently_played: Vec<Collection>,
    pub likes: Vec<Collection>,
    pub playlists: Vec<Collection>,
    pub albums: Vec<Collection>,
    pub stations: Vec<Collection>,
    pub following: Vec<Collection>,
    pub history: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackDetail {
    pub track: Track,
    pub comments: Vec<Comment>,
    pub related: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArtistProfile {
    pub artist: Artist,
    pub tracks: Vec<Track>,
    pub albums: Vec<Collection>,
    pub playlists: Vec<Collection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RailData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub me: Option<Artist>,
    pub likes: Vec<Track>,
    pub history: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub artists: Vec<Artist>,
    pub playlists: Vec<Collection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    pub playlist: Collection,
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LikesPage {
    pub tracks: Vec<Track>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_href: Option<String>,
}

/// Port of `enum LikeOutcome`. `Blocked` means SoundCloud refused the write
/// (401/403/429) rather than the request itself failing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LikeOutcome {
    Ok,
    Failed,
    Blocked,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_is_deterministic_and_in_range() {
        let a = Track::generate_waveform(42);
        let b = Track::generate_waveform(42);
        assert_eq!(a, b, "same seed must give the same bars");
        assert_eq!(a.len(), 140);
        assert!(a.iter().all(|v| (0.04..=1.0).contains(v)));
        assert_ne!(a, Track::generate_waveform(43));
    }

    #[test]
    fn seal_prefers_permalink_for_handle_and_derives_lock_flags() {
        let t = Track {
            artist: "Display Name".into(),
            artist_permalink: Some("real-handle".into()),
            lock: TrackLock::GoPlus,
            ..Default::default()
        }
        .seal();
        assert_eq!(t.artist_handle, "real-handle");
        assert!(t.go_plus && t.locked);

        // DRM routes to the Shaka engine, so it must not read as locked.
        let d = Track { lock: TrackLock::Drm, ..Default::default() }.seal();
        assert!(!d.locked && !d.go_plus);

        // Empty permalink falls back to the display name.
        let e = Track {
            artist: "Only Name".into(),
            artist_permalink: Some(String::new()),
            ..Default::default()
        }
        .seal();
        assert_eq!(e.artist_handle, "Only Name");
    }

    #[test]
    fn collection_circular_rule_matches_dart() {
        let station = Collection { kind: CollectionKind::Station, ..Default::default() }.seal();
        assert!(station.is_circular);
        let artist = Collection { target: CollectionTarget::Artist, ..Default::default() }.seal();
        assert!(artist.is_circular);
        let plain = Collection::default().seal();
        assert!(!plain.is_circular);
        // An explicit override wins over the rule.
        let forced = Collection {
            kind: CollectionKind::Station,
            circular: Some(false),
            ..Default::default()
        }
        .seal();
        assert!(!forced.is_circular);
    }
}
