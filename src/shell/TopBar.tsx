/**
 * The title bar. Port of `lib/shared/widgets/top_bar.dart`.
 *
 * The whole strip is a drag region except the controls sitting on it; the
 * search field is centred on the *window*, not on the bar, so it stays
 * optically centred with the nav rail to its left.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Icon, type IconName } from "@/components/Icon";
import { useUiStore } from "@/state/uiStore";
import { WindowControls, WINDOW_CONTROLS_WIDTH } from "./WindowControls";
import { isMac } from "@/lib/shortcuts";

const SEARCH_WIDTH = 320;

export function TopBar({ canGoBack, navWidth }: { canGoBack: boolean; navWidth: number }) {
  const navigate = useNavigate();
  const queueVisible = useUiStore((s) => s.queueVisible);
  const toggleQueue = useUiStore((s) => s.toggleQueue);
  const openOmnibox = useUiStore((s) => s.openOmnibox);

  return (
    <header
      data-tauri-drag-region
      style={{
        height: "var(--top-bar-height)",
        flexShrink: 0,
        position: "relative",
        background: "var(--bg)",
        borderBottom: "var(--border-width) solid var(--border-dim)",
        display: "flex",
        alignItems: "center",
      }}
    >
      <div style={{ paddingLeft: 8, display: "flex", zIndex: 1 }}>
        <BarButton
          icon="arrowBack"
          label="back"
          enabled={canGoBack}
          onClick={() => navigate(-1)}
        />
      </div>

      {/* Centred on the window: the nav rail's width is added back in. */}
      <div
        style={{
          position: "absolute",
          left: `calc(50% - ${navWidth / 2}px - ${SEARCH_WIDTH / 2}px)`,
          width: SEARCH_WIDTH,
          maxWidth: `calc(100% - ${WINDOW_CONTROLS_WIDTH + 160}px)`,
        }}
      >
        <SearchField onClick={openOmnibox} />
      </div>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", height: "100%" }}>
        {import.meta.env.DEV && (
          <BarButton icon="terminal" label="logs" onClick={() => navigate("/logs")} />
        )}
        <BarButton
          icon="playlistPlay"
          label="queue"
          active={queueVisible}
          onClick={toggleQueue}
        />
        <div style={{ width: 6 }} />
        <WindowControls />
      </div>
    </header>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  active = false,
  enabled = true,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  enabled?: boolean;
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
      title={enabled ? label : undefined}
      aria-label={label}
      disabled={!enabled}
      style={{
        width: 30,
        height: 30,
        margin: "0 2px",
        display: "grid",
        placeItems: "center",
        borderRadius: "var(--radius-sm)",
        background: hover && enabled ? "var(--surface2)" : "transparent",
        transition: `background var(--motion) var(--ease)`,
        cursor: enabled ? "pointer" : "default",
      }}
    >
      <Icon name={icon} size={17} color={color} />
    </button>
  );
}

/** Not a real input: clicking it opens the omnibox, which owns the field. */
function SearchField({ onClick }: { onClick: () => void }) {
  const query = useUiStore((s) => s.omniboxQuery);
  const [hover, setHover] = useState(false);

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        height: 30,
        padding: "0 9px",
        borderRadius: "var(--radius-sm)",
        background: hover ? "var(--surface2)" : "var(--surface)",
        border: `var(--border-width) solid ${hover ? "var(--border)" : "var(--border-dim)"}`,
        transition: `background var(--motion) var(--ease)`,
      }}
    >
      <Icon name="search" size={15} color={hover ? "var(--text-mid)" : "var(--text-low)"} />
      <span
        className="truncate"
        style={{
          flex: 1,
          textAlign: "left",
          fontSize: 12.5,
          fontWeight: 400,
          color: query ? "var(--text-hi)" : "var(--text-low)",
        }}
      >
        {query || "search"}
      </span>
      <span className="t-mono" style={{ fontSize: 10, fontWeight: 500, color: "var(--text-low)" }}>
        {isMac() ? "⌘K" : "Ctrl K"}
      </span>
    </button>
  );
}
