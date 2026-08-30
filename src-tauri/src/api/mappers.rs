//! DTO -> domain conversions. Port of `lib/core/api/mappers.dart`.

use chrono::{DateTime, Utc};

use crate::api::dto::{CommentDto, PlaylistDto, StreamItemDto, TrackDto, UserDto};
use crate::models::{
    Artist, Collection, CollectionKind, CollectionTarget, Comment, FeedAction, FeedPost, Track,
    TrackLock,
};


/// SoundCloud serves artwork at several sizes behind one URL template; the
/// `-large` cut is 100px, which is unusably soft on a desktop grid.
pub fn hi_res_artwork(url: Option<&str>) -> Option<String> {
    url.map(|u| u.replacen("-large.", "-t500x500.", 1))
}

/// Drops URLs that are not really pictures: blanks, and SoundCloud's stock
/// silhouette avatar - which reads worse than the gradient `CoverArt` paints
/// when it is handed nothing at all.
fn usable_image(url: Option<&str>) -> Option<&str> {
    url.filter(|u| !u.trim().is_empty() && !u.contains("default_avatar"))
}

/// Coarse "3 days ago" phrasing, matching the Dart buckets exactly.
pub fn relative_time(iso: Option<&str>) -> String {
    let Some(iso) = iso else { return String::new() };
    let Some(dt) = parse_timestamp(iso) else { return String::new() };

    let d = Utc::now().signed_duration_since(dt);
    let mins = d.num_minutes();
    let hours = d.num_hours();
    let days = d.num_days();

    if mins < 1 {
        "just now".into()
    } else if mins < 60 {
        format!("{mins} minutes ago")
    } else if hours < 24 {
        format!("{hours} hours ago")
    } else if days < 7 {
        format!("{days} days ago")
    } else if days < 30 {
        format!("{} weeks ago", days / 7)
    } else if days < 365 {
        format!("{} months ago", days / 30)
    } else {
        format!("{} years ago", days / 365)
    }
}

/// SoundCloud mixes RFC3339 with a legacy `2014/01/15 12:34:56 +0000` shape.
fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Some(dt.with_timezone(&Utc));
    }
    DateTime::parse_from_str(raw, "%Y/%m/%d %H:%M:%S %z")
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

impl TrackDto {
    pub fn to_domain(&self) -> Track {
        Track {
            id: self.id.to_string(),
            title: self.title.clone(),
            artist: match self.publisher_artist.as_deref().map(str::trim) {
                Some(a) if !a.is_empty() => a.to_string(),
                _ => self.user.username.clone(),
            },
            artist_permalink: Some(self.user.permalink.clone()),
            duration_ms: self.duration_ms,
            likes: self.likes_count,
            reposts: self.reposts_count,
            plays: self.playback_count,
            waveform: Track::generate_waveform(self.id),
            waveform_url: self.waveform_url.clone(),
            cover_url: self.cover(),
            permalink_url: self.permalink_url.clone(),
            stream_candidates: self.stream_candidates(),
            drm_candidates: self.drm_candidates(),
            lock: if self.is_go_plus() {
                TrackLock::GoPlus
            } else if self.is_drm_only() {
                TrackLock::Drm
            } else {
                TrackLock::None
            },
            genre: match self.genre.as_deref() {
                Some(g) if !g.is_empty() => g.to_string(),
                _ => "electronic".into(),
            },
            posted_at: relative_time(self.created_at.as_deref()),
            description: self.description.clone().unwrap_or_default(),
            ..Default::default()
        }
        .seal()
    }

    /// The track's own artwork, or the uploader's profile picture when it has
    /// none. SoundCloud does the same on the web: a track posted without a
    /// cover carries the poster's avatar rather than a hole in the grid.
    ///
    /// Falling through to `None` is still meaningful - `CoverArt` paints its
    /// seeded gradient then, which beats a stock silhouette.
    fn cover(&self) -> Option<String> {
        hi_res_artwork(usable_image(self.artwork_url.as_deref()))
            .or_else(|| hi_res_artwork(usable_image(self.user.avatar_url.as_deref())))
    }

