/**
 * The up-next panel. Port of `lib/features/queue/queue_panel.dart`.
 *
 * Reads `queueVersion` rather than the queue itself: the queue lives outside
 * the store (see `playerStore`), so the version counter is what tells this
 * panel to re-read it.
 */

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { CoverArt } from "@/components/CoverArt";
import * as fmt from "@/lib/format";
import type { Track } from "@/models";
import { usePlayerStore } from "@/state/playerStore";
import { useUiStore } from "@/state/uiStore";

export function QueuePanel() {
  // Subscribing to the version is what makes queue edits repaint this list.
  const version = usePlayerStore((s) => s.queueVersion);
  const upcoming = usePlayerStore((s) => s.upcoming);
  const current = usePlayerStore((s) => s.track);
  const hideQueue = useUiStore((s) => s.hideQueue);

  const items = upcoming();
  void version;

  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        background: "var(--nav)",
        borderLeft: "var(--border-width) solid var(--border-dim)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 42,
          flexShrink: 0,
          padding: "0 8px 0 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "var(--border-width) solid var(--border-dim)",
        }}
      >
        <span className="t-overline">up next</span>
        <button onClick={hideQueue} title="close" style={{ display: "flex", padding: 4 }}>
          <Icon name="close" size={14} color="var(--text-low)" />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {current && (
          <>
            <div className="t-overline" style={{ padding: "4px 6px 6px" }}>
              playing
            </div>
            <QueueRow track={current} index={-1} current />
            <div style={{ height: 12 }} />
          </>
        )}

        {items.length === 0 ? (
          <div className="t-label" style={{ padding: "20px 6px", color: "var(--text-low)" }}>
            nothing queued — play a list to fill this up
          </div>
        ) : (
          items.map((t, i) => <QueueRow key={`${t.id}-${i}`} track={t} index={i} />)
        )}
      </div>
    </aside>
  );
}

function QueueRow({
  track,
  index,
  current = false,
}: {
  track: Track;
  index: number;
  current?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const play = usePlayerStore((s) => s.play);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const upcoming = usePlayerStore((s) => s.upcoming);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        if (current) return;
        // Playing from the queue keeps the rest of the queue behind it.
        play(track, [track, ...upcoming().slice(index + 1)]);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        height: 44,
        padding: "0 6px",
        borderRadius: "var(--radius-sm)",
        background: current ? "var(--acid-wash)" : hover ? "var(--surface2)" : "transparent",
        transition: `background var(--motion) var(--ease)`,
        cursor: current ? "default" : "pointer",
      }}
    >
      <CoverArt seed={track.id} imageUrl={track.coverUrl} size={30} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="truncate"
          style={{
            fontSize: 12.5,
            fontWeight: current ? 600 : 500,
            color: current ? "var(--acid)" : "var(--text-hi)",
          }}
          title={track.title}
        >
          {track.title}
        </div>
        <div className="truncate t-label" style={{ fontSize: 11 }}>
          {track.artist}
        </div>
      </div>

      {!current && hover ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeFromQueue(track.id);
          }}
          title="remove"
          style={{ display: "flex", padding: 2 }}
        >
          <Icon name="close" size={13} color="var(--text-low)" />
        </button>
      ) : (
        <span className="t-mono" style={{ fontSize: 11 }}>
          {fmt.time(track.durationMs)}
        </span>
      )}
    </div>
  );
}
