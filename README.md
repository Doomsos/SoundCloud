# SoundCloud

A cross-platform desktop client for SoundCloud. **Tauri v2 · Rust core · React + TypeScript frontend.**

This is a port of the Flutter/Dart build that preceded it. Behaviour, layout
and design tokens are carried over deliberately; the architecture is not.

---

## Why this stack

The decision turned on one component. `lib/core/audio/drm_engine.dart` plays
SoundCloud's encrypted-HLS tracks by driving a **hidden WebView2 running Shaka
Player against Microsoft's PlayReady CDM** — because no native audio library
can decrypt PlayReady or Widevine, and libmpv could not touch those streams.

Getting there in Flutter took ~290 lines and four workarounds:

* a **loopback HTTP server** to host the player page, because EME is only
  granted in a secure context and a `file://` page cannot reach the licence
  server;
* a **hidden second WebView2 window**, via a vendored fork of
  `desktop_webview_window` patched for macOS;
* **`evaluateJavaScript`** for every Dart → JS call;
* **polling `scState()` every 200 ms** for JS → Dart, because the plugin's
  message handler is a no-op on Windows — with a double-JSON-decode
  workaround for hosts that double-encode the result.

In Tauri the UI *is* a webview in a secure context, so all of that collapses.
Shaka attaches to an ordinary `<audio>` element in-process and reports state
through normal media events. `src/audio/drmEngine.ts` is ~250 lines including
comments, and the hard-won knowledge that survives is exactly the part worth
keeping: the licence endpoint, the PlayReady key system, and the request
filter that signs licence calls with the anonymous `client_id`.

Measured results against the Flutter build:

|                           | Flutter                                          | Tauri            |
| ------------------------- | ------------------------------------------------ | ---------------- |
| Binary                    | ~40 MB+                                          | **8.2 MB**       |
| MSI packaging             | WiX v5 as a dotnet global tool                   | built in         |
| DRM playback              | loopback server + hidden window + 200 ms polling | an audio element |
| Extra processes for audio | `audio_service` background isolate               | none             |

---

## Architecture

Rust owns everything that touches the network, the disk, or the OS. The
frontend owns the UI and playback.

```
src-tauri/src/
  models.rs            domain types, serialised camelCase over IPC
  state.rs             the service graph (what Riverpod's providers were)
  commands.rs          the #[tauri::command] IPC surface
  lib.rs               tray, window lifecycle, deep links, command registry
  api/
    client.rs          SoundCloud v2 client
    client_id.rs       anonymous client_id scraping, single-flighted
    auth.rs             OAuth PKCE + loopback callback server
    dto.rs              wire types
    mappers.rs          DTO -> domain
  core/
    cache.rs            on-disk audio cache (LRU, HLS reassembly, DRM segments)
    storage.rs          prefs.json + token store
    lastfm.rs           scrobbling, with the timing rules as a pure gate
    log.rs              ring buffer behind the in-app logs view
    json.rs             lenient accessors

src/
  api/                 typed IPC wrappers + TanStack Query hooks
  audio/               engine interface, dual-deck player, Shaka DRM engine
  state/               zustand stores; queue.ts holds the sequencing logic
  shell/               app frame, nav, transport bar, overlays
  routes/              one file per screen
  components/          shared widgets
  theme/tokens.css     design tokens, ported 1:1 from the Dart theme
```

**Why the network layer is in Rust.** The frontend never sees CORS, the
`client_id` dance, or an OAuth header. It awaits domain objects.

**Why playback is in the frontend.** It has to be — the CDM lives there. Since
it does, the plain path lives there too, so there is one engine interface
rather than two runtimes to keep in sync.

---

## Running it

```bash
npm install
npm run app:dev      # dev, with hot reload
npm run app:build    # release + MSI + NSIS installer
```

Checks:

```bash
npm run typecheck            # tsc --noEmit
npm test                     # vitest  (51 tests)
cd src-tauri && cargo test   # rust    (58 tests)
```

Prerequisites: Node 18+, the Rust stable toolchain (MSVC on Windows), and the
platform's webview (WebView2 on Windows; WebKitGTK on Linux).

Build-time configuration, matching the Dart `--dart-define` keys:
`SOUNDCLOUD_CLIENT_ID`, `SOUNDCLOUD_CLIENT_SECRET`, `SOUNDCLOUD_REDIRECT_PORT`,
`LASTFM_API_KEY`, `LASTFM_SHARED_SECRET`. Without a compiled-in SoundCloud id,
the sign-in dialog asks for one and stores it locally; without last.fm keys the
scrobbling section reports itself unconfigured.

To boot straight to a route — the equivalent of `--dart-define=START=/route` —
append the hash: `http://localhost:1420/#/playlist/123`.

---

## Things worth knowing

**Your session carries over.** On first run the token store adopts an existing
token from the Flutter build's `%APPDATA%\SoundCloud Desktop\SoundCloud Desktop\`,
so you stay signed in. It runs once and never overwrites a newer token.

