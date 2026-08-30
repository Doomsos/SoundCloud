//! The IPC surface the webview calls. Every function here is the Rust half of
//! a `invoke("name", ...)` in `src/api/client.ts`.
//!
//! Commands return `Result<T, String>` because Tauri needs a serialisable
//! error. Calls that the Dart build treated as best-effort - a failed section,
//! an unresolvable stream - keep returning `Ok` with an empty or `None` value
//! rather than surfacing an error the UI has no way to act on.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use tauri_plugin_opener::OpenerExt;

use crate::api::auth;
use crate::core::cache::CachedDrmStream;
use crate::core::lastfm::{is_configured as lastfm_is_configured, LastfmClient, LastfmSession, ScrobbleGate};
use crate::core::log::LogEntry;
use crate::core::storage::StoredToken;
use crate::models::*;
use crate::state::AppState;

type Cmd<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- api reads

#[tauri::command]
pub async fn api_home(state: State<'_, AppState>) -> Cmd<HomeData> {
    Ok(state.api.home().await)
}

#[tauri::command]
pub async fn api_library(state: State<'_, AppState>) -> Cmd<LibraryData> {
    Ok(state.api.library().await)
}

#[tauri::command]
pub async fn api_feed(state: State<'_, AppState>) -> Cmd<Vec<FeedPost>> {
    Ok(state.api.feed().await)
}

#[tauri::command]
pub async fn api_rail(state: State<'_, AppState>) -> Cmd<RailData> {
    Ok(state.api.rail().await)
}

#[tauri::command]
pub async fn api_track_detail(state: State<'_, AppState>, id: String) -> Cmd<TrackDetail> {
    state.api.track_detail(&id).await.map_err(err)
}

#[tauri::command]
pub async fn api_artist_profile(state: State<'_, AppState>, handle: String) -> Cmd<ArtistProfile> {
    state.api.artist_profile(&handle).await.map_err(err)
}

#[tauri::command]
pub async fn api_search(state: State<'_, AppState>, query: String) -> Cmd<SearchResults> {
    Ok(state.api.search(&query).await)
}

#[tauri::command]
pub async fn api_playlist(state: State<'_, AppState>, id: String) -> Cmd<PlaylistDetail> {
    state.api.playlist(&id).await.map_err(err)
}

#[tauri::command]
pub async fn api_all_playlist_tracks(state: State<'_, AppState>, id: String) -> Cmd<Vec<Track>> {
    state.api.all_playlist_tracks(&id).await.map_err(err)
}

#[tauri::command]
pub async fn api_history_page(
    state: State<'_, AppState>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Cmd<Vec<Track>> {
    Ok(state
        .api
        .history_page(limit.unwrap_or(50), offset.unwrap_or(0))
        .await)
}

#[tauri::command]
pub async fn api_likes_page(
    state: State<'_, AppState>,
    next_href: Option<String>,
    limit: Option<i64>,
) -> Cmd<LikesPage> {
    Ok(state
        .api
        .likes_page(next_href.as_deref(), limit.unwrap_or(50))
        .await)
}

#[tauri::command]
pub async fn api_reposted_track_ids(state: State<'_, AppState>) -> Cmd<Vec<String>> {
    Ok(state.api.reposted_track_ids().await)
}

#[tauri::command]
pub async fn api_fetch_waveform(state: State<'_, AppState>, url: String) -> Cmd<Option<Vec<f64>>> {
    Ok(state.api.fetch_waveform(&url).await)
}

/// `None` means this candidate is dead and the player should try the next one.
#[tauri::command]
pub async fn api_resolve_stream_url(
    state: State<'_, AppState>,
    transcoding_url: String,
) -> Cmd<Option<String>> {
    Ok(state.api.resolve_stream_url(&transcoding_url).await)
}

#[tauri::command]
pub async fn api_resolve_url(state: State<'_, AppState>, url: String) -> Cmd<Option<String>> {
    Ok(state.api.resolve_url(&url).await)
}

