/**
 * Right-click menu for a track. Port of
 * `lib/shared/widgets/track_context_menu.dart`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import * as api from "@/api/client";
import { Icon, type IconName } from "./Icon";
import type { Track } from "@/models";
import { usePlayerStore } from "@/state/playerStore";
import { useLikesStore, useRepostsStore } from "@/state/likesStore";
import { useUiStore } from "@/state/uiStore";

const MENU_WIDTH = 208;

export function TrackMenu({
  track,
  queue,
  at,
  onClose,
}: {
  track: Track;
  queue?: Track[];
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  const play = usePlayerStore((s) => s.play);
  const playNext = usePlayerStore((s) => s.playNext);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const liked = useLikesStore((s) => s.ids.has(track.id));
  const toggleLike = useLikesStore((s) => s.toggle);
  const reposted = useRepostsStore((s) => s.ids.has(track.id));
  const toggleRepost = useRepostsStore((s) => s.toggle);
  const showToast = useUiStore((s) => s.showToast);

  // Flip the menu back inside the window when it would overflow an edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const x = Math.min(at.x, window.innerWidth - MENU_WIDTH - 8);
    const y = at.y + h > window.innerHeight - 8 ? Math.max(8, at.y - h) : at.y;
    setPos({ x: Math.max(8, x), y });
  }, [at]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture phase: the row underneath must not also receive the click.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const copyLink = async () => {
    const url = track.permalinkUrl;
    if (!url) {
      showToast("nothing to copy");
      return;
    }
    await writeText(url);
    showToast("link copied");
  };

  const items: Array<
    { icon: IconName; label: string; onClick: () => void } | "separator"
  > = [
    // Playing from the menu takes the surrounding list as the queue, the same
    // as clicking the row does.
    { icon: "play", label: "play now", onClick: () => play(track, queue) },
    { icon: "playlistPlay", label: "play next", onClick: () => playNext(track) },
    { icon: "add", label: "add to queue", onClick: () => addToQueue(track) },
    "separator",
    {
      icon: liked ? "heart" : "heartOutline",
      label: liked ? "unlike" : "like",
      onClick: () => void toggleLike(track.id),
    },
    {
      icon: "repost",
      label: reposted ? "remove repost" : "repost",
      onClick: () => void toggleRepost(track.id),
    },
    "separator",
    {
      icon: "info",
      label: "go to track",
      onClick: () => navigate(`/track/${track.id}`),
    },
    {
      icon: "people",
      label: "go to artist",
      onClick: () => navigate(`/artist/${encodeURIComponent(track.artistHandle)}`),
    },
    "separator",
    { icon: "link", label: "copy link", onClick: () => void copyLink() },
    {
      icon: "openInNew",
      label: "open in browser",
      onClick: () => {
        if (track.permalinkUrl) void api.openExternal(track.permalinkUrl);
      },
    },
  ];

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: MENU_WIDTH,
        zIndex: 400,
        padding: 4,
        background: "var(--surface)",
        border: "var(--border-width) solid var(--border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
      }}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div
            key={`s${i}`}
            style={{ height: 1, background: "var(--border-dim)", margin: "4px 6px" }}
          />
        ) : (
          <MenuItem key={item.label} {...item} onClick={run(item.onClick)} />
        ),
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      role="menuitem"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      className="t-body"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        height: 30,
        padding: "0 8px",
        borderRadius: "var(--radius-sm)",
        background: hover ? "var(--surface2)" : "transparent",
        color: hover ? "var(--text-hi)" : "var(--text-mid)",
        fontWeight: 400,
        textAlign: "left",
      }}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}
