//! App assembly: logging, state, tray, window lifecycle, command registration.
//!
//! Two behaviours from the Flutter build are load-bearing and reproduced here:
//!
//! * **Closing the window hides it.** Playback lives in the webview, so
//!   destroying the window would stop the music; the tray card holds the real
//!   quit. This was `windowManager.setPreventClose(true)`.
//! * **The tray card is a second window, and the tray has no menu.** The Dart
//!   build ran a whole extra Flutter engine for the card and pushed JSON
//!   strings over a native channel; here it is another webview on the `#/tray`
//!   route, and Tauri's event bus carries state to it directly. Either mouse
//!   button raises it, exactly as `tray_controller.dart` did.

mod api;
mod commands;
mod core;
mod models;
mod state;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::core::log::{HistoryLayer, LogHistory};
use crate::state::AppState;

/// Size of the tray card. Fixed - it is not resizable, and the positioning
/// maths needs the same numbers the window is built with.
const TRAY_POPUP: (f64, f64) = (260.0, 290.0);
/// Gap between the card and the edges of the work area.
const TRAY_MARGIN: f64 = 12.0;

/// Debounce for tray clicks. A click that raises the card also blurs it, and
/// without these the card would hide and immediately reopen. Ported from the
/// `_lastToggle` / `_lastDismissed` guards in `tray_controller.dart`.
const TOGGLE_DEBOUNCE: Duration = Duration::from_millis(250);
const DISMISS_DEBOUNCE: Duration = Duration::from_millis(400);

struct TrayTiming {
    last_toggle: Instant,
    last_dismissed: Instant,
}

static TRAY_TIMING: Lazy<Mutex<TrayTiming>> = Lazy::new(|| {
    // Far enough in the past that the first click is never swallowed.
    let long_ago = Instant::now() - Duration::from_secs(60);
    Mutex::new(TrayTiming {
        last_toggle: long_ago,
        last_dismissed: long_ago,
    })
});

/// Where the Flutter build kept its state, so a sign-in carries over.
#[cfg(target_os = "windows")]
fn legacy_data_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("APPDATA")
        .map(|a| std::path::PathBuf::from(a).join("SoundCloud Desktop").join("SoundCloud Desktop"))
}

