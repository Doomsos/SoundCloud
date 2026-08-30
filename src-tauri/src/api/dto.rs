//! Wire types for the SoundCloud v2 API. Port of `lib/core/api/dto/*.dart`.
//!
//! These stay separate from `crate::models` on purpose: the DTOs mirror what
//! SoundCloud actually sends, and `mappers` decides what the app makes of it.
//!
//! Several fields are parsed but never mapped into the domain - `streamable`,
//! `monetization_model`, playlist durations, comment timestamps. That is
//! deliberate and matches the Dart DTOs: the structs document the payload as
//! it really arrives, which is what makes it obvious *why* a mapper reads
//! `policy` instead of `monetization_model`. Hence one blanket allow here
//! rather than an attribute on each field.
#![allow(dead_code)]

use serde_json::Value;

use crate::core::json::{
    as_bool_or, as_i64, as_i64_or, as_map, as_map_list, as_str, opt_str, opt_str_trimmed,
};

/// One playable rendition of a track.
#[derive(Debug, Clone, Default)]
pub struct TranscodingDto {
    pub url: String,
    pub preset: String,
    pub protocol: String,
    pub mime_type: String,
}

impl TranscodingDto {
    pub fn is_hls(&self) -> bool {
        self.protocol == "hls"
    }

    pub fn is_mpeg(&self) -> bool {
        self.mime_type.contains("mpeg")
    }

    pub fn is_encrypted(&self) -> bool {
        self.protocol.contains("encrypted") || self.url.contains("encrypted")
    }

    /// Common-encryption (CTR) variant. Its manifest carries a PlayReady
    /// header as well as a Widevine one, and PlayReady is the CDM WebView2
    /// ships - the `cbc-` (CBCS) variants are FairPlay/Widevine only, so we
    /// cannot use them.
    pub fn is_cenc(&self) -> bool {
        self.protocol == "ctr-encrypted-hls"
    }

    /// SoundCloud lists an `audio/mpegurl` flavour of each encrypted variant
    /// that answers 404 on resolve; only the mp4 ones are real.
    pub fn is_mpeg_url(&self) -> bool {
        self.mime_type.contains("mpegurl")
    }

    /// The AAC stream soundcloud.com itself plays: 160 kbps in fragmented
    /// MP4, a clear step up on the 128 kbps MP3 the progressive transcoding
    /// serves.
    pub fn is_aac_160(&self) -> bool {
        self.preset == "aac_160k"
    }