**Closing the window hides it.** Playback lives in the webview, so destroying
the window would stop the music. The tray card holds the real quit.

**The tray has no context menu** — either mouse button raises the card, which
is what `tray_controller.dart` did (`onTrayIconMouseDown` and
`onTrayIconRightMouseDown` both called `toggle()`). The card parks in the
corner of the work area, dismisses on click-away, and carries open / dismiss /
quit in its title bar. It uses `tray.ico`, not the app icon, and its tooltip
follows the track.

**Up next is open by default.** The top-bar and player buttons still toggle it.

**Media keys work through `navigator.mediaSession`**, which is also what puts
the track in the Windows SMTC flyout — replacing the `audio_service`
background isolate with nothing at all.

**Crossfade does not apply to DRM tracks.** One CDM session means one decoder,
so there is nothing to preload into; those cut instead. Same as before.

**Shaka and hls.js are lazy chunks.** The main bundle is 335 KB (102 KB gzipped);
the 774 KB Shaka chunk is fetched only once a DRM track is reached, or is
next in the queue and being warmed.

**Deep links work.** `soundcloud://track/123`, `soundcloud://artist/<handle>`,
`soundcloud://playlist/<id>`, `?url=`-wrapped links, and plain soundcloud.com
URLs all resolve to a route. The scheme is registered by the installer, and at
runtime in dev. The clipboard watcher still offers to open a SoundCloud link
copied anywhere on the machine.

---

## Port notes

A few deliberate decisions, so they are not mistaken for oversights.

* **`Track.generateWaveform` is not bit-identical.** Dart's seeded `Random` is
  not specified across implementations. The Rust version is deterministic in
  the same seed with the same envelope and jitter shape; the value is a
  decorative placeholder that is replaced by the real waveform JSON and never
  compared.
* **Stream-candidate ordering is unchanged.** Progressive still leads, even
  though the reason is gone: the Flutter build decoded through libmpv, which
  stalled at 0:00 on the `aac_160k` fMP4 stream. The webview has no such limit,
  so the order is now a preference rather than a workaround. Kept as-is to
  match the original, and noted in `mappers.rs` for whoever revisits it.
* **`TrackListFeedMapper` was not ported.** It was defined in `mappers.dart`
  and called from nowhere.
* **Queue sequencing was extracted, not rewritten.** `state/queue.ts` holds
  what were private fields on `PlayerController`. It is the highest-risk logic
  in the port — shuffle, history, the frontier — so it is pure and has 26
  tests.
* **Home renders shelves only.** `HomeData.stream` is fetched and not shown,
  exactly as the Dart `_HomeBody` did — the stream has its own screen at
  `/feed`. Same for `LibraryData.recentlyPlayed`, which the Dart library
  screen never rendered either. Both are kept in the model so the API layer
  stays a faithful port.
* **The likes tab pages through everything.** `LibraryData.likes` only carries
  the first fifty, so the tab reads the `next_href` cursor instead — matching
  `_PaginatedLikesTab`. Every tab has the in-tab filter field.
* **Prefs keys are unchanged**, so existing settings are picked up:
  `sc_client_id`, `soundcloud_client_id`, `playback_crossfade_ms`,
  `recent_searches`, `clipboardWatch`, `lastfm_session_key`, `lastfm_username`.

### Not ported

* **The hidden-webview write executor** (`webview_executor.dart`,
  `browser_login.dart`, `webview_login.dart`, `js_runner.dart`). The Dart
  `writeOutcome` tried a hidden webview carrying real browser cookies before
  falling back to the HTTP client; only the HTTP path is ported. The user-facing
  recovery survives: a `blocked` like or repost still offers **verify**, which
  opens soundcloud.com in an app webview to clear the challenge
  (`webview_verification.dart`, ported).
* **Dev mocks** — `mock_soundcloud_api.dart`, `mock_data.dart`, `mock_tracks.dart`.
* **Edge-swipe back** (`back_nav.dart`). Trackpad gesture navigation.
* **Grid/list view toggle** (`view_mode.dart`, `view_toggle.dart`).
* **Decorative widgets** with no behaviour: `ambient_backdrop.dart`,
  `right_rail.dart` (and its `rail_layout.dart` wrapper), `minted_badge.dart`,
  `live_waveform.dart`, `pressable.dart`, `collection_row.dart`. The rest of
  `shared/widgets/` is ported, some folded into the component it belongs with
  (`media_carousel` → `Shelf`, `feed_post_card` → `FeedCard`,
  `section_header` and `skeleton_box` → `common.tsx`).
* **`image_cache.dart`** — the webview's own HTTP cache does this.
* **`tool/package.ps1` and `tool/build_msi.ps1`** — Tauri's bundler replaces
  them, and no WiX install is needed.

---

## AI Assistance

This project was developed with assistance from **Claude (Anthropic)**. Claude
was used throughout the port for code generation, refactoring, debugging,
architecture discussions, and development assistance. All generated code was
reviewed, tested, and integrated as part of the project.