#[cfg(not(target_os = "windows"))]
fn legacy_data_dir() -> Option<std::path::PathBuf> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let history = LogHistory::new();

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(HistoryLayer(history.clone()))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(commands::ScrobbleState(Default::default()))
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();

            let state = AppState::new(data_dir, history.clone())?;

            // Adopt a Flutter-era token before anything reads the auth state.
            if let Some(legacy) = legacy_data_dir() {
                let tokens = state.tokens.clone();
                tauri::async_runtime::block_on(async move {
                    if tokens.migrate_from(&legacy).await {
                        tracing::info!("auth: adopted the token from the Flutter build");
                    }
                });
            }

            tauri::async_runtime::block_on(state.restore_auth());
            app.manage(state);

            build_tray(app.handle())?;

            // In a packaged build the installer registers `soundcloud://`; in
            // dev nothing has, so ask for it at runtime. Failure is not fatal
            // - it only means deep links will not arrive this session.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    tracing::info!("deep links unavailable: {e}");
                }
            }

            // The window is created hidden so the first paint is the real UI
            // rather than a white flash.
            if let Some(w) = app.get_webview_window("main") {
                w.show().ok();
                w.set_focus().ok();
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" || window.label() == "tray-popup" {
                    // Hide instead of closing: the tray owns quitting, and the
                    // card is dismissed rather than destroyed so the next
                    // click does not pay for a cold start.
                    api.prevent_close();
                    window.hide().ok();
                }
            }
            // Click-away dismisses the card. Doing it here rather than in the
            // webview keeps the dismiss timestamp next to the click debounce,
            // which is what stops a tray click from hiding and reopening it.
            tauri::WindowEvent::Focused(false) if window.label() == "tray-popup" => {
                window.hide().ok();
                if let Ok(mut t) = TRAY_TIMING.lock() {
                    t.last_dismissed = Instant::now();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::api_home,
            commands::api_library,
            commands::api_feed,
            commands::api_rail,
            commands::api_track_detail,
            commands::api_artist_profile,
            commands::api_search,
            commands::api_playlist,
            commands::api_all_playlist_tracks,
            commands::api_history_page,
            commands::api_likes_page,
            commands::api_reposted_track_ids,
            commands::api_fetch_waveform,
            commands::api_resolve_stream_url,
            commands::api_resolve_url,
            commands::api_anon_client_id,
            commands::api_set_liked,
            commands::api_set_reposted,
            commands::auth_status,
            commands::auth_restore,
            commands::auth_sign_in,
            commands::auth_sign_in_with_token,
            commands::auth_sign_out,
            commands::auth_verify_token,
            commands::auth_get_client_id,
            commands::auth_save_client_id,
            commands::prefs_get_string,
            commands::prefs_set_string,
            commands::prefs_get_bool,
            commands::prefs_set_bool,
            commands::prefs_get_int,
            commands::prefs_set_int,
            commands::prefs_remove,
            commands::cache_hit,
            commands::cache_store,
            commands::cache_hit_drm,
            commands::cache_store_drm,
            commands::cache_forget,
            commands::cache_size,
            commands::cache_trim,
            commands::cache_clear,
            commands::app_data_dir,
            commands::reveal_data_dir,
            commands::logs_snapshot,
            commands::logs_clear,
            commands::log_write,
            commands::lastfm_configured,
            commands::lastfm_session,
            commands::lastfm_begin_auth,
            commands::lastfm_complete_auth,
            commands::lastfm_sign_out,
            commands::lastfm_tick,
            commands::app_quit,
            commands::window_hide_to_tray,
            commands::window_show,
            commands::window_set_title,
            commands::tray_set_tooltip,
            commands::open_external,
            commands::open_verification_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}

/// Installs the tray icon.
///
/// There is deliberately **no context menu**. In the Flutter build both
/// `onTrayIconMouseDown` and `onTrayIconRightMouseDown` called `toggle()`, so
/// either button raises the card and the card carries every control - open,
/// dismiss and quit included. A native menu would be a second, different way
/// to do the same things.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("SoundCloud")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left | MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_popup(tray.app_handle());
            }
        });

    // The dedicated tray artwork, not the app icon: it is drawn at 16px in the
    // notification area and the app icon does not read at that size.
    match Image::from_bytes(include_bytes!("../icons/tray.ico")) {
        Ok(icon) => builder = builder.icon(icon),
        Err(e) => {
            tracing::warn!("tray.ico could not be decoded, falling back: {e}");
            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }
        }
    }

    builder.build(app)?;
    Ok(())
}

/// Shows or hides the tray card.
fn toggle_popup(app: &tauri::AppHandle) {
    {
        let Ok(mut timing) = TRAY_TIMING.lock() else { return };
        let now = Instant::now();
        // A click that just dismissed the card completes the dismiss rather
        // than reopening it.
        if now.duration_since(timing.last_dismissed) < DISMISS_DEBOUNCE {
            return;
        }
        if now.duration_since(timing.last_toggle) < TOGGLE_DEBOUNCE {
            return;
        }
        timing.last_toggle = now;
    }

    let window = match app.get_webview_window("tray-popup") {
        Some(w) => w,
        None => {
            match WebviewWindowBuilder::new(
                app,
                "tray-popup",
                WebviewUrl::App("index.html#/tray".into()),
            )
            .title("SoundCloud")
            .inner_size(TRAY_POPUP.0, TRAY_POPUP.1)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            {
                Ok(w) => w,
                Err(e) => {
                    tracing::warn!("could not create the tray popup: {e}");
                    return;
                }
            }
        }
    };

    if window.is_visible().unwrap_or(false) {
        window.hide().ok();
        return;
    }

    if let Some(pos) = corner_position(app) {
        window.set_position(pos).ok();
    }
    window.show().ok();
    window.set_focus().ok();
}

/// Parks the card in the corner of the work area, as `_reveal` did - beside
/// the clock, clear of the taskbar, rather than tracking the icon itself.
fn corner_position(app: &tauri::AppHandle) -> Option<LogicalPosition<f64>> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();

    // `work_area` excludes the taskbar; `size` would put the card under it.
    let area = monitor.work_area();
    let origin = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);

    Some(LogicalPosition::new(
        origin.x + size.width - TRAY_POPUP.0 - TRAY_MARGIN,
        origin.y + size.height - TRAY_POPUP.1 - TRAY_MARGIN,
    ))
}
