//! The SoundCloud v2 client. Port of `lib/core/api/http_soundcloud_api.dart`.
//!
//! Two rules carry over from the Dart original and explain most of the shape
//! here:
//!
//! * **A 401 means the anonymous `client_id` went stale**, not that the user
//!   is signed out. Every GET retries once behind a `ClientIdResolver::refresh`.
//! * **A failed section renders empty rather than failing the screen.** The
//!   home and library views stitch together six independent calls, and one
//!   dead endpoint should cost one shelf, not the page.

use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::{Mutex, RwLock};
use tracing::warn;

use crate::api::client_id::ClientIdResolver;
use crate::api::dto::{CommentDto, PageDto, PlaylistDto, StreamItemDto, TrackDto, UserDto};
use crate::api::mappers::{hi_res_artwork, track_cards};
use crate::core::json::{as_map, as_map_list, as_str, opt_str};
use crate::models::{
    Artist, ArtistProfile, Collection, CollectionKind, CollectionTarget, Comment, FeedPost,
    HomeData, LibraryData, LikeOutcome, LikesPage, PlaylistDetail, RailData, SearchResults, Shelf,
    Track, TrackDetail,
};

const BASE: &str = "https://api-v2.soundcloud.com";
const HYDRATE_BATCH: usize = 50;

const GENRES: [&str; 6] = [
    "all-music",
    "electronic",
    "house",
    "hiphoprap",
    "ambient",
    "indie",
];

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("http {status} for {path}")]
    Status { status: u16, path: String },
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
    #[error("{0}")]
    Other(String),
}