/// The scraped anonymous `client_id`. The DRM engine needs it in the browser,
/// because Shaka has to sign its PlayReady licence requests with it.
///
/// Distinct from `auth_get_client_id`, which is the *OAuth application* id
/// used for the browser sign-in - the two are unrelated despite the name.
#[tauri::command]
pub async fn api_anon_client_id(state: State<'_, AppState>) -> Cmd<String> {
    state.ids.get().await.map_err(err)
}

// --------------------------------------------------------------- api writes

#[tauri::command]
pub async fn api_set_liked(
    state: State<'_, AppState>,
    track_id: String,
    liked: bool,
) -> Cmd<LikeOutcome> {
    Ok(state.api.set_liked(&track_id, liked).await)
}

#[tauri::command]
pub async fn api_set_reposted(
    state: State<'_, AppState>,
    track_id: String,
    reposted: bool,
) -> Cmd<LikeOutcome> {
    Ok(state.api.set_reposted(&track_id, reposted).await)
}

// -------------------------------------------------------------------- auth

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
    /// Whether an OAuth app client id is available at all - without one the
    /// browser sign-in cannot start.
    pub has_client_id: bool,
    /// True when the build carries its own id and the user is never asked.
    pub compiled_in: bool,
}

async fn status(state: &AppState) -> AuthStatus {
    AuthStatus {
        authenticated: state.is_authenticated().await,
        has_client_id: !auth::client_id(&state.prefs).await.is_empty(),
        compiled_in: auth::is_compiled_in(),
    }
}

#[tauri::command]
pub async fn auth_status(state: State<'_, AppState>) -> Cmd<AuthStatus> {
    Ok(status(&state).await)
}

#[tauri::command]
pub async fn auth_restore(state: State<'_, AppState>) -> Cmd<AuthStatus> {
    state.restore_auth().await;
    Ok(status(&state).await)
}

/// Runs the full PKCE browser flow and stores the tokens on success.
#[tauri::command]
pub async fn auth_sign_in(app: AppHandle, state: State<'_, AppState>) -> Cmd<AuthStatus> {
    let opener = app.clone();
    let tokens = auth::sign_in(&state.http, state.prefs.clone(), move |url| async move {
        opener
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| anyhow::anyhow!("could not open the browser: {e}"))
    })
    .await
    .map_err(err)?;

    state
        .sign_in(StoredToken {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: tokens.expires_at,
        })
        .await
        .map_err(err)?;

    Ok(status(&state).await)
}

/// The paste-a-token escape hatch from the sign-in dialog. The token is
/// verified against `/me` before it is stored, so a typo fails loudly here
/// instead of silently breaking every later call.
#[tauri::command]
pub async fn auth_sign_in_with_token(state: State<'_, AppState>, token: String) -> Cmd<AuthStatus> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("paste a token first".into());
    }
    if !state.api.verify_token(&token).await {
        return Err("SoundCloud rejected that token".into());
    }
    state
        .sign_in(StoredToken::new(token))
        .await
        .map_err(err)?;
    Ok(status(&state).await)
}

#[tauri::command]
pub async fn auth_sign_out(state: State<'_, AppState>) -> Cmd<AuthStatus> {
    state.sign_out().await;
    Ok(status(&state).await)
}

#[tauri::command]
pub async fn auth_verify_token(state: State<'_, AppState>, token: String) -> Cmd<bool> {
    Ok(state.api.verify_token(&token).await)
}

#[tauri::command]
pub async fn auth_get_client_id(state: State<'_, AppState>) -> Cmd<String> {
    Ok(auth::client_id(&state.prefs).await)
}

#[tauri::command]
pub async fn auth_save_client_id(state: State<'_, AppState>, id: String) -> Cmd<()> {
    auth::save_client_id(&state.prefs, &id).await.map_err(err)
}

