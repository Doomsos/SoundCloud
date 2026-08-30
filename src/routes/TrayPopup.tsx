/**
 * The tray card. Port of `lib/features/tray/tray_popup.dart`.
 *
 * A 260x290 chromeless window parked in the corner of the work area. It holds
 * no player of its own — it renders whatever `player://state` last carried,
 * and every control emits a command back.
 *
 * The layout follows `_TrayCard` exactly: a 32px title bar on the page
 * background, then a `surface` body laid out `spaceBetween` — centred 76px
 * artwork, centred title and artist, a bare three-button transport, and the
 * waveform row along the bottom. Deliberately no shuffle, repeat, like or
 * volume: the card is a glance and three buttons, not a second player.
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import * as api from "@/api/client";
import { CoverArt } from "@/components/CoverArt";
import { Icon, ScLogo, type IconName } from "@/components/Icon";
import { LockBadge } from "@/components/common";
import { Waveform } from "@/components/Waveform";
import * as fmt from "@/lib/format";
import { onTrayState, sendTrayCommand, type TrayNowPlaying } from "@/lib/trayIpc";

const EMPTY: TrayNowPlaying = {
  title: "",
  artist: "",
  waveform: [],
  positionMs: 0,
  durationMs: 0,
  bufferedFraction: 0,
  isPlaying: false,
  liked: false,
  shuffle: false,
  repeat: false,
  muted: false,
  volume: 1,
  hasTrack: false,
  isGoPlus: false,
};

export function TrayPopup() {
  const [s, setState] = useState<TrayNowPlaying>(EMPTY);

  useEffect(() => {
    const unlisten = onTrayState(setState);
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const dismiss = () => void getCurrentWindow().hide();

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        border: "var(--border-width) solid var(--border)",
        overflow: "hidden",
      }}
    >
      <TitleBar onDismiss={dismiss} />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--surface)",
          borderTop: "var(--border-width) solid var(--border-dim)",
          padding: "12px 14px",
        }}
      >
        {s.hasTrack ? <ActiveContent state={s} /> : <EmptyContent />}
      </div>
    </div>
  );
}

function TitleBar({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      style={{
        height: 32,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        padding: "0 8px",
        background: "var(--bg)",
      }}
    >
      <ScLogo size={12} />
      <span
        style={{
          marginLeft: 7,
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.9px",
          color: "var(--text-hi)",
        }}
      >
        SOUNDCLOUD
      </span>

      <div data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch" }} />

      <BarButton
        icon="openInFull"
        label="Open SoundCloud"
        onClick={() => {
          void api.windowShow();
          void sendTrayCommand({ cmd: "openApp" });
        }}
      />
      <BarButton icon="close" label="Dismiss" onClick={onDismiss} />
      <BarButton icon="power" label="Quit SoundCloud" danger onClick={() => void api.appQuit()} />
    </div>
  );
}

function ActiveContent({ state: s }: { state: TrayNowPlaying }) {
  const progress = s.durationMs > 0 ? Math.min(1, s.positionMs / s.durationMs) : 0;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        alignItems: "stretch",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center" }}>
        <CoverArt seed={s.title || "idle"} imageUrl={s.coverUrl} size={76} />
      </div>

      <div style={{ textAlign: "center", minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            minWidth: 0,
          }}
        >
          <span
            className="truncate"
            style={{ fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}
            title={s.title}
          >
            {s.title}
          </span>
          {s.isGoPlus && <LockBadge lock="goPlus" />}
        </div>
        <div
          className="truncate"
          style={{ marginTop: 2, fontSize: 11.5, color: "var(--text-mid)" }}
          title={s.artist}
        >
          {s.artist}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 14 }}>
        <IconBtn
          icon="skipPrevious"
          label="Previous"
          size={22}
          onClick={() => void sendTrayCommand({ cmd: "previous" })}
        />
        <PlayButton
          isPlaying={s.isPlaying}
          onClick={() => void sendTrayCommand({ cmd: "playPause" })}
        />
        <IconBtn
          icon="skipNext"
          label="Next"
          size={22}
          onClick={() => void sendTrayCommand({ cmd: "next" })}
        />
      </div>

      <div style={{ height: 26, display: "flex", alignItems: "center", gap: 6 }}>
        <span className="t-mono" style={{ width: 34, fontSize: 10, color: "var(--text-low)" }}>
          {fmt.time(s.positionMs)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Waveform
            bars={s.waveform.length ? s.waveform : []}
            progress={progress}
            buffered={s.bufferedFraction}
            height={22}
            onSeek={(f) => void sendTrayCommand({ cmd: "seek", value: f })}
          />
        </div>
        <span
          className="t-mono"
          style={{ width: 34, fontSize: 10, color: "var(--text-low)", textAlign: "right" }}
        >
          {fmt.time(s.durationMs)}
        </span>
      </div>
    </div>
  );
}

function EmptyContent() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          display: "grid",
          placeItems: "center",
          background: "var(--surface2)",
          borderRadius: "var(--radius-md)",
          border: "var(--border-width) solid var(--border-dim)",
        }}
      >
        <Icon name="musicNote" size={24} color="var(--text-low)" />
      </div>

      <div style={{ marginTop: 10, fontSize: 13, fontWeight: 600, color: "var(--text-hi)" }}>
        Nothing playing
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: "var(--text-low)" }}>
        SoundCloud is idle
      </div>

      <button
        onClick={() => {
          void api.windowShow();
          void sendTrayCommand({ cmd: "openApp" });
        }}
        style={{
          marginTop: 14,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 14px",
          background: "var(--surface2)",
          borderRadius: "var(--radius-sm)",
          border: "var(--border-width) solid var(--border)",
        }}
      >
        <Icon name="launch" size={13} color="var(--acid)" />
        <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-hi)" }}>
          Open SoundCloud
        </span>
      </button>
    </div>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        width: 26,
        height: 24,
        margin: "0 1.5px",
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        background: hover ? "var(--surface2)" : "transparent",
        transition: `background var(--motion) var(--ease)`,
      }}
    >
      <Icon
        name={icon}
        size={14}
        color={hover ? (danger ? "var(--acid)" : "var(--text-hi)") : "var(--text-low)"}
      />
    </button>
  );
}

function IconBtn({
  icon,
  label,
  onClick,
  size = 18,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  size?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{
        width: 28,
        height: 28,
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        background: hover ? "var(--surface2)" : "transparent",
        transition: `background var(--motion) var(--ease)`,
      }}
    >
      <Icon name={icon} size={size} color={hover ? "var(--text-hi)" : "var(--text-mid)"} />
    </button>
  );
}

function PlayButton({ isPlaying, onClick }: { isPlaying: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      title={isPlaying ? "Pause" : "Play"}
      aria-label={isPlaying ? "Pause" : "Play"}
      style={{
        width: 32,
        height: 32,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        background: hover ? "var(--acid-hi)" : "var(--acid)",
        boxShadow: hover ? "0 2px 8px rgba(255,85,0,0.35)" : "none",
        transition: `background var(--motion) var(--ease), box-shadow var(--motion) var(--ease)`,
      }}
    >
      <Icon name={isPlaying ? "pause" : "play"} size={20} color="var(--bg)" />
    </button>
  );
}
