/**
 * The left rail. Port of `lib/shared/widgets/side_nav.dart`.
 *
 * Collapses to icons below 1080px, matching `AppTheme.navCollapseBelow`.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { Icon, ScLogo, type IconName } from "@/components/Icon";
import { CoverArt } from "@/components/CoverArt";
import { useAuthStore } from "@/state/authStore";
import { useRail } from "@/api/queries";

interface NavEntry {
  icon: IconName;
  activeIcon: IconName;
  label: string;
  path: string;
}

const MAIN: NavEntry[] = [
  { icon: "homeOutline", activeIcon: "home", label: "home", path: "/" },
  { icon: "rss", activeIcon: "rss", label: "feed", path: "/feed" },
];

const LIBRARY: NavEntry[] = [
  { icon: "heartOutline", activeIcon: "heart", label: "likes", path: "/library?tab=likes" },
  {
    icon: "queueMusic",
    activeIcon: "queueMusic",
    label: "playlists",
    path: "/library?tab=playlists",
  },
  { icon: "album", activeIcon: "album", label: "albums", path: "/library?tab=albums" },
  { icon: "people", activeIcon: "people", label: "following", path: "/library?tab=following" },
  { icon: "history", activeIcon: "history", label: "history", path: "/library?tab=history" },
];

export function SideNav({
  location,
  compact,
  onLogin,
}: {
  location: string;
  compact: boolean;
  onLogin: () => void;
}) {
  const authenticated = useAuthStore((s) => s.authenticated);
  const pad = compact ? 6 : 8;

  return (
    <nav
      style={{
        width: compact ? "var(--nav-width-compact)" : "var(--nav-width)",
        flexShrink: 0,
        background: "var(--nav)",
        borderRight: "var(--border-width) solid var(--border-dim)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          height: "var(--top-bar-height)",
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "center" : "flex-start",
          paddingLeft: compact ? 0 : 16,
          gap: 9,
          flexShrink: 0,
        }}
      >
        <ScLogo size={15} />
        {!compact && (
          <span className="t-body" style={{ fontSize: 14, fontWeight: 600 }}>
            SoundCloud
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: `4px ${pad}px 8px` }}>
        {MAIN.map((e) => (
          <NavItem key={e.path} entry={e} location={location} compact={compact} />
        ))}

        <div style={{ height: 14 }} />
        {compact ? <RailDivider /> : <div className="t-overline" style={{ padding: "0 10px 8px" }}>library</div>}

        {LIBRARY.map((e) => (
          <NavItem key={e.path} entry={e} location={location} compact={compact} />
        ))}
      </div>

      <div style={{ padding: `0 ${pad}px 8px` }}>
        {authenticated && (
          <NavItem
            entry={{ icon: "barChart", activeIcon: "barChart", label: "stats", path: "/stats" }}
            location={location}
            compact={compact}
          />
        )}
        <NavItem
          entry={{ icon: "settings", activeIcon: "settings", label: "settings", path: "/settings" }}
          location={location}
          compact={compact}
        />
        <div style={{ height: 8 }} />
        <RailDivider />
        <div style={{ height: 8 }} />
        <Account compact={compact} onLogin={onLogin} />
      </div>
    </nav>
  );
}

function RailDivider() {
  return (
    <div style={{ height: 1, background: "var(--border-dim)", margin: "6px 8px" }} />
  );
}

/**
 * Active-state rule from the Dart `_NavItem`: `/library` with no tab counts
 * as likes, since that is the tab the library opens on.
 */
function isActive(path: string, location: string): boolean {
  if (path === "/") return location === "/";
  if (path === "/library?tab=likes" && location === "/library") return true;
  if (path.includes("?")) return location === path;
  return location === path || location.startsWith(`${path}?`);
}