    /// Plain (non-encrypted) renditions, best first.
    ///
    /// The 160 kbps AAC leads because it is the best SoundCloud serves without
    /// DRM, and it is what the web player reaches for when a track has one.
    /// Progressive MP3 led here until now, but only because the Flutter build
    /// decoded through libmpv, which stalled at 0:00 on the `aac_160k` fMP4
    /// stream. The webview player has no such limit, so the workaround was
    /// costing ~30 kbps on every track that offers both.
    ///
    /// Below that the order is unchanged: the 128 kbps MP3s, single file
    /// before HLS, then whatever is left - which in practice is the 72 kbps
    /// opus rendition, worth reaching only when nothing else resolves.
    fn stream_candidates(&self) -> Vec<String> {
        let mut out = Vec::new();
        for t in &self.transcodings {
            if t.is_hls() && !t.is_encrypted() && t.is_aac_160() {
                out.push(t.url.clone());
            }
        }
        for t in &self.transcodings {
            if !t.is_hls() && !t.is_encrypted() {
                out.push(t.url.clone());
            }
        }
        for t in &self.transcodings {
            if t.is_hls() && !t.is_encrypted() && t.is_mpeg() {
                out.push(t.url.clone());
            }
        }
        for t in &self.transcodings {
            if t.is_hls() && !t.is_encrypted() && !t.is_mpeg() && !t.is_aac_160() {
                out.push(t.url.clone());
            }
        }
        out
    }

    /// Encrypted-HLS manifests for the PlayReady path. Only CENC (`ctr-`)
    /// works, and the real ones are mp4 - the `mpegurl` flavour 404s, so it
    /// is kept last as a fallback rather than dropped.
    fn drm_candidates(&self) -> Vec<String> {
        let mut out = Vec::new();
        for t in &self.transcodings {
            if t.is_cenc() && !t.is_mpeg_url() {
                out.push(t.url.clone());
            }
        }
        for t in &self.transcodings {
            if t.is_cenc() && t.is_mpeg_url() {
                out.push(t.url.clone());
            }
        }
        out
    }
}

impl UserDto {
    pub fn to_domain(&self) -> Artist {
        Artist {
            id: self.id.to_string(),
            handle: self.permalink.clone(),
            name: self.username.clone(),
            followers: self.followers_count,
            track_count: self.track_count,
            likes_count: self.likes_count,
            playlist_count: self.playlist_count,
            followings_count: self.followings_count,
            verified: self.verified,
            avatar_url: hi_res_artwork(self.avatar_url.as_deref()),
            ..Default::default()
        }
        .seal()
    }
}

impl PlaylistDto {
    pub fn to_domain(&self) -> Collection {
        Collection {
            id: self.id.clone(),
            title: self.title.clone(),
            subtitle: self.user.username.clone(),
            kind: if self.is_album || self.set_type.as_deref() == Some("album") {
                CollectionKind::Album
            } else {
                CollectionKind::Playlist
            },
            track_count: self.track_count,
            cover_url: hi_res_artwork(self.artwork_url.as_deref()),
            ..Default::default()
        }
        .seal()
    }
}

impl CommentDto {
    pub fn to_domain(&self) -> Comment {
        Comment {
            id: self.id.to_string(),
            author: self.user.username.clone(),
            timecode_ms: self.timestamp_ms,
            text: self.body.clone(),
            ..Default::default()
        }
        .seal()
    }
}

impl StreamItemDto {
    /// `None` for anything that is not a track post - playlist reposts and
    /// promoted entries share the `/stream` envelope.
    pub fn to_feed_post(&self) -> Option<FeedPost> {
        let t = self.track.as_ref()?;
        if !self.is_track() {
            return None;
        }
        Some(
            FeedPost {
                id: format!("{}-{}", t.id, self.kind),
                actor: self
                    .actor
                    .as_ref()
                    .map(|a| a.username.clone())
                    .unwrap_or_else(|| t.user.username.clone()),
                action: if self.is_repost() {
                    FeedAction::Reposted
                } else {
                    FeedAction::Posted
                },
                time_ago: relative_time(self.created_at.as_deref()),
                track: t.to_domain(),
                tag: match t.genre.as_deref() {
                    Some(g) if !g.is_empty() => g.to_string(),
                    _ => "music".into(),
                },
                comments: t.comment_count,
                action_label: String::new(),
                actor_seed: String::new(),
            }
            .seal(),
        )
    }
}