    pub fn from_json(j: &Value) -> Self {
        let format = as_map(j.get("format"));
        Self {
            url: as_str(j.get("url")),
            preset: as_str(j.get("preset")),
            protocol: as_str(format.get("protocol")),
            mime_type: as_str(format.get("mime_type")),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct UserDto {
    pub id: i64,
    pub username: String,
    pub permalink: String,
    pub avatar_url: Option<String>,
    pub followers_count: i64,
    pub followings_count: i64,
    pub track_count: i64,
    pub likes_count: i64,
    pub playlist_count: i64,
    pub verified: bool,
    pub description: Option<String>,
}

impl UserDto {
    pub fn from_json(j: &Value) -> Self {
        Self {
            id: as_i64(j.get("id")),
            username: as_str(j.get("username")),
            permalink: as_str(j.get("permalink")),
            avatar_url: opt_str(j.get("avatar_url")),
            followers_count: as_i64(j.get("followers_count")),
            followings_count: as_i64(j.get("followings_count")),
            track_count: as_i64(j.get("track_count")),
            likes_count: as_i64(coalesce(j, &["likes_count", "public_favorites_count"])),
            playlist_count: as_i64(j.get("playlist_count")),
            verified: as_bool_or(j.get("verified"), false),
            description: opt_str(j.get("description")),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TrackDto {
    pub id: i64,
    pub title: String,
    pub duration_ms: i64,
    pub user: UserDto,
    pub genre: Option<String>,
    pub created_at: Option<String>,
    pub artwork_url: Option<String>,
    pub waveform_url: Option<String>,
    pub permalink_url: Option<String>,
    pub description: Option<String>,
    pub playback_count: i64,
    pub likes_count: i64,
    pub reposts_count: i64,
    pub comment_count: i64,
    pub streamable: bool,
    pub policy: Option<String>,
    /// Kept for the record: it describes how a track earns, and is exactly
    /// the field `is_go_plus` must NOT use. See that method.
    pub monetization_model: Option<String>,
    pub publisher_artist: Option<String>,
    pub transcodings: Vec<TranscodingDto>,
}

impl TrackDto {
    /// `policy` is the authoritative, per-listener field: SoundCloud answers
    /// `SNIP` when a 30s preview is all we may stream. `monetization_model`
    /// only describes how the track earns - a `SUB_HIGH_TIER` track plays in
    /// full for a Go+ subscriber, and its `policy` says so.
    pub fn is_go_plus(&self) -> bool {
        self.policy.as_deref() == Some("SNIP")
    }

    /// DRM-protected. SoundCloud still lists plain transcodings for these but
    /// refuses to resolve them (404); only the `cbc-`/`ctr-encrypted-hls`
    /// variants resolve. Those now route to the Shaka/PlayReady engine rather
    /// than being treated as unplayable.
    pub fn is_drm_only(&self) -> bool {
        self.transcodings.iter().any(TranscodingDto::is_encrypted)
    }

    pub fn from_json(j: &Value) -> Self {
        let media = as_map(j.get("media"));
        Self {
            id: as_i64(j.get("id")),
            title: as_str(j.get("title")),
            duration_ms: as_i64(coalesce(j, &["full_duration", "duration"])),
            user: UserDto::from_json(j.get("user").unwrap_or(&Value::Null)),
            genre: opt_str(j.get("genre")),
            created_at: opt_str(j.get("created_at")),
            artwork_url: opt_str(j.get("artwork_url")),
            waveform_url: opt_str(j.get("waveform_url")),
            permalink_url: opt_str(j.get("permalink_url")),
            description: opt_str(j.get("description")),
            playback_count: as_i64(j.get("playback_count")),
            likes_count: as_i64(coalesce(j, &["likes_count", "favoritings_count"])),
            reposts_count: as_i64(j.get("reposts_count")),
            comment_count: as_i64(j.get("comment_count")),
            streamable: as_bool_or(j.get("streamable"), true),
            policy: opt_str(j.get("policy")),
            monetization_model: opt_str(j.get("monetization_model")),
            publisher_artist: opt_str_trimmed(as_map(j.get("publisher_metadata")).get("artist")),
            transcodings: as_map_list(media.get("transcodings"))
                .into_iter()
                .map(TranscodingDto::from_json)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PlaylistDto {
    pub id: String,
    pub title: String,
    pub user: UserDto,
    pub is_album: bool,
    pub set_type: Option<String>,
    pub track_count: i64,
    pub duration_ms: i64,
    pub artwork_url: Option<String>,
    pub permalink_url: Option<String>,
    pub likes_count: i64,
    pub genre: Option<String>,
    pub tracks: Vec<TrackDto>,
}

impl PlaylistDto {
    pub fn from_json(j: &Value) -> Self {
        let raw_tracks = as_map_list(j.get("tracks"));
        Self {
            id: as_str(j.get("id")),
            title: as_str(j.get("title")),
            user: UserDto::from_json(j.get("user").unwrap_or(&Value::Null)),
            is_album: as_bool_or(j.get("is_album"), false),
            set_type: opt_str(j.get("set_type")),
            track_count: as_i64_or(j.get("track_count"), raw_tracks.len() as i64),
            duration_ms: as_i64(j.get("duration")),
            artwork_url: opt_str(j.get("artwork_url")),
            permalink_url: opt_str(j.get("permalink_url")),
            likes_count: as_i64(j.get("likes_count")),
            genre: opt_str(j.get("genre")),
            // A playlist payload lists some tracks as bare `{id}` stubs; only
            // the hydrated ones carry a title and can be parsed here.
            tracks: raw_tracks
                .into_iter()
                .filter(|t| t.get("title").is_some())
                .map(TrackDto::from_json)
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CommentDto {
    pub id: i64,
    pub body: String,
    pub timestamp_ms: i64,
    pub user: UserDto,
    pub created_at: Option<String>,
    pub track_id: Option<i64>,
}

impl CommentDto {
    pub fn from_json(j: &Value) -> Self {
        Self {
            id: as_i64(j.get("id")),
            body: as_str(j.get("body")),
            timestamp_ms: as_i64(j.get("timestamp")),
            user: UserDto::from_json(j.get("user").unwrap_or(&Value::Null)),
            created_at: opt_str(j.get("created_at")),
            track_id: match j.get("track_id") {
                None | Some(Value::Null) => None,
                other => Some(as_i64(other)),
            },
        }
    }
}

/// A paged `{collection, next_href}` envelope.
#[derive(Debug, Clone, Default)]
pub struct PageDto<T> {
    pub collection: Vec<T>,
    pub next_href: Option<String>,
}

impl<T> PageDto<T> {
    pub fn parse(j: &Value, item: impl Fn(&Value) -> T) -> Self {
        Self {
            collection: as_map_list(j.get("collection")).into_iter().map(item).collect(),
            next_href: opt_str(j.get("next_href")),
        }
    }

    pub fn map_list<R>(self, f: impl Fn(T) -> R) -> Vec<R> {
        self.collection.into_iter().map(f).collect()
    }
}

/// One entry in `/stream`.
#[derive(Debug, Clone, Default)]
pub struct StreamItemDto {
    pub kind: String,
    pub created_at: Option<String>,
    pub actor: Option<UserDto>,
    pub track: Option<TrackDto>,
    /// Parsed for completeness. `to_feed_post` renders track entries only,
    /// exactly as the Dart mapper did.
    pub playlist: Option<PlaylistDto>,
}

impl StreamItemDto {
    pub fn is_repost(&self) -> bool {
        self.kind.ends_with("-repost")
    }

    pub fn is_track(&self) -> bool {
        self.kind.starts_with("track")
    }

    pub fn from_json(j: &Value) -> Self {
        Self {
            kind: as_str(j.get("type")),
            created_at: opt_str(j.get("created_at")),
            actor: j.get("user").filter(|v| v.is_object()).map(UserDto::from_json),
            track: j.get("track").filter(|v| v.is_object()).map(TrackDto::from_json),
            playlist: j
                .get("playlist")
                .filter(|v| v.is_object())
                .map(PlaylistDto::from_json),
        }
    }
}

/// Dart's `j['a'] ?? j['b']`: the first key that is present and not null.
fn coalesce<'a>(j: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter()
        .find_map(|k| j.get(k).filter(|v| !v.is_null()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transcoding_flags_classify_each_variant() {
        let progressive = TranscodingDto::from_json(&json!({
            "url": "https://api/x", "preset": "mp3_0_0",
            "format": { "protocol": "progressive", "mime_type": "audio/mpeg" }
        }));
        assert!(!progressive.is_hls() && !progressive.is_encrypted() && progressive.is_mpeg());

        let cenc = TranscodingDto::from_json(&json!({
            "url": "https://api/y", "preset": "aac_160k",
            "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4" }
        }));
        assert!(cenc.is_encrypted() && cenc.is_cenc() && !cenc.is_mpeg_url() && cenc.is_aac_160());

        // CBCS is FairPlay/Widevine only - encrypted, but not usable by us.
        let cbcs = TranscodingDto::from_json(&json!({
            "url": "https://api/z", "preset": "aac_160k",
            "format": { "protocol": "cbc-encrypted-hls", "mime_type": "audio/mp4" }
        }));
        assert!(cbcs.is_encrypted() && !cbcs.is_cenc());

        // The decoy mpegurl flavour of an encrypted variant.
        let decoy = TranscodingDto::from_json(&json!({
            "url": "https://api/w", "preset": "aac_160k",
            "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mpegurl" }
        }));
        assert!(decoy.is_cenc() && decoy.is_mpeg_url());

        // `encrypted` in the URL alone is enough.
        let by_url = TranscodingDto::from_json(&json!({
            "url": "https://api/encrypted/hls", "preset": "p",
            "format": { "protocol": "hls", "mime_type": "audio/mpeg" }
        }));
        assert!(by_url.is_encrypted());
    }

    #[test]
    fn track_prefers_full_duration_and_alternate_count_keys() {
        let j = json!({
            "id": 1, "title": "t", "duration": 30_000, "full_duration": 200_000,
            "favoritings_count": 9, "user": { "id": 2, "username": "u", "permalink": "p" }
        });
        let dto = TrackDto::from_json(&j);
        assert_eq!(dto.duration_ms, 200_000, "full_duration wins over the snip duration");
        assert_eq!(dto.likes_count, 9, "favoritings_count is the legacy key");
        assert!(dto.streamable, "streamable defaults to true when absent");

        // A null full_duration must fall through to duration.
        let j2 = json!({ "id": 1, "duration": 30_000, "full_duration": null });
        assert_eq!(TrackDto::from_json(&j2).duration_ms, 30_000);
    }

    #[test]
    fn go_plus_reads_policy_not_monetization() {
        let snip = TrackDto::from_json(&json!({ "policy": "SNIP" }));
        assert!(snip.is_go_plus());
        // Earns via subscription but plays in full for us: not a Go+ wall.
        let sub = TrackDto::from_json(&json!({
            "policy": "ALLOW", "monetization_model": "SUB_HIGH_TIER"
        }));
        assert!(!sub.is_go_plus());
    }

    #[test]
    fn publisher_artist_overrides_only_when_non_blank() {
        let named = TrackDto::from_json(&json!({
            "publisher_metadata": { "artist": "Real Artist" }
        }));
        assert_eq!(named.publisher_artist.as_deref(), Some("Real Artist"));
        let blank = TrackDto::from_json(&json!({ "publisher_metadata": { "artist": "  " } }));
        assert_eq!(blank.publisher_artist, None);
        let missing = TrackDto::from_json(&json!({}));
        assert_eq!(missing.publisher_artist, None);
    }

    #[test]
    fn playlist_counts_stubs_but_parses_only_hydrated_tracks() {
        let j = json!({
            "id": 987, "title": "set",
            "user": { "username": "u" },
            "tracks": [ { "id": 1, "title": "real" }, { "id": 2 } ]
        });
        let dto = PlaylistDto::from_json(&j);
        assert_eq!(dto.id, "987", "numeric ids stringify");
        assert_eq!(dto.track_count, 2, "stubs still count toward track_count");
        assert_eq!(dto.tracks.len(), 1, "only the hydrated track parses");
    }

    #[test]
    fn stream_item_classifies_type() {
        let repost = StreamItemDto::from_json(&json!({
            "type": "track-repost", "track": { "id": 1, "title": "t" }, "user": { "username": "a" }
        }));
        assert!(repost.is_track() && repost.is_repost());
        assert!(repost.actor.is_some() && repost.track.is_some());

        let posted = StreamItemDto::from_json(&json!({ "type": "track" }));
        assert!(posted.is_track() && !posted.is_repost());

        let pl = StreamItemDto::from_json(&json!({ "type": "playlist-repost" }));
        assert!(!pl.is_track() && pl.is_repost());
    }

    #[test]
    fn page_parses_collection_and_cursor() {
        let j = json!({
            "collection": [ { "id": 1 }, "junk", { "id": 2 } ],
            "next_href": "https://api/next"
        });
        let page = PageDto::parse(&j, |v| as_i64(v.get("id")));
        assert_eq!(page.collection, vec![1, 2]);
        assert_eq!(page.next_href.as_deref(), Some("https://api/next"));

        let empty: PageDto<i64> = PageDto::parse(&json!({}), |v| as_i64(v.get("id")));
        assert!(empty.collection.is_empty() && empty.next_href.is_none());
    }
}