// ------------------------------------------------------------------- prefs

#[tauri::command]
pub async fn prefs_get_string(state: State<'_, AppState>, key: String) -> Cmd<Option<String>> {
    Ok(state.prefs.read_string(&key).await)
}

#[tauri::command]
pub async fn prefs_set_string(state: State<'_, AppState>, key: String, value: String) -> Cmd<()> {
    state.prefs.write_string(&key, &value).await.map_err(err)
}

#[tauri::command]
pub async fn prefs_get_bool(state: State<'_, AppState>, key: String) -> Cmd<Option<bool>> {
    Ok(state.prefs.read_bool(&key).await)
}

#[tauri::command]
pub async fn prefs_set_bool(state: State<'_, AppState>, key: String, value: bool) -> Cmd<()> {
    state.prefs.write_bool(&key, value).await.map_err(err)
}

#[tauri::command]
pub async fn prefs_get_int(state: State<'_, AppState>, key: String) -> Cmd<Option<i64>> {
    Ok(state.prefs.read_i64(&key).await)
}

#[tauri::command]
pub async fn prefs_set_int(state: State<'_, AppState>, key: String, value: i64) -> Cmd<()> {
    state.prefs.write_i64(&key, value).await.map_err(err)
}

#[tauri::command]
pub async fn prefs_remove(state: State<'_, AppState>, key: String) -> Cmd<()> {
    state.prefs.remove(&key).await.map_err(err)
}

// ------------------------------------------------------------------- cache

/// The absolute path of the cached file, if the track is already on disk. The
/// frontend turns it into a playable URL with Tauri's `convertFileSrc`.
#[tauri::command]
pub async fn cache_hit(state: State<'_, AppState>, track_id: String) -> Cmd<Option<String>> {
    Ok(state
        .cache
        .hit(&track_id)
        .await
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Fire-and-forget: the download runs behind playback, and the caller does not
/// wait for it. This is the `unawaited(cache.store(...))` of the Dart build.
#[tauri::command]
pub async fn cache_store(state: State<'_, AppState>, track_id: String, url: String) -> Cmd<()> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = cache.store(&track_id, &url).await {
            tracing::warn!("caching {track_id} failed: {e}");
        }
    });
    Ok(())
}

/// Drops a cached copy that turned out not to play, so the next play of this
/// track goes straight to the network instead of failing over again.
#[tauri::command]
pub async fn cache_forget(state: State<'_, AppState>, track_id: String) -> Cmd<()> {
    state.cache.forget(&track_id).await;
    Ok(())
}

#[tauri::command]
pub async fn cache_size(state: State<'_, AppState>) -> Cmd<u64> {
    Ok(state.cache.size().await)
}

#[tauri::command]
pub async fn cache_trim(state: State<'_, AppState>) -> Cmd<()> {
    state.cache.trim().await.map_err(err)
}

#[tauri::command]
pub async fn cache_clear(state: State<'_, AppState>) -> Cmd<()> {
    state.cache.clear().await.map_err(err)
}

/// The cached encrypted stream for `track_id`, or `None`. The manifest comes
/// back with `wf-local:<n>` placeholders because only the webview can spell an
/// asset-protocol URL; `localiseManifest` on the frontend fills them in.
#[tauri::command]
pub async fn cache_hit_drm(
    state: State<'_, AppState>,
    track_id: String,
) -> Cmd<Option<CachedDrmStream>> {
    Ok(state.cache.hit_drm(&track_id).await)
}

/// Fire-and-forget, exactly like `cache_store`: the encrypted segments come
/// down behind playback so the next play of this track starts from disk. The
/// bytes are never decrypted - a licence is still fetched on every play.
#[tauri::command]
pub async fn cache_store_drm(
    state: State<'_, AppState>,
    track_id: String,
    manifest_url: String,
) -> Cmd<()> {
    let cache = state.cache.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = cache.store_drm(&track_id, &manifest_url).await {
            tracing::warn!("caching encrypted {track_id} failed: {e}");
        }
    });
    Ok(())
}

