/**
 * Custom caption buttons. Port of `lib/shared/widgets/window_controls.dart`.
 *
 * The window is built with `decorations: false` so the title bar can be part
 * of the UI, which means minimise/maximise/close are ours to draw. Close
 * hides to the tray - the Rust side intercepts `CloseRequested` - so playback
 * survives it; the tray menu holds the real quit.
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Icon, type IconName } from "@/components/Icon";

export const WINDOW_CONTROLS_WIDTH = 138;

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const win = getCurrentWindow();

  useEffect(() => {
    let alive = true;
    void win.isMaximized().then((v) => alive && setMaximized(v));
    // A double-click on the drag region, or a snap gesture, changes this
    // without going through our buttons.
    const unlisten = win.onResized(() => {
      void win.isMaximized().then((v) => alive && setMaximized(v));
    });
    return () => {
      alive = false;
      void unlisten.then((f) => f());
    };
  }, [win]);

  return (
    <div style={{ display: "flex", height: "100%", alignItems: "stretch" }}>
      <CaptionButton icon="minimize" label="minimise" onClick={() => void win.minimize()} />
      <CaptionButton
        icon={maximized ? "restore" : "maximize"}
        label={maximized ? "restore" : "maximise"}
        onClick={() => void win.toggleMaximize()}
      />
      <CaptionButton icon="close" label="close" danger onClick={() => void win.close()} />
    </div>
  );
}

function CaptionButton({
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
        width: 46,
        display: "grid",
        placeItems: "center",
        background: hover ? (danger ? "#c42b1c" : "var(--surface2)") : "transparent",
        color: hover && danger ? "#fff" : "var(--text-mid)",
        transition: `background var(--motion) var(--ease)`,
      }}
    >
      <Icon name={icon} size={icon === "close" ? 15 : 13} />
    </button>
  );
}
