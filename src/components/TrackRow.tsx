/**
 * One track in a list. Port of `lib/shared/widgets/track_row.dart`.
 *
 * Clicking plays it with the surrounding list as the queue, which is what
 * makes any list in the app a playable context.
 */

import { useState } from "react";
import { Link } from "react-router-dom";

import * as api from "@/api/client";
import { Icon } from "./Icon";
import { CoverArt } from "./CoverArt";
import { LockBadge } from "./common";
import * as fmt from "@/lib/format";
import type { Track } from "@/models";
import { usePlayerStore } from "@/state/playerStore";
import { useLikesStore } from "@/state/likesStore";
import { useUiStore } from "@/state/uiStore";
import { TrackMenu } from "./TrackMenu";

export function TrackRow({
  track,
  queue,
  index,
  dense = false,
}: {
  track: Track;
  queue?: Track[];
  index?: number;
  dense?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const current = usePlayerStore((s) => s.track?.id === track.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying) && current;
  const play = usePlayerStore((s) => s.play);
  const toggle = usePlayerStore((s) => s.toggle);

  const liked = useLikesStore((s) => s.ids.has(track.id));
  const toggleLike = useLikesStore((s) => s.toggle);
  const showToast = useUiStore((s) => s.showToast);

  const start = () => {
    if (track.locked) {
      showToast("GO+ only - needs a SoundCloud GO+ subscription to play", {
        durationMs: 4000,
      });
      return;
    }
    if (current) toggle();
    else play(track, queue);
  };

  const onLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const outcome = await toggleLike(track.id);
    if (outcome === "blocked") {
      showToast("SoundCloud blocked this action - likely a captcha/VPN check", {
        durationMs: 6000,
        action: { label: "verify", onTap: () => void api.openVerificationWindow() },
      });
    } else if (outcome === "failed") {
      showToast("couldn't update like");
    }
  };

  const height = dense ? 44 : "var(--row-height)";
  const art = dense ? 28 : 36;

  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={start}
        onDoubleClick={(e) => e.preventDefault()}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          height,
          padding: "0 10px",
          borderRadius: "var(--radius-sm)",
          background: current ? "var(--acid-wash)" : hover ? "var(--surface2)" : "transparent",
          transition: `background var(--motion) var(--ease)`,
          cursor: "pointer",
          opacity: track.locked ? 0.62 : 1,
        }}
      >
        {index !== undefined && (
          <span
            className="t-mono"
            style={{
              width: 22,
              textAlign: "right",
              color: current ? "var(--acid)" : "var(--text-low)",
              flexShrink: 0,
            }}
          >
            {/* The index gives way to a transport glyph on hover. */}
            {hover ? (
              <Icon
                name={isPlaying ? "pause" : "play"}
                size={13}
                color={current ? "var(--acid)" : "var(--text-hi)"}
              />
            ) : (
              index + 1
            )}
          </span>
        )}

        <CoverArt seed={track.id} imageUrl={track.coverUrl} size={art} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="truncate t-body"
            style={{
              color: current ? "var(--acid)" : "var(--text-hi)",
              fontWeight: current ? 600 : 500,
            }}
            title={track.title}
          >
            {track.title}
          </div>
          <Link
            to={`/artist/${encodeURIComponent(track.artistHandle)}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate t-label"
            style={{ display: "block", marginTop: 1 }}
            title={track.artist}
          >
            {track.artist}
          </Link>
        </div>

        {track.lock !== "none" && <LockBadge lock={track.lock} />}

        {!dense && (
          <span className="t-mono" style={{ width: 58, textAlign: "right", flexShrink: 0 }}>
            {fmt.count(track.plays)}
          </span>
        )}

        <button
          onClick={onLike}
          title={liked ? "unlike" : "like"}
          style={{
            opacity: liked || hover ? 1 : 0,
            transition: `opacity var(--motion) var(--ease)`,
            display: "flex",
            flexShrink: 0,
          }}
        >
          <Icon
            name={liked ? "heart" : "heartOutline"}
            size={15}
            color={liked ? "var(--acid)" : "var(--text-mid)"}
          />
        </button>

        <span className="t-mono" style={{ width: 42, textAlign: "right", flexShrink: 0 }}>
          {fmt.time(track.durationMs)}
        </span>
      </div>

      {menuAt && (
        <TrackMenu track={track} queue={queue} at={menuAt} onClose={() => setMenuAt(null)} />
      )}
    </>
  );
}