function NavItem({
  entry,
  location,
  compact,
}: {
  entry: NavEntry;
  location: string;
  compact: boolean;
}) {
  const navigate = useNavigate();
  const [hover, setHover] = useState(false);
  const active = isActive(entry.path, location);

  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => navigate(entry.path)}
      title={compact ? entry.label : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: compact ? "center" : "flex-start",
        gap: 12,
        width: "100%",
        height: 34,
        marginBottom: 2,
        padding: compact ? 0 : "0 10px",
        borderRadius: "var(--radius-sm)",
        background: active ? "var(--surface3)" : hover ? "var(--surface2)" : "transparent",
        transition: `background var(--motion) var(--ease)`,
      }}
    >
      <Icon
        name={active ? entry.activeIcon : entry.icon}
        size={18}
        color={active ? "var(--acid)" : hover ? "var(--text-hi)" : "var(--text-mid)"}
      />
      {!compact && (
        <span
          className="truncate"
          style={{
            fontSize: 13,
            fontWeight: active ? 600 : 500,
            color: active || hover ? "var(--text-hi)" : "var(--text-mid)",
          }}
        >
          {entry.label}
        </span>
      )}
    </button>
  );
}

function Account({ compact, onLogin }: { compact: boolean; onLogin: () => void }) {
  const navigate = useNavigate();
  const authenticated = useAuthStore((s) => s.authenticated);
  const signOut = useAuthStore((s) => s.signOut);
  const rail = useRail();
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);

  if (!authenticated) {
    return (
      <button
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={onLogin}
        title={compact ? "log in" : undefined}
        style={{
          display: "grid",
          placeItems: "center",
          width: "100%",
          height: 34,
          borderRadius: "var(--radius-sm)",
          background: hover ? "var(--surface3)" : "var(--surface2)",
          transition: `background var(--motion) var(--ease)`,
        }}
      >
        {compact ? (
          <Icon name="login" size={17} color="var(--text-hi)" />
        ) : (
          <span style={{ fontSize: 12, fontWeight: 600 }}>log in</span>
        )}
      </button>
    );
  }

  const me = rail.data?.me;

  return (
    <div style={{ position: "relative" }}>
      {menu && (
        <>
          <div
            onClick={() => setMenu(false)}
            style={{ position: "fixed", inset: 0, zIndex: 20 }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 38,
              left: 0,
              right: 0,
              minWidth: 150,
              zIndex: 21,
              padding: 4,
              background: "var(--surface)",
              border: "var(--border-width) solid var(--border)",
              borderRadius: "var(--radius-md)",
              boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
            }}
          >
            {me && (
              <MenuRow
                label="open profile"
                onClick={() => {
                  setMenu(false);
                  navigate(`/artist/${encodeURIComponent(me.handle)}`);
                }}
              />
            )}
            <MenuRow
              label="log out"
              onClick={() => {
                setMenu(false);
                void signOut();
              }}
            />
          </div>
        </>
      )}

      <button
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => setMenu((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          width: "100%",
          height: 34,
          padding: compact ? 0 : "0 5px",
          justifyContent: compact ? "center" : "flex-start",
          borderRadius: "var(--radius-sm)",
          background: hover ? "var(--surface2)" : "transparent",
          transition: `background var(--motion) var(--ease)`,
        }}
      >
        <CoverArt seed="me" imageUrl={me?.avatarUrl} size={24} circular />
        {!compact && (
          <>
            <span className="truncate" style={{ flex: 1, fontSize: 12.5, textAlign: "left" }}>
              {me?.name ?? "account"}
            </span>
            <Icon name="moreHoriz" size={16} color="var(--text-low)" />
          </>
        )}
      </button>
    </div>
  );
}

function MenuRow({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        height: 30,
        padding: "0 8px",
        textAlign: "left",
        fontSize: 13,
        fontWeight: 400,
        borderRadius: "var(--radius-sm)",
        background: hover ? "var(--surface2)" : "transparent",
        color: hover ? "var(--text-hi)" : "var(--text-mid)",
      }}
    >
      {label}
    </button>
  );
}