// Dart's `TrackListFeedMapper` (`List<Track>.toFeedPosts()`) is deliberately
// not ported: it was defined in `mappers.dart` but never called anywhere in
// the app, so carrying it over would only carry the dead code with it.

/// A track rendered as a card, used by the library shelves.
pub fn track_cards(tracks: &[Track]) -> Vec<Collection> {
    tracks
        .iter()
        .map(|t| {
            Collection {
                id: t.id.clone(),
                title: t.title.clone(),
                subtitle: t.artist.clone(),
                kind: CollectionKind::Playlist,
                target: CollectionTarget::Track,
                cover_url: t.cover_url.clone(),
                ..Default::default()
            }
            .seal()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::dto::TrackDto;
    use serde_json::json;

    #[test]
    fn artwork_upgrade_only_hits_the_size_token() {
        assert_eq!(
            hi_res_artwork(Some("https://i1.sndcdn.com/artworks-abc-large.jpg")).as_deref(),
            Some("https://i1.sndcdn.com/artworks-abc-t500x500.jpg")
        );
        // No size token: left untouched.
        assert_eq!(
            hi_res_artwork(Some("https://i1.sndcdn.com/x.jpg")).as_deref(),
            Some("https://i1.sndcdn.com/x.jpg")
        );
        assert_eq!(hi_res_artwork(None), None);
    }

    #[test]
    fn relative_time_buckets_and_survives_junk() {
        assert_eq!(relative_time(None), "");
        assert_eq!(relative_time(Some("not a date")), "");
        let two_days = (Utc::now() - chrono::Duration::days(2)).to_rfc3339();
        assert_eq!(relative_time(Some(&two_days)), "2 days ago");
        let ten_weeks = (Utc::now() - chrono::Duration::days(70)).to_rfc3339();
        assert_eq!(relative_time(Some(&ten_weeks)), "2 months ago");
        // Legacy SoundCloud stamp format.
        assert!(!relative_time(Some("2014/01/15 12:34:56 +0000")).is_empty());
    }

    #[test]
    fn a_track_without_a_cover_borrows_the_uploader_avatar() {
        let cover = |artwork: serde_json::Value, avatar: serde_json::Value| {
            TrackDto::from_json(&json!({
                "id": 7, "title": "t",
                "artwork_url": artwork,
                "user": { "id": 1, "username": "u", "permalink": "p", "avatar_url": avatar },
                "media": { "transcodings": [] }
            }))
            .to_domain()
            .cover_url
        };

        let art = json!("https://i1.sndcdn.com/artworks-a-large.jpg");
        let face = json!("https://i1.sndcdn.com/avatars-b-large.jpg");

        // Its own artwork wins, upgraded to the 500px cut as before.
        assert_eq!(
            cover(art.clone(), face.clone()).as_deref(),
            Some("https://i1.sndcdn.com/artworks-a-t500x500.jpg")
        );

        // Without one, the uploader stands in - upgraded the same way.
        assert_eq!(
            cover(json!(null), face.clone()).as_deref(),
            Some("https://i1.sndcdn.com/avatars-b-t500x500.jpg")
        );
        assert_eq!(
            cover(json!("   "), face).as_deref(),
            Some("https://i1.sndcdn.com/avatars-b-t500x500.jpg"),
            "a blank artwork url is not a cover"
        );

        // The stock silhouette is not worth having; the gradient is better.
        assert_eq!(
            cover(json!(null), json!("https://a1.sndcdn.com/images/default_avatar_large.png")),
            None
        );
        assert_eq!(cover(json!(null), json!(null)), None);
    }

    fn dto_with_transcodings(list: serde_json::Value) -> TrackDto {
        TrackDto::from_json(&json!({
            "id": 7, "title": "t",
            "user": { "id": 1, "username": "u", "permalink": "p" },
            "media": { "transcodings": list }
        }))
    }

    #[test]
    fn stream_candidates_lead_with_the_160k_aac_rendition() {
        let dto = dto_with_transcodings(json!([
            { "url": "hls-mpeg", "preset": "mp3_1_0",
              "format": { "protocol": "hls", "mime_type": "audio/mpeg" } },
            { "url": "prog", "preset": "mp3_0_0",
              "format": { "protocol": "progressive", "mime_type": "audio/mpeg" } },
            { "url": "hls-opus", "preset": "opus_0_0",
              "format": { "protocol": "hls", "mime_type": "audio/ogg" } },
            { "url": "hls-aac", "preset": "aac_160k",
              "format": { "protocol": "hls", "mime_type": "audio/mp4" } },
            { "url": "enc", "preset": "aac_160k",
              "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4" } }
        ]));
        let t = dto.to_domain();
        // 160k AAC, then the 128k MP3s (single file first), then the 72k opus.
        assert_eq!(t.stream_candidates, vec!["hls-aac", "prog", "hls-mpeg", "hls-opus"]);
        assert_eq!(t.stream_url(), Some("hls-aac"));
        // Encrypted variants never leak into the plain list.
        assert!(!t.stream_candidates.iter().any(|u| u == "enc"));
    }

    #[test]
    fn drm_candidates_prefer_mp4_over_the_decoy_mpegurl() {
        let dto = dto_with_transcodings(json!([
            { "url": "cenc-mpegurl", "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mpegurl" } },
            { "url": "cenc-mp4",     "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4" } },
            { "url": "cbcs",         "format": { "protocol": "cbc-encrypted-hls", "mime_type": "audio/mp4" } }
        ]));
        let t = dto.to_domain();
        assert_eq!(t.drm_candidates, vec!["cenc-mp4", "cenc-mpegurl"]);
        assert!(!t.drm_candidates.iter().any(|u| u == "cbcs"), "CBCS has no PlayReady header");
        assert_eq!(t.lock, TrackLock::Drm);
        assert!(!t.locked, "DRM routes to Shaka, it is not a wall");
    }

    #[test]
    fn go_plus_wins_over_drm_when_both_apply() {
        let dto = TrackDto::from_json(&json!({
            "id": 1, "policy": "SNIP",
            "media": { "transcodings": [
                { "url": "e", "format": { "protocol": "ctr-encrypted-hls", "mime_type": "audio/mp4" } }
            ]}
        }));
        let t = dto.to_domain();
        assert_eq!(t.lock, TrackLock::GoPlus);
        assert!(t.locked && t.go_plus);
    }

    #[test]
    fn feed_post_uses_actor_and_falls_back_to_the_uploader() {
        let repost = StreamItemDto::from_json(&json!({
            "type": "track-repost",
            "user": { "username": "reposter" },
            "track": { "id": 3, "title": "song", "genre": "house",
                       "user": { "username": "uploader" } }
        }));
        let p = repost.to_feed_post().expect("track reposts map to posts");
        assert_eq!(p.actor, "reposter");
        assert_eq!(p.action, FeedAction::Reposted);
        assert_eq!(p.action_label, "reposted a track");
        assert_eq!(p.id, "3-track-repost");
        assert_eq!(p.tag, "house");

        let bare = StreamItemDto::from_json(&json!({
            "type": "track", "track": { "id": 4, "user": { "username": "uploader" } }
        }));
        let p2 = bare.to_feed_post().unwrap();
        assert_eq!(p2.actor, "uploader", "no actor falls back to the uploader");
        assert_eq!(p2.tag, "music", "a missing genre becomes the music tag");

        // Playlist entries are dropped.
        let pl = StreamItemDto::from_json(&json!({ "type": "playlist", "playlist": { "id": 1 } }));
        assert!(pl.to_feed_post().is_none());
    }

    #[test]
    fn publisher_artist_overrides_the_uploader_name() {
        let dto = TrackDto::from_json(&json!({
            "id": 9, "title": "t",
            "publisher_metadata": { "artist": "Official Artist" },
            "user": { "username": "some-label", "permalink": "some-label" }
        }));
        let t = dto.to_domain();
        assert_eq!(t.artist, "Official Artist");
        // The handle still points at the uploader, so links keep working.
        assert_eq!(t.artist_handle, "some-label");
    }
}