impl ApiError {
    fn status(&self) -> Option<u16> {
        match self {
            ApiError::Status { status, .. } => Some(*status),
            ApiError::Transport(e) => e.status().map(|s| s.as_u16()),
            ApiError::Other(_) => None,
        }
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;

/// The signed-in user's token, shared with the auth controller.
#[derive(Debug, Clone, Default)]
pub struct AuthState {
    pub user_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

impl AuthState {
    pub fn is_authenticated(&self) -> bool {
        self.user_token.as_deref().is_some_and(|t| !t.is_empty())
    }
}

pub struct SoundcloudApi {
    http: reqwest::Client,
    ids: Arc<ClientIdResolver>,
    auth: Arc<RwLock<AuthState>>,
    /// `None` = never fetched; `Some(None)` = fetched and unavailable.
    me_id: Mutex<Option<Option<String>>>,
}

impl SoundcloudApi {
    pub fn new(
        http: reqwest::Client,
        ids: Arc<ClientIdResolver>,
        auth: Arc<RwLock<AuthState>>,
    ) -> Self {
        Self {
            http,
            ids,
            auth,
            me_id: Mutex::new(None),
        }
    }

    /// Drops the memoised `/me` id. Must run on any sign-in or sign-out, or
    /// writes would be addressed to the previous account.
    pub async fn reset_identity(&self) {
        *self.me_id.lock().await = None;
    }

    async fn is_authed(&self) -> bool {
        self.auth.read().await.is_authenticated()
    }

    async fn token(&self) -> Option<String> {
        self.auth.read().await.user_token.clone()
    }

    // ---- transport -------------------------------------------------------

    async fn send(&self, url: &str, authed: bool) -> ApiResult<Value> {
        let once = |cid: String| async move {
            let mut req = self.http.get(url).query(&[("client_id", cid)]);
            if authed {
                if let Some(t) = self.token().await {
                    req = req.header("Authorization", format!("OAuth {t}"));
                }
            }
            let res = req.send().await?;
            let status = res.status();
            if !status.is_success() {
                return Err(ApiError::Status {
                    status: status.as_u16(),
                    path: url.to_string(),
                });
            }
            res.json::<Value>().await.map_err(ApiError::from)
        };

        let cid = self.client_id().await?;
        match once(cid).await {
            Err(e) if e.status() == Some(401) => {
                // The anonymous id expired; scrape a fresh one and retry once.
                let cid = self
                    .ids
                    .refresh()
                    .await
                    .map_err(|e| ApiError::Other(e.to_string()))?;
                once(cid).await
            }
            other => other,
        }
    }

    async fn client_id(&self) -> ApiResult<String> {
        self.ids
            .get()
            .await
            .map_err(|e| ApiError::Other(e.to_string()))
    }

    async fn get(&self, path: &str, query: &[(&str, String)], authed: bool) -> ApiResult<Value> {
        let mut url = format!("{BASE}{path}");
        if !query.is_empty() {
            let qs: Vec<String> = query
                .iter()
                .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
                .collect();
            url.push('?');
            url.push_str(&qs.join("&"));
        }
        self.send(&url, authed).await
    }

    /// Follows a `next_href` cursor, which already carries its own query.
    async fn get_url(&self, url: &str, authed: bool) -> ApiResult<Value> {
        self.send(url, authed).await
    }

    /// GET that sends the user's OAuth token when we have one, falling back to
    /// an anonymous request. Private and secret-link content 404s without it.
    async fn get_prefer_authed(&self, path: &str, query: &[(&str, String)]) -> ApiResult<Value> {
        if self.is_authed().await {
            match self.get(path, query, true).await {
                Ok(v) => return Ok(v),
                Err(e) => warn!("authed call failed, falling back to anonymous: {e}"),
            }
        }
        self.get(path, query, false).await
    }

    /// Runs `f` only when signed in, and swallows its failure into `fallback`.
    /// This is `_tryAuthed` with a constant anonymous branch, which is every
    /// call site but `get_prefer_authed`.
    async fn authed_or<T, F, Fut>(&self, f: F, fallback: T) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ApiResult<T>>,
    {
        if self.is_authed().await {
            match f().await {
                Ok(v) => return v,
                Err(e) => warn!("authed call failed, using the anonymous fallback: {e}"),
            }
        }
        fallback
    }

    /// A section that renders empty when it fails.
    async fn safe<T, F, Fut>(f: F, fallback: T) -> T
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ApiResult<T>>,
    {
        match f().await {
            Ok(v) => v,
            Err(e) => {
                warn!("section failed, rendering it empty: {e}");
                fallback
            }
        }
    }

    // ---- identity --------------------------------------------------------

    async fn me_id(&self) -> Option<String> {
        let mut slot = self.me_id.lock().await;
        if let Some(cached) = slot.as_ref() {
            return cached.clone();
        }
        let fetched = match self.get("/me", &[], true).await {
            Ok(v) => match v.get("id") {
                None | Some(Value::Null) => None,
                other => Some(as_str(other)),
            },
            Err(e) => {
                warn!("failed to resolve /me id: {e}");
                None
            }
        };
        *slot = Some(fetched.clone());
        fetched
    }

    async fn me_profile(&self) -> Option<Artist> {
        match self.get("/me", &[], true).await {
            Ok(v) => Some(UserDto::from_json(&v).to_domain()),
            Err(_) => None,
        }
    }

    // ---- collections -----------------------------------------------------

    /// Likes, reposts and history all wrap the track in an envelope; a plain
    /// track list does not. `j['track'] ?? j` covers both.
    fn parse_track_page(v: &Value) -> PageDto<Track> {
        let page = PageDto::parse(v, |j| {
            TrackDto::from_json(j.get("track").filter(|t| t.is_object()).unwrap_or(j))
        });
        PageDto {
            collection: page.collection.iter().map(|d| d.to_domain()).collect(),
            next_href: page.next_href,
        }
    }

    fn page_tracks(v: &Value) -> Vec<Track> {
        Self::parse_track_page(v).collection
    }

    fn page_playlists(v: &Value) -> Vec<Collection> {
        PageDto::parse(v, |j| {
            PlaylistDto::from_json(j.get("playlist").filter(|p| p.is_object()).unwrap_or(j))
        })
        .map_list(|d| d.to_domain())
    }

    async fn stream_tracks(&self, limit: i64) -> ApiResult<Vec<Track>> {
        let data = self.get("/stream", &[("limit", limit.to_string())], true).await?;
        Ok(PageDto::parse(&data, StreamItemDto::from_json)
            .collection
            .into_iter()
            .filter(|e| e.is_track() && e.track.is_some())
            .map(|e| e.track.unwrap().to_domain())
            .collect())
    }

    async fn mixed_shelves(&self) -> ApiResult<Vec<Shelf>> {
        let data = self
            .get("/mixed-selections", &[("limit", "12".into())], false)
            .await?;
        let mut shelves = Vec::new();
        for sel in as_map_list(data.get("collection")) {
            let items: Vec<Collection> = as_map_list(as_map(sel.get("items")).get("collection"))
                .into_iter()
                .filter(|m| m.get("title").is_some())
                .map(|m| {
                    let p = PlaylistDto::from_json(m);
                    Collection {
                        id: p.id.clone(),
                        title: p.title.clone(),
                        subtitle: if p.user.username.is_empty() {
                            "SoundCloud".into()
                        } else {
                            p.user.username.clone()
                        },
                        kind: if p.is_album {
                            CollectionKind::Album
                        } else {
                            CollectionKind::Playlist
                        },
                        cover_url: hi_res_artwork(p.artwork_url.as_deref()),
                        track_count: p.track_count,
                        ..Default::default()
                    }
                    .seal()
                })
                .collect();
            if !items.is_empty() {
                shelves.push(Shelf {
                    title: opt_str(sel.get("title"))
                        .unwrap_or_else(|| "selection".into())
                        .to_lowercase(),
                    items,
                });
            }
        }
        Ok(shelves)
    }

    async fn search_playlists(&self, genre: &str, albums: bool) -> ApiResult<Vec<Collection>> {
        let path = if albums { "/search/albums" } else { "/search/playlists" };
        let data = self
            .get(path, &[("q", genre.into()), ("limit", "12".into())], false)
            .await?;
        Ok(PageDto::parse(&data, PlaylistDto::from_json).map_list(|d| d.to_domain()))
    }

    async fn genre_stations(&self, genre: &str) -> ApiResult<Vec<Collection>> {
        let data = self
            .get(
                "/search/users",
                &[("q", genre.into()), ("limit", "10".into())],
                false,
            )
            .await?;
        Ok(PageDto::parse(&data, UserDto::from_json)
            .map_list(|u| Self::user_card(&u, "artist station")))
    }

    fn user_card(u: &UserDto, subtitle: &str) -> Collection {
        Collection {
            id: u.id.to_string(),
            title: u.username.clone(),
            subtitle: subtitle.into(),
            kind: CollectionKind::Station,
            target: CollectionTarget::Artist,
            handle: Some(u.permalink.clone()),
            cover_url: hi_res_artwork(u.avatar_url.as_deref()),
            ..Default::default()
        }
        .seal()
    }

    async fn me_likes(&self, limit: i64) -> ApiResult<Vec<Track>> {
        let Some(id) = self.me_id().await else {
            return Ok(Vec::new());
        };
        let data = self
            .get(
                &format!("/users/{id}/track_likes"),
                &[("limit", limit.to_string())],
                true,
            )
            .await?;
        Ok(Self::page_tracks(&data))
    }

    async fn me_playlists(&self) -> ApiResult<Vec<Collection>> {
        let Some(id) = self.me_id().await else {
            return Ok(Vec::new());
        };
        let data = self
            .get(
                &format!("/users/{id}/playlists_without_albums"),
                &[("limit", "40".into())],
                true,
            )
            .await?;
        Ok(Self::page_playlists(&data))
    }

    async fn me_followings(&self) -> ApiResult<Vec<Collection>> {
        let Some(id) = self.me_id().await else {
            return Ok(Vec::new());
        };
        let data = self
            .get(
                &format!("/users/{id}/followings"),
                &[("limit", "40".into())],
                true,
            )
            .await?;
        Ok(PageDto::parse(&data, UserDto::from_json)
            .map_list(|u| Self::user_card(&u, "following")))
    }

    async fn me_reposts(&self, limit: i64) -> ApiResult<Vec<Track>> {
        let Some(id) = self.me_id().await else {
            return Ok(Vec::new());
        };
        let data = self
            .get(
                &format!("/users/{id}/track_reposts"),
                &[("limit", limit.to_string())],
                true,
            )
            .await?;
        Ok(Self::page_tracks(&data))
    }

    async fn play_history(&self, limit: i64) -> ApiResult<Vec<Track>> {
        let data = self
            .get(
                "/me/play-history/tracks",
                &[("limit", limit.to_string())],
                true,
            )
            .await?;
        Ok(Self::page_tracks(&data))
    }

    // ---- public surface --------------------------------------------------

    pub async fn home(&self) -> HomeData {
        let stream = self.authed_or(|| self.stream_tracks(12), Vec::new()).await;

        let mut shelves = self.mixed_shelves().await.unwrap_or_default();
        if shelves.is_empty() {
            // The editorial endpoint is the good one; genre searches are the
            // consolation prize when it is unavailable.
            for g in GENRES.iter().skip(1).take(4) {
                shelves.push(Shelf {
                    title: (*g).to_string(),
                    items: self.search_playlists(g, false).await.unwrap_or_default(),
                });
            }
        }
        HomeData { stream, shelves }
    }

    pub async fn library(&self) -> LibraryData {
        let recently_played = Self::safe(
            || async {
                Ok(track_cards(
                    &self.authed_or(|| self.play_history(16), Vec::new()).await,
                ))
            },
            Vec::new(),
        )
        .await;

        let likes = Self::safe(
            || async {
                Ok(track_cards(
                    &self.authed_or(|| self.me_likes(50), Vec::new()).await,
                ))
            },
            Vec::new(),
        )
        .await;

        let playlists = Self::safe(
            || async { Ok(self.authed_or(|| self.me_playlists(), Vec::new()).await) },
            Vec::new(),
        )
        .await;

        let albums = Self::safe(|| self.search_playlists(GENRES[0], true), Vec::new()).await;
        let stations = Self::safe(|| self.genre_stations(GENRES[1]), Vec::new()).await;

        let following = Self::safe(
            || async { Ok(self.authed_or(|| self.me_followings(), Vec::new()).await) },
            Vec::new(),
        )
        .await;

        let history = Self::safe(
            || async { Ok(self.authed_or(|| self.play_history(12), Vec::new()).await) },
            Vec::new(),
        )
        .await;

        LibraryData {
            recently_played,
            likes,
            playlists,
            albums,
            stations,
            following,
            history,
        }
    }

    pub async fn feed(&self) -> Vec<FeedPost> {
        self.authed_or(
            || async {
                let data = self.get("/stream", &[("limit", "20".into())], true).await?;
                Ok(PageDto::parse(&data, StreamItemDto::from_json)
                    .collection
                    .iter()
                    .filter_map(StreamItemDto::to_feed_post)
                    .collect())
            },
            Vec::new(),
        )
        .await
    }

    pub async fn rail(&self) -> RailData {
        let me = if self.is_authed().await {
            self.me_profile().await
        } else {
            None
        };
        RailData {
            me,
            likes: self.authed_or(|| self.me_likes(6), Vec::new()).await,
            history: self.authed_or(|| self.play_history(12), Vec::new()).await,
        }
    }

    pub async fn track_detail(&self, id: &str) -> Result<TrackDetail> {
        // Bound before the join: a temporary built inside `join!` is dropped
        // at the end of the statement, while the futures still borrow it.
        let path = format!("/tracks/{id}");
        let (comments, related, raw) = tokio::join!(
            self.track_comments(id),
            self.track_related(id),
            self.get(&path, &[], false),
        );

        let dto = TrackDto::from_json(&raw.map_err(|e| anyhow::anyhow!(e.to_string()))?);
        let mut track = dto.to_domain();
        // The real waveform replaces the generated placeholder when it loads.
        if let Some(wave) = self.fetch_waveform_opt(dto.waveform_url.as_deref()).await {
            track.waveform = wave;
        }

        Ok(TrackDetail {
            track,
            comments,
            related,
        })
    }

    async fn track_comments(&self, id: &str) -> Vec<Comment> {
        match self
            .get(
                &format!("/tracks/{id}/comments"),
                &[
                    ("threaded", "0".into()),
                    ("filter_replies", "1".into()),
                    ("limit", "40".into()),
                ],
                false,
            )
            .await
        {
            Ok(data) => PageDto::parse(&data, CommentDto::from_json).map_list(|d| d.to_domain()),
            Err(e) => {
                warn!("comments failed for {id}: {e}");
                Vec::new()
            }
        }
    }

    async fn track_related(&self, id: &str) -> Vec<Track> {
        match self
            .get(&format!("/tracks/{id}/related"), &[("limit", "12".into())], false)
            .await
        {
            Ok(data) => PageDto::parse(&data, TrackDto::from_json).map_list(|d| d.to_domain()),
            Err(e) => {
                warn!("related failed for {id}: {e}");
                Vec::new()
            }
        }
    }

    pub async fn artist_profile(&self, handle: &str) -> Result<ArtistProfile> {
        let user = self.resolve_user(handle).await?;
        let tracks = match self
            .get(&format!("/users/{}/tracks", user.id), &[("limit", "20".into())], false)
            .await
        {
            Ok(data) => PageDto::parse(&data, TrackDto::from_json).map_list(|d| d.to_domain()),
            Err(e) => {
                warn!("artist tracks failed for {handle}: {e}");
                Vec::new()
            }
        };
        Ok(ArtistProfile {
            artist: user.to_domain(),
            tracks,
            albums: self.user_playlists(user.id, true).await,
            playlists: self.user_playlists(user.id, false).await,
        })
    }

    async fn resolve_user(&self, handle: &str) -> Result<UserDto> {
        let v = self
            .get(
                "/resolve",
                &[("url", format!("https://soundcloud.com/{handle}"))],
                false,
            )
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(UserDto::from_json(&v))
    }

    async fn user_playlists(&self, user_id: i64, albums: bool) -> Vec<Collection> {
        let path = if albums {
            format!("/users/{user_id}/albums")
        } else {
            format!("/users/{user_id}/playlists_without_albums")
        };
        match self.get(&path, &[("limit", "20".into())], false).await {
            Ok(data) => Self::page_playlists(&data),
            Err(e) => {
                warn!("user playlists ({path}) failed: {e}");
                Vec::new()
            }
        }
    }

    pub async fn search(&self, query: &str) -> SearchResults {
        let q = query.trim();
        if q.is_empty() {
            return SearchResults::default();
        }
        let track_q = [("q", q.to_string()), ("limit", "20".to_string())];
        let user_q = [("q", q.to_string()), ("limit", "15".to_string())];
        let playlist_q = [("q", q.to_string()), ("limit", "15".to_string())];
        let (tracks, users, playlists) = tokio::join!(
            self.get("/search/tracks", &track_q, false),
            self.get("/search/users", &user_q, false),
            self.get("/search/playlists", &playlist_q, false),
        );

        SearchResults {
            tracks: tracks
                .map(|d| PageDto::parse(&d, TrackDto::from_json).map_list(|x| x.to_domain()))
                .unwrap_or_default(),
            artists: users
                .map(|d| PageDto::parse(&d, UserDto::from_json).map_list(|u| u.to_domain()))
                .unwrap_or_default(),
            playlists: playlists
                .map(|d| PageDto::parse(&d, PlaylistDto::from_json).map_list(|x| x.to_domain()))
                .unwrap_or_default(),
        }
    }

    /// Curated "system" playlists use an opaque `soundcloud:playlists:123` id
    /// and live behind a different path.
    fn playlist_path(id: &str) -> String {
        if id.starts_with("soundcloud:") {
            format!("/system-playlists/{}", urlencoding::encode(id))
        } else {
            format!("/playlists/{id}")
        }
    }

    pub async fn playlist(&self, id: &str) -> Result<PlaylistDetail> {
        let raw = self
            .get_prefer_authed(&Self::playlist_path(id), &[])
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(PlaylistDetail {
            playlist: PlaylistDto::from_json(&raw).to_domain(),
            tracks: self.hydrate_tracks(as_map_list(raw.get("tracks"))).await,
        })
    }

    pub async fn all_playlist_tracks(&self, id: &str) -> Result<Vec<Track>> {
        let raw = self
            .get_prefer_authed(&Self::playlist_path(id), &[])
            .await
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(self.hydrate_tracks(as_map_list(raw.get("tracks"))).await)
    }

    /// A playlist payload inlines the first ~5 tracks and leaves the rest as
    /// bare `{id}` stubs. This fills them in via `/tracks?ids=` in batches of
    /// 50, then restores the playlist's own ordering.
    async fn hydrate_tracks(&self, tracks_json: Vec<&Value>) -> Vec<Track> {
        use std::collections::HashMap;

        let mut order: HashMap<String, usize> = HashMap::new();
        let mut by_id: HashMap<String, Track> = HashMap::new();
        let mut missing: Vec<String> = Vec::new();

        for (i, m) in tracks_json.iter().enumerate() {
            let tid = as_str(m.get("id"));
            if tid.is_empty() || tid == "0" {
                continue;
            }
            order.insert(tid.clone(), i);
            if m.get("title").is_some() {
                by_id.insert(tid, TrackDto::from_json(m).to_domain());
            } else {
                missing.push(tid);
            }
        }

        let batches: Vec<String> = missing
            .chunks(HYDRATE_BATCH)
            .map(|ids| ids.join(","))
            .collect();

        let fetched = futures_util::future::join_all(batches.into_iter().map(|ids| async move {
            match self.get_prefer_authed("/tracks", &[("ids", ids)]).await {
                Ok(Value::Array(a)) => a,
                Ok(_) => Vec::new(),
                Err(e) => {
                    warn!("playlist hydrate batch failed: {e}");
                    Vec::new()
                }
            }
        }))
        .await;

        for list in fetched {
            for m in list {
                if m.get("title").is_none() {
                    continue;
                }
                by_id.insert(as_str(m.get("id")), TrackDto::from_json(&m).to_domain());
            }
        }

        let mut ids: Vec<String> = by_id.keys().cloned().collect();
        ids.sort_by_key(|id| order.get(id).copied().unwrap_or(usize::MAX));
        ids.into_iter().filter_map(|id| by_id.remove(&id)).collect()
    }

    pub async fn history_page(&self, limit: i64, offset: i64) -> Vec<Track> {
        self.authed_or(
            || async {
                let data = self
                    .get(
                        "/me/play-history/tracks",
                        &[("limit", limit.to_string()), ("offset", offset.to_string())],
                        true,
                    )
                    .await?;
                Ok(Self::page_tracks(&data))
            },
            Vec::new(),
        )
        .await
    }

    pub async fn likes_page(&self, next_href: Option<&str>, limit: i64) -> LikesPage {
        self.authed_or(
            || async {
                let data = match next_href {
                    Some(href) => self.get_url(href, true).await?,
                    None => {
                        let Some(id) = self.me_id().await else {
                            return Ok(LikesPage::default());
                        };
                        self.get(
                            &format!("/users/{id}/track_likes"),
                            &[("limit", limit.to_string())],
                            true,
                        )
                        .await?
                    }
                };
                let page = Self::parse_track_page(&data);
                Ok(LikesPage {
                    tracks: page.collection,
                    next_href: page.next_href,
                })
            },
            LikesPage::default(),
        )
        .await
    }

    pub async fn reposted_track_ids(&self) -> Vec<String> {
        let tracks = self.authed_or(|| self.me_reposts(200), Vec::new()).await;
        tracks.into_iter().map(|t| t.id).collect()
    }

    // ---- waveform / stream resolution -----------------------------------

    pub async fn fetch_waveform(&self, url: &str) -> Option<Vec<f64>> {
        self.fetch_waveform_opt(Some(url)).await
    }

    /// Normalises SoundCloud's raw sample array to 0..1, with the same 0.04
    /// floor the renderer expects so silent passages still draw a hairline.
    async fn fetch_waveform_opt(&self, url: Option<&str>) -> Option<Vec<f64>> {
        let url = url?;
        let res = self.http.get(url).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let data: Value = res.json().await.ok()?;
        let samples: Vec<f64> = data
            .get("samples")?
            .as_array()?
            .iter()
            .filter_map(Value::as_f64)
            .collect();
        if samples.is_empty() {
            return None;
        }
        let max = samples.iter().cloned().fold(f64::MIN, f64::max);
        Some(
            samples
                .iter()
                .map(|s| if max == 0.0 { 0.04 } else { (s / max).clamp(0.04, 1.0) })
                .collect(),
        )
    }

    /// Turns a transcoding URL into a playable media URL. Returns `None` on
    /// any failure - the caller walks to the next candidate.
    pub async fn resolve_stream_url(&self, transcoding_url: &str) -> Option<String> {
        let res = self.send(transcoding_url, false).await.ok()?;
        opt_str(res.get("url")).filter(|u| !u.is_empty())
    }

    /// Maps a soundcloud.com link to an in-app route.
    pub async fn resolve_url(&self, url: &str) -> Option<String> {
        let mut u = url.trim().to_string();
        if u.is_empty() {
            return None;
        }
        if !u.starts_with("http") && u.starts_with("soundcloud.com") {
            u = format!("https://{u}");
        }

        let data = match self.get("/resolve", &[("url", u.clone())], false).await {
            Ok(v) => v,
            Err(e) => {
                warn!("resolveUrl failed: {u}: {e}");
                return None;
            }
        };

        match data.get("kind").and_then(Value::as_str) {
            Some("track") => Some(format!("/track/{}", as_str(data.get("id")))),
            Some("playlist") | Some("system-playlist") => Some(format!(
                "/playlist/{}",
                urlencoding::encode(&as_str(data.get("id")))
            )),
            Some("user") => opt_str(data.get("permalink"))
                .filter(|p| !p.is_empty())
                .map(|p| format!("/artist/{}", urlencoding::encode(&p))),
            _ => None,
        }
    }

    pub async fn verify_token(&self, token: &str) -> bool {
        let Ok(cid) = self.client_id().await else {
            return false;
        };
        let Ok(res) = self
            .http
            .get(format!("{BASE}/me"))
            .query(&[("client_id", cid)])
            .header("Authorization", format!("OAuth {token}"))
            .send()
            .await
        else {
            return false;
        };
        if !res.status().is_success() {
            return false;
        }
        res.json::<Value>()
            .await
            .map(|v| !matches!(v.get("id"), None | Some(Value::Null)))
            .unwrap_or(false)
    }

    // ---- writes ----------------------------------------------------------

    pub async fn set_liked(&self, track_id: &str, liked: bool) -> LikeOutcome {
        self.write_for_me(liked, "track_likes", track_id).await
    }

    pub async fn set_reposted(&self, track_id: &str, reposted: bool) -> LikeOutcome {
        self.write_for_me(reposted, "track_reposts", track_id).await
    }

    async fn write_for_me(&self, on: bool, collection: &str, track_id: &str) -> LikeOutcome {
        if !self.is_authed().await {
            return LikeOutcome::Failed;
        }
        let Some(id) = self.me_id().await else {
            return LikeOutcome::Failed;
        };
        let method = if on { "PUT" } else { "DELETE" };
        self.write_outcome(method, &format!("/users/{id}/{collection}/{track_id}"))
            .await
    }

    /// `Blocked` is kept distinct from `Failed` so the UI can say "SoundCloud
    /// refused this" rather than blaming the network - 429 in particular is a
    /// rate limit the user should just wait out.
    async fn write_outcome(&self, method: &str, path: &str) -> LikeOutcome {
        let Ok(cid) = self.client_id().await else {
            return LikeOutcome::Failed;
        };
        let m = match reqwest::Method::from_bytes(method.as_bytes()) {
            Ok(m) => m,
            Err(_) => return LikeOutcome::Failed,
        };

        let mut req = self
            .http
            .request(m, format!("{BASE}{path}"))
            .query(&[("client_id", cid)]);
        if let Some(t) = self.token().await {
            req = req.header("Authorization", format!("OAuth {t}"));
        }

        match req.send().await {
            Ok(res) => {
                let code = res.status().as_u16();
                match code {
                    200 | 201 => LikeOutcome::Ok,
                    401 | 403 | 429 => LikeOutcome::Blocked,
                    _ => {
                        warn!("{method} {path} failed with {code}");
                        LikeOutcome::Failed
                    }
                }
            }
            Err(e) => {
                warn!("{method} {path} failed: {e}");
                LikeOutcome::Failed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn system_playlists_use_their_own_path_and_are_encoded() {
        assert_eq!(SoundcloudApi::playlist_path("12345"), "/playlists/12345");
        assert_eq!(
            SoundcloudApi::playlist_path("soundcloud:playlists:987"),
            "/system-playlists/soundcloud%3Aplaylists%3A987"
        );
    }

    #[test]
    fn page_tracks_unwraps_the_like_envelope_and_plain_lists_alike() {
        let wrapped = json!({ "collection": [
            { "created_at": "x", "track": { "id": 1, "title": "wrapped" } }
        ]});
        let got = SoundcloudApi::page_tracks(&wrapped);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "wrapped");

        let plain = json!({ "collection": [ { "id": 2, "title": "plain" } ] });
        assert_eq!(SoundcloudApi::page_tracks(&plain)[0].title, "plain");

        // A null `track` key must fall through to the entry itself.
        let nulled = json!({ "collection": [ { "id": 3, "title": "n", "track": null } ] });
        assert_eq!(SoundcloudApi::page_tracks(&nulled)[0].title, "n");
    }

    #[test]
    fn page_playlists_unwraps_the_playlist_envelope() {
        let wrapped = json!({ "collection": [
            { "playlist": { "id": 5, "title": "set", "user": { "username": "u" } } }
        ]});
        let got = SoundcloudApi::page_playlists(&wrapped);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "set");
        assert_eq!(got[0].id, "5");
    }

    #[test]
    fn user_card_is_a_circular_artist_target() {
        let u = UserDto::from_json(&json!({
            "id": 9, "username": "DJ", "permalink": "dj",
            "avatar_url": "https://i1.sndcdn.com/a-large.jpg"
        }));
        let c = SoundcloudApi::user_card(&u, "following");
        assert_eq!(c.target, CollectionTarget::Artist);
        assert_eq!(c.handle.as_deref(), Some("dj"));
        assert!(c.is_circular, "artist cards render round");
        assert_eq!(c.cover_url.as_deref(), Some("https://i1.sndcdn.com/a-t500x500.jpg"));
    }

    #[test]
    fn api_error_exposes_the_status_for_the_401_retry() {
        let e = ApiError::Status { status: 401, path: "/me".into() };
        assert_eq!(e.status(), Some(401));
        assert_eq!(ApiError::Other("x".into()).status(), None);
    }

    #[test]
    fn auth_state_treats_an_empty_token_as_signed_out() {
        assert!(!AuthState::default().is_authenticated());
        let empty = AuthState { user_token: Some(String::new()), ..Default::default() };
        assert!(!empty.is_authenticated());
        let real = AuthState { user_token: Some("t".into()), ..Default::default() };
        assert!(real.is_authenticated());
    }
}
