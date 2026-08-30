/**
 * The frame every route renders inside. Port of `lib/app/app_shell.dart`.
 *
 * It owns the things that are global rather than per-screen: the keyboard
 * map, the `g` chord, the window title, tray commands, the Last.fm ticker and
 * the overlays.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import * as api from "@/api/client";
import { useRail } from "@/api/queries";
import {
  installMediaSession,
  updateMetadata,
  updatePlaybackState,
  updatePosition,
} from "@/audio/mediaSession";
import {
  ChordController,
  isEditing,
  keyStateOf,
  resolveShortcut,
  type Action,
  type ChordTarget,
} from "@/lib/shortcuts";
import { emitTrayState, onTrayCommand } from "@/lib/trayIpc";
import { routeForDeepLink, useClipboardWatcher, useRecentQueries } from "@/state/links";
import { bufferedFractionOf, usePlayerStore } from "@/state/playerStore";
import { useRepostsStore } from "@/state/likesStore";
import { useUiStore } from "@/state/uiStore";
import { BottomPlayer } from "./BottomPlayer";
import { LoginDialog } from "./LoginDialog";
import { Omnibox, ShortcutsOverlay, Toasts, useUnplayableToast } from "./Overlays";
import { QueuePanel } from "./QueuePanel";
import { SideNav } from "./SideNav";
import { TopBar } from "./TopBar";

/** `AppTheme.navCollapseBelow`. */
const NAV_COLLAPSE_BELOW = 1080;
const NAV_WIDTH = 216;
const NAV_WIDTH_COMPACT = 60;

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname + location.search;

  const [compact, setCompact] = useState(window.innerWidth < NAV_COLLAPSE_BELOW);
  const [loginOpen, setLoginOpen] = useState(false);
  const chord = useRef(new ChordController());

  const ui = useUiStore();
  const rail = useRail();
  useUnplayableToast();

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth < NAV_COLLAPSE_BELOW);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- actions ----------------------------------------------------------

  const goChord = useCallback(
    (target: ChordTarget) => {
      switch (target) {
        case "likes":
          navigate("/library?tab=likes");
          break;
        case "feed":
          navigate("/feed");
          break;
        case "library":
          navigate("/library");
          break;
        case "history":
          navigate("/library?tab=history");
          break;
        case "profile": {
          const handle = rail.data?.me?.handle;
          if (handle) navigate(`/artist/${encodeURIComponent(handle)}`);
          break;
        }
      }
    },
    [navigate, rail.data],
  );

  const copyContextLink = useCallback(async () => {
    const p = usePlayerStore.getState();
    const segments = location.pathname.split("/").filter(Boolean);

    let url: string | undefined;
    if (segments[0] === "artist" && segments[1]) {
      url = `https://soundcloud.com/${decodeURIComponent(segments[1])}`;
    }
    url ??= p.track?.permalinkUrl ?? undefined;

    if (!url) {
      ui.showToast("nothing to copy", { durationMs: 2000 });
      return;
    }
    await writeText(url);
    useClipboardWatcher.getState().markSeen(url);
    ui.showToast("link copied");
  }, [location.pathname, ui]);

  const runAction = useCallback(
    (action: Action) => {
      const p = usePlayerStore.getState();

      if (typeof action === "object") {
        p.seekFraction(action.seekToPercent / 10);
        return;
      }

      switch (action) {
        case "playPause":
          p.toggle();
          break;
        case "nextTrack":
          p.next();
          break;
        case "prevTrack":
          p.previous();
          break;
        case "seekForward":
          p.seekBy(5000);
          break;
        case "seekBackward":
          p.seekBy(-5000);
          break;
        case "volumeUp":
          p.setVolume(Math.min(1, p.volume + 0.05));
          break;
        case "volumeDown":
          p.setVolume(Math.max(0, p.volume - 0.05));
          break;
        case "muteToggle":
          p.toggleMute();
          break;
        case "likePlaying":
          void p.toggleLike();
          break;
        case "repeatToggle":
          p.toggleRepeat();
          break;
        case "shuffleToggle":
          p.toggleShuffle();
          break;
        case "repostPlaying":
          if (p.track) void useRepostsStore.getState().toggle(p.track.id);
          break;
        case "navigateToPlaying":
          if (p.track) navigate(`/track/${p.track.id}`);
          break;
        case "openSearch":
        case "focusOmnibox":
          ui.openOmnibox();
          break;
        case "toggleQueue":
          ui.toggleQueue();
          break;
        case "showShortcuts":
          ui.openShortcuts();
          break;
        case "jumpLikes":
          navigate("/library?tab=likes");
          break;
        case "jumpSettings":
          navigate("/settings");
          break;
        case "jumpLogs":
          navigate("/logs");
          break;
        case "copyLink":
          void copyContextLink();
          break;
        case "playPageTrack":
          window.dispatchEvent(new CustomEvent("wf:play-page-track"));
          break;
      }
    },
    [navigate, ui, copyContextLink],
  );

  // ---- keyboard ---------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A text field owns the keyboard while it is focused.
      if (isEditing(e.target)) return;

      const k = keyStateOf(e);
      const hasMod = k.primary || k.alt;

      if (ui.shortcutsOpen) {
        if (!hasMod && (e.code === "KeyH" || e.key === "Escape")) {
          e.preventDefault();
          ui.closeShortcuts();
        }
        return;
      }
      // The omnibox has its own handlers; nothing here may fire behind it.
      if (ui.omniboxOpen) return;

      if (!hasMod) {
        if (chord.current.armed) {
          e.preventDefault();
          const target = chord.current.resolve(e.code);
          if (target) goChord(target);
          return;
        }
        if (e.code === "KeyG") {
          e.preventDefault();
          chord.current.arm();
          return;
        }
      }

      const action = resolveShortcut(k, location.pathname);
      if (action) {
        e.preventDefault();
        runAction(action);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ui, goChord, runAction, location.pathname]);

  // ---- tray -------------------------------------------------------------

  useEffect(() => {
    const unlisten = onTrayCommand((msg) => {
      const p = usePlayerStore.getState();
      switch (msg.cmd) {
        case "playPause":
          p.toggle();
          break;
        case "next":
          p.next();
          break;
        case "previous":
          p.previous();
          break;
        case "toggleLike":
          void p.toggleLike();
          break;
        case "toggleShuffle":
          p.toggleShuffle();
          break;
        case "toggleRepeat":
          p.toggleRepeat();
          break;
        case "toggleMute":
          p.toggleMute();
          break;
        case "setVolume":
          if (msg.value !== undefined) p.setVolume(msg.value);
          break;
        case "seek":
          if (msg.value !== undefined) p.seekFraction(msg.value);
          break;
        case "openApp":
          void api.windowShow();
          break;
        case "quit":
          void api.appQuit();
          break;
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Push state to the tray card. Only while it is open - the card is created
  // on demand, and there is no point serialising this for nobody.
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = usePlayerStore.getState();
      const t = p.track;
      void emitTrayState({
        title: t?.title ?? "nothing playing",
        artist: t?.artist ?? "",
        coverUrl: t?.coverUrl,
        waveform: t?.waveform ?? [],
        positionMs: p.position,
        durationMs: t?.durationMs ?? 0,
        bufferedFraction: bufferedFractionOf(p),
        isPlaying: p.isPlaying,
        liked: p.liked,
        shuffle: p.shuffle,
        repeat: p.repeat,
        muted: p.muted,
        volume: p.volume,
        hasTrack: t !== null,
        isGoPlus: t?.goPlus ?? false,
      });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  // ---- links ------------------------------------------------------------

  // A SoundCloud link copied anywhere on the machine offers to open here.
  useEffect(() => {
    void useClipboardWatcher.getState().restore();
    void useRecentQueries.getState().restore();
    return useClipboardWatcher.getState().start();
  }, []);

  const clipboardLink = useClipboardWatcher((s) => s.link);
  const lastClipboardSeq = useRef(0);

  useEffect(() => {
    if (!clipboardLink || clipboardLink.seq === lastClipboardSeq.current) return;
    lastClipboardSeq.current = clipboardLink.seq;
    const url = clipboardLink.url;

    ui.showToast("SoundCloud link copied", {
      durationMs: 6000,
      action: {
        label: "open here",
        onTap: async () => {
          // Marked seen so re-copying the same link does not re-prompt.
          useClipboardWatcher.getState().markSeen(url);
          const route = await api.resolveUrl(url);
          if (route) navigate(route);
          else ui.showToast("that link did not resolve");
        },
      },
    });
  }, [clipboardLink, ui, navigate]);

  // `soundcloud://track/123` and pasted soundcloud.com links from the OS.
  useEffect(() => {
    let disposed = false;
    const open = async (urls: string[] | null) => {
      for (const raw of urls ?? []) {
        const route = await routeForDeepLink(raw);
        if (disposed) return;
        if (route) navigate(route);
        else void api.logWrite("WARN", "deeplink", `not resolved: ${raw}`);
      }
    };

    const wired = (async () => {
      const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      // A link that launched the app arrives here rather than as an event.
      await open(await getCurrent());
      return onOpenUrl((urls) => void open(urls));
    })().catch((e) => {
      void api.logWrite("INFO", "deeplink", `deep links unavailable: ${String(e)}`);
      return null;
    });

    return () => {
      disposed = true;
      void wired.then((f) => f?.());
    };
  }, [navigate]);

  // ---- OS media session -------------------------------------------------

  useEffect(() => {
    installMediaSession({
      play: () => {
        const p = usePlayerStore.getState();
        if (!p.isPlaying) p.toggle();
      },
      pause: () => {
        const p = usePlayerStore.getState();
        if (p.isPlaying) p.toggle();
      },
      next: () => usePlayerStore.getState().next(),
      previous: () => usePlayerStore.getState().previous(),
      seekTo: (ms) => {
        const p = usePlayerStore.getState();
        const dur = p.track?.durationMs ?? 0;
        if (dur > 0) p.seekFraction(ms / dur);
      },
      seekBy: (delta) => usePlayerStore.getState().seekBy(delta),
    });
  }, []);

  const track = usePlayerStore((s) => s.track);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  useEffect(() => {
    updateMetadata(track);
    // The window title follows the track, as the Dart shell did.
    void api.windowSetTitle(
      track ? `${track.artist} — ${track.title}` : "SoundCloud",
    );
    void api.safe(
      () => api.traySetTooltip(track?.title ?? "", track?.artist ?? ""),
      undefined,
      "tray tooltip",
    );
  }, [track]);

  useEffect(() => updatePlaybackState(isPlaying), [isPlaying]);

  // Position ticks ten times a second. Subscribing to the store directly,
  // rather than selecting `position` into this component, keeps those ticks
  // from re-rendering the whole shell - nav, top bar and all. The OS scrubber
  // only needs second granularity, so it is throttled to that too.
  useEffect(() => {
    let lastSecond = -1;
    return usePlayerStore.subscribe((s) => {
      const second = Math.floor(s.position / 1000);
      if (second === lastSecond) return;
      lastSecond = second;
      updatePosition(s.position, s.track?.durationMs ?? 0, s.isPlaying);
    });
  }, []);

  // ---- last.fm ----------------------------------------------------------

  const startedAt = useRef(0);
  const lastTrackId = useRef<string | null>(null);

  useEffect(() => {
    if (track?.id !== lastTrackId.current) {
      lastTrackId.current = track?.id ?? null;
      startedAt.current = Math.floor(Date.now() / 1000);
    }
  }, [track]);

  useEffect(() => {
    // Ticks once a second; Rust's ScrobbleGate decides if anything is due.
    const id = window.setInterval(() => {
      const p = usePlayerStore.getState();
      if (!p.track) return;
      void api.safe(
        () =>
          api.lastfmTick({
            trackId: p.track!.id,
            artist: p.track!.artist,
            title: p.track!.title,
            isPlaying: p.isPlaying,
            positionMs: p.position,
            durationMs: p.track!.durationMs,
            elapsedSecs: Math.floor(Date.now() / 1000) - startedAt.current,
            startedAtUnix: startedAt.current,
          }),
        undefined,
        "lastfm tick",
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---- render -----------------------------------------------------------

  const navWidth = compact ? NAV_WIDTH_COMPACT : NAV_WIDTH;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <SideNav location={path} compact={compact} onLogin={() => setLoginOpen(true)} />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar canGoBack={window.history.length > 1} navWidth={navWidth} />

          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
              <Outlet />
            </main>
            {ui.queueVisible && <QueuePanel />}
          </div>
        </div>
      </div>

      <BottomPlayer />

      {ui.omniboxOpen && <Omnibox />}
      {ui.shortcutsOpen && <ShortcutsOverlay />}
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
      <Toasts />
    </div>
  );
}