/// Where prefs, the token and the audio cache live. Shown in settings so the
/// folder can be found without guessing at the platform convention.
#[tauri::command]
pub async fn app_data_dir(state: State<'_, AppState>) -> Cmd<String> {
    Ok(state.data_dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn reveal_data_dir(app: AppHandle, state: State<'_, AppState>) -> Cmd<()> {
    app.opener()
        .open_path(state.data_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(err)
}

// -------------------------------------------------------------------- logs

#[tauri::command]
pub async fn logs_snapshot(state: State<'_, AppState>) -> Cmd<Vec<LogEntry>> {
    Ok(state.logs.snapshot())
}

#[tauri::command]
pub async fn logs_clear(state: State<'_, AppState>) -> Cmd<()> {
    state.logs.clear();
    Ok(())
}

/// Lets the frontend write into the same history the Rust side uses, so the
/// logs view shows one interleaved stream rather than two.
#[tauri::command]
pub async fn log_write(
    state: State<'_, AppState>,
    level: String,
    target: String,
    message: String,
) -> Cmd<()> {
    state.logs.push(LogEntry {
        at: chrono::Utc::now().timestamp_millis(),
        level,
        target,
        message,
    });
    Ok(())
}

// ------------------------------------------------------------------ lastfm

const LASTFM_KEY: &str = "lastfm_session_key";
const LASTFM_NAME: &str = "lastfm_username";

/// Holds the scrobble timing state between player ticks.
pub struct ScrobbleState(pub Mutex<ScrobbleGate>);

#[tauri::command]
pub async fn lastfm_configured() -> Cmd<bool> {
    Ok(lastfm_is_configured())
}

#[tauri::command]
pub async fn lastfm_session(state: State<'_, AppState>) -> Cmd<Option<LastfmSession>> {
    let key = state.prefs.read_string(LASTFM_KEY).await;
    let name = state.prefs.read_string(LASTFM_NAME).await;
    Ok(match (key, name) {
        (Some(k), Some(n)) if !k.is_empty() => Some(LastfmSession { key: k, name: n }),
        _ => None,
    })
}

/// Step one: fetch a request token and send the user to last.fm to approve it.
#[tauri::command]
pub async fn lastfm_begin_auth(app: AppHandle, state: State<'_, AppState>) -> Cmd<String> {
    let token = state
        .lastfm
        .get_auth_token()
        .await
        .map_err(err)?
        .ok_or("last.fm is not configured in this build")?;
    let url = LastfmClient::auth_url(&token).map_err(err)?;
    app.opener().open_url(url, None::<&str>).map_err(err)?;
    Ok(token)
}

/// Step two, once the user has approved: trade the token for a session key.
#[tauri::command]
pub async fn lastfm_complete_auth(
    state: State<'_, AppState>,
    token: String,
) -> Cmd<Option<LastfmSession>> {
    let session = state.lastfm.get_session(&token).await.map_err(err)?;
    if let Some(s) = &session {
        state.prefs.write_string(LASTFM_KEY, &s.key).await.map_err(err)?;
        state.prefs.write_string(LASTFM_NAME, &s.name).await.map_err(err)?;
    }
    Ok(session)
}

#[tauri::command]
pub async fn lastfm_sign_out(state: State<'_, AppState>) -> Cmd<()> {
    state.prefs.remove(LASTFM_KEY).await.map_err(err)?;
    state.prefs.remove(LASTFM_NAME).await.map_err(err)
}

/// One player tick. The gate decides whether a now-playing update or a
/// scrobble is due, so the timing rules stay in one tested place instead of
/// being re-derived in the UI.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn lastfm_tick(
    state: State<'_, AppState>,
    gate: State<'_, ScrobbleState>,
    track_id: Option<String>,
    artist: String,
    title: String,
    is_playing: bool,
    position_ms: i64,
    duration_ms: i64,
    elapsed_secs: i64,
    started_at_unix: i64,
) -> Cmd<()> {
    if !lastfm_is_configured() {
        return Ok(());
    }
    let Some(session) = lastfm_session(state.clone()).await? else {
        return Ok(());
    };

    let decision = {
        let mut g = gate.0.lock().await;
        g.observe(
            track_id.as_deref(),
            is_playing,
            position_ms,
            duration_ms,
            elapsed_secs,
        )
    };

    let client: Arc<LastfmClient> = state.lastfm.clone();
    let secs = duration_ms / 1000;

    if decision.send_now_playing {
        if let Err(e) = client
            .update_now_playing(&artist, &title, secs, None, &session.key)
            .await
        {
            tracing::warn!("lastfm nowPlaying failed: {e}");
        }
    }
    if decision.send_scrobble {
        match client
            .scrobble(&artist, &title, started_at_unix, Some(secs), None, &session.key)
            .await
        {
            Ok(()) => tracing::info!("lastfm scrobbled: {artist} - {title}"),
            Err(e) => tracing::warn!("lastfm scrobble failed: {e}"),
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ window

/// Closing hides to the tray so playback survives; the tray menu has the real
/// quit. This is the explicit exit path.
#[tauri::command]
pub async fn app_quit(app: AppHandle) -> Cmd<()> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn window_hide_to_tray(app: AppHandle) -> Cmd<()> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn window_show(app: AppHandle) -> Cmd<()> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(err)?;
        // Hidden and minimised are different states; the tray card has to
        // recover from both.
        w.unminimize().map_err(err)?;
        w.set_focus().map_err(err)?;
    }
    // Raising the app dismisses the card that raised it.
    if let Some(popup) = app.get_webview_window("tray-popup") {
        popup.hide().ok();
    }
    Ok(())
}

/// Mirrors the playing track into the tray tooltip, as `_syncTooltip` did:
/// title and artist on two lines, or the app name when nothing is playing.
#[tauri::command]
pub async fn tray_set_tooltip(app: AppHandle, title: String, artist: String) -> Cmd<()> {
    let text = if title.is_empty() {
        "SoundCloud".to_string()
    } else {
        format!("{}\n{}", clip(&title), clip(&artist))
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_tooltip(Some(text)).map_err(err)?;
    }
    Ok(())
}

/// Tooltips have no room for a long title.
fn clip(s: &str) -> String {
    const MAX: usize = 60;
    if s.chars().count() <= MAX {
        return s.to_string();
    }
    let head: String = s.chars().take(MAX - 1).collect();
    format!("{head}…")
}

/// Mirrors the played track into the window title, as the Dart shell did.
#[tauri::command]
pub async fn window_set_title(app: AppHandle, title: String) -> Cmd<()> {
    if let Some(w) = app.get_webview_window("main") {
        w.set_title(&title).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Cmd<()> {
    app.opener().open_url(url, None::<&str>).map_err(err)
}

/// Opens soundcloud.com in an app-owned webview so the user can clear a
/// captcha or bot check. Port of `webview_verification.dart`.
///
/// When SoundCloud starts answering writes with 401/403/429 it is usually a
/// challenge rather than a real permission problem, and it clears once the
/// challenge is solved in a browser session.
#[tauri::command]
pub async fn open_verification_window(app: AppHandle) -> Cmd<()> {
    if let Some(w) = app.get_webview_window("verify") {
        w.show().map_err(err)?;
        w.set_focus().map_err(err)?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "verify",
        tauri::WebviewUrl::External(
            "https://soundcloud.com".parse().map_err(|e| format!("{e}"))?,
        ),
    )
    .title("Verify on SoundCloud")
    .inner_size(980.0, 760.0)
    .build()
    .map_err(err)?;
    Ok(())
}
