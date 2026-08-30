/**
 * The transport bar. Port of
 * `lib/features/player/widgets/bottom_player.dart`.
 *
 * Three columns, as the Dart `Row` had them: now-playing on the left,
 * transport and scrubber in the middle, secondary controls on the right.
 */

import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon, type IconName } from "@/components/Icon";
import { CoverArt } from "@/components/CoverArt";
import { LockBadge } from "@/components/common";
import * as fmt from "@/lib/format";
import type { Track } from "@/models";
import { bufferedFractionOf, progressOf, usePlayerStore } from "@/state/playerStore";
import { useLikesStore, useRepostsStore } from "@/state/likesStore";
import { useUiStore } from "@/state/uiStore";

export function BottomPlayer() {
  const s = usePlayerStore();
  const track = s.track;
  const enabled = track !== null;
  const collapsed = useUiStore((k) => k.playerCollapsed);
  const toggleCollapsed = useUiStore((k) => k.togglePlayerCollapsed);

  const liked = useLikesStore((k) => (track ? k.ids.has(track.id) : false));
  const reposted = useRepostsStore((k) => (track ? k.ids.has(track.id) : false));
  const toggleRepost = useRepostsStore((k) => k.toggle);
  const toggleQueue = useUiStore((k) => k.toggleQueue);
  const queueVisible = useUiStore((k) => k.queueVisible);

  if (collapsed) {
    return (
      <CollapsedBar
        track={track}
        isPlaying={s.isPlaying}
        position={s.position}
        progress={progressOf(s)}
        onPlayPause={s.toggle}
        onNext={s.next}
        onExpand={toggleCollapsed}
      />
    );
  }

  return (
    <footer
      style={{
        height: "var(--player-height)",
        flexShrink: 0,
        background: "var(--surface)",
        borderTop: "var(--border-width) solid var(--border-dim)",
        padding: "7px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      {/* now playing */}
      <div style={{ flex: 3, minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
        {track ? (
          <>
            <CoverArt seed={track.id} imageUrl={track.coverUrl} size={44} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Link
                  to={`/track/${track.id}`}
                  className="truncate t-body"
                  style={{ fontWeight: 600 }}
                  title={track.title}
                >
                  {track.title}
                </Link>
                <LockBadge lock={track.lock} />
              </div>
              <Link
                to={`/artist/${encodeURIComponent(track.artistHandle)}`}
                className="truncate t-label"
                style={{ display: "block", marginTop: 1 }}
                title={track.artist}
              >
                {track.artist}
              </Link>
            </div>
            <IconBtn
              icon={liked ? "heart" : "heartOutline"}
              label={liked ? "unlike" : "like"}
              active={liked}
              onClick={() => void usePlayerStore.getState().toggleLike()}
            />
            <IconBtn
              icon="repost"
              label={reposted ? "remove repost" : "repost"}
              active={reposted}
              onClick={() => void toggleRepost(track.id)}
            />
          </>
        ) : (
          <span className="t-label" style={{ color: "var(--text-low)" }}>
            nothing playing
          </span>
        )}
      </div>

      {/* transport + scrubber */}
      <div
        style={{
          flex: 5,
          maxWidth: 620,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
        }}
      >
        <div style={{ height: 30, display: "flex", alignItems: "center", gap: 2 }}>
          <IconBtn
            icon="shuffle"
            label="shuffle"
            active={s.shuffle}
            enabled={enabled}
            onClick={s.toggleShuffle}
          />
          <IconBtn
            icon="skipPrevious"
            label="previous"
            size={20}
            enabled={enabled}
            onClick={s.previous}
          />
          <PlayButton isPlaying={s.isPlaying} enabled={enabled} onClick={s.toggle} />
          <IconBtn icon="skipNext" label="next" size={20} enabled={enabled} onClick={s.next} />
          <IconBtn
            icon={s.repeat ? "repeatOne" : "repeat"}
            label="repeat"
            active={s.repeat}
            enabled={enabled}
            onClick={s.toggleRepeat}
          />
        </div>

        <div
          style={{
            height: 24,
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 9,
          }}
        >
          <span className="t-mono" style={{ width: 40, textAlign: "right", flexShrink: 0 }}>
            {fmt.time(s.position)}
          </span>
          <ProgressBar
            progress={progressOf(s)}
            buffered={bufferedFractionOf(s)}
            enabled={enabled}
            onSeek={s.seekFraction}
          />
          <span className="t-mono" style={{ width: 40, flexShrink: 0 }}>
            {fmt.time(track?.durationMs ?? 0)}
          </span>
        </div>
      </div>

      {/* secondary */}
      <div
        style={{
          flex: 3,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        <IconBtn
          icon="chevronRight"
          label="collapse the player"
          onClick={toggleCollapsed}
        />
        <IconBtn
          icon="playlistPlay"
          label="queue"
          active={queueVisible}
          onClick={toggleQueue}
        />
        <IconBtn
          icon={s.muted || s.volume === 0 ? "volumeOff" : "volumeUp"}
          label={s.muted ? "unmute" : "mute"}
          onClick={s.toggleMute}
        />
        <VolumeSlider value={s.muted ? 0 : s.volume} onChange={s.setVolume} />
      </div>
    </footer>
  );
}

/**
 * The slim transport bar. Port of `_CollapsedBar` in `bottom_player.dart`:
 * a hairline progress line, the essentials, and a way back.
 */
function CollapsedBar({
  track,
  isPlaying,
  position,
  progress,
  onPlayPause,
  onNext,
  onExpand,
}: {
  track: Track | null;
  isPlaying: boolean;
  position: number;
  progress: number;
  onPlayPause: () => void;
  onNext: () => void;
  onExpand: () => void;
}) {
  const enabled = track !== null;
  return (
    <footer
      style={{
        height: "var(--player-height-collapsed)",
        flexShrink: 0,
        background: "var(--surface)",
        borderTop: "var(--border-width) solid var(--border-dim)",
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 12px",
      }}
    >
      {/* Progress reads as a hairline along the top edge. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          height: 2,
          width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
          background: "var(--acid)",
        }}
      />

      {track && <CoverArt seed={track.id} imageUrl={track.coverUrl} size={26} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        {track ? (
          <Link to={`/track/${track.id}`} className="truncate t-body" style={{ fontSize: 12 }}>
            {track.artist} — {track.title}
          </Link>
        ) : (
          <span className="t-label" style={{ color: "var(--text-low)" }}>
            nothing playing
          </span>
        )}
      </div>

      <span className="t-mono" style={{ fontSize: 11 }}>
        {fmt.time(position)}
      </span>
      <IconBtn
        icon={isPlaying ? "pause" : "play"}
        label={isPlaying ? "pause" : "play"}
        enabled={enabled}
        onClick={onPlayPause}
      />
      <IconBtn icon="skipNext" label="next" enabled={enabled} onClick={onNext} />
      <IconBtn icon="chevronLeft" label="expand the player" onClick={onExpand} />
    </footer>
  );
}

function ProgressBar({
  progress,
  buffered,
  enabled,
  onSeek,
}: {
  progress: number;
  buffered: number;
  enabled: boolean;
  onSeek: (f: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);

  const seekAt = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onPointerDown={(e) => {
        if (!enabled) return;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e.clientX, e.currentTarget);
      }}
      onPointerMove={(e) => {
        if (dragging) seekAt(e.clientX, e.currentTarget);
      }}
      onPointerUp={(e) => {
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be released */
        }
      }}
      style={{
        flex: 1,
        height: 14,
        display: "flex",
        alignItems: "center",
        cursor: enabled ? "pointer" : "default",
        touchAction: "none",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: hover || dragging ? 5 : 3,
          borderRadius: 3,
          background: "var(--surface3)",
          transition: `height var(--motion) var(--ease)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${Math.max(0, Math.min(1, buffered)) * 100}%`,
            borderRadius: 3,
            background: "var(--wave-dim)",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
            borderRadius: 3,
            background: "var(--acid)",
          }}
        />
        {(hover || dragging) && enabled && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: `${Math.max(0, Math.min(1, progress)) * 100}%`,
              width: 10,
              height: 10,
              marginTop: -5,
              marginLeft: -5,
              borderRadius: "50%",
              background: "var(--acid)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}

function VolumeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [dragging, setDragging] = useState(false);

  const at = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  return (
    <div
      onPointerDown={(e) => {
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e.clientX, e.currentTarget);
      }}
      onPointerMove={(e) => {
        if (dragging) at(e.clientX, e.currentTarget);
      }}
      onPointerUp={(e) => {
        setDragging(false);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* capture may already be released */
        }
      }}
      title="volume"
      style={{
        width: 84,
        height: 14,
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        flexShrink: 0,
        touchAction: "none",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 3,
          borderRadius: 3,
          background: "var(--surface3)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            width: `${value * 100}%`,
            borderRadius: 3,
            background: "var(--text-mid)",
          }}
        />
      </div>
    </div>
  );
}

function PlayButton({
  isPlaying,
  enabled,
  onClick,
}: {
  isPlaying: boolean;
  enabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      title={isPlaying ? "pause" : "play"}
      aria-label={isPlaying ? "pause" : "play"}
      style={{
        width: 30,
        height: 30,
        margin: "0 4px",
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        background: enabled ? (hover ? "var(--acid-hi)" : "var(--acid)") : "var(--surface3)",
        transition: `background var(--motion) var(--ease)`,
        cursor: enabled ? "pointer" : "default",
      }}
    >
      <Icon
        name={isPlaying ? "pause" : "play"}
        size={16}
        color={enabled ? "var(--bg)" : "var(--text-low)"}
      />
    </button>
  );
}

function IconBtn({
  icon,
  label,
  onClick,
  active = false,
  enabled = true,
  size = 17,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  enabled?: boolean;
  size?: number;
}) {
  const [hover, setHover] = useState(false);
  const color = !enabled
    ? "rgba(106,106,118,0.5)"
    : active
      ? "var(--acid)"
      : hover
        ? "var(--text-hi)"
        : "var(--text-mid)";

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      title={label}
      aria-label={label}
      style={{
        width: 28,
        height: 28,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        borderRadius: "var(--radius-sm)",
        background: hover && enabled ? "var(--surface2)" : "transparent",
        transition: `background var(--motion) var(--ease)`,
        cursor: enabled ? "pointer" : "default",
      }}
    >
      <Icon name={icon} size={size} color={color} />
    </button>
  );
}
