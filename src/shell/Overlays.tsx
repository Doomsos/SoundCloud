/**
 * Floating layers: the omnibox, the shortcuts sheet and toasts. Ports
 * `omnibox_dropdown.dart`, `shortcuts_overlay.dart` and `toast.dart`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import * as api from "@/api/client";
import { useSearch } from "@/api/queries";
import { CoverArt } from "@/components/CoverArt";
import { Icon } from "@/components/Icon";
import { Spinner } from "@/components/common";
import { SHORTCUT_HELP } from "@/lib/shortcuts";
import { usePlayerStore } from "@/state/playerStore";
import { useUiStore } from "@/state/uiStore";
import { useRecentQueries } from "@/state/links";

// ---------------------------------------------------------------- omnibox

type Row =
  | { kind: "track"; id: string; title: string; subtitle: string; cover?: string }
  | { kind: "artist"; handle: string; title: string; subtitle: string; cover?: string }
  | { kind: "playlist"; id: string; title: string; subtitle: string; cover?: string }
  | { kind: "link"; url: string; title: string; subtitle: string }
  | { kind: "recent"; query: string; title: string; subtitle: string };

export function Omnibox() {
  const navigate = useNavigate();
  const close = useUiStore((s) => s.closeOmnibox);
  const query = useUiStore((s) => s.omniboxQuery);
  const setQuery = useUiStore((s) => s.setOmniboxQuery);

  const [debounced, setDebounced] = useState(query);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Typing should not fire a search per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query), 220);
    return () => window.clearTimeout(id);
  }, [query]);

  const looksLikeUrl = /soundcloud\.com\//i.test(query.trim());
  const results = useSearch(looksLikeUrl ? "" : debounced);

  const recents = useRecentQueries((s) => s.queries);
  const rememberQuery = useRecentQueries((s) => s.add);

  const rows = useMemo<Row[]>(() => {
    if (looksLikeUrl) {
      return [
        {
          kind: "link",
          url: query.trim(),
          title: "open this link",
          subtitle: query.trim(),
        },
      ];
    }
    if (!query.trim()) {
      return recents.map<Row>((q) => ({
        kind: "recent",
        query: q,
        title: q,
        subtitle: "recent search",
      }));
    }
    const d = results.data;
    if (!d) return [];
    return [
      ...d.tracks.slice(0, 6).map<Row>((t) => ({
        kind: "track",
        id: t.id,
        title: t.title,
        subtitle: t.artist,
        cover: t.coverUrl,
      })),
      ...d.artists.slice(0, 3).map<Row>((a) => ({
        kind: "artist",
        handle: a.handle,
        title: a.name,
        subtitle: "artist",
        cover: a.avatarUrl,
      })),
      ...d.playlists.slice(0, 3).map<Row>((p) => ({
        kind: "playlist",
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        cover: p.coverUrl,
      })),
    ];
  }, [results.data, looksLikeUrl, query, recents]);

  useEffect(() => setSelected(0), [rows.length]);

  const open = async (row: Row) => {
    if (row.kind === "recent") {
      // Re-run it rather than navigating: the user is refining a search.
      setQuery(row.query);
      return;
    }
    close();
    switch (row.kind) {
      case "track":
        navigate(`/track/${row.id}`);
        break;
      case "artist":
        navigate(`/artist/${encodeURIComponent(row.handle)}`);
        break;
      case "playlist":
        navigate(`/playlist/${encodeURIComponent(row.id)}`);
        break;
      case "link": {
        const route = await api.resolveUrl(row.url);
        if (route) navigate(route);
        else useUiStore.getState().showToast("that link did not resolve");
        break;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[selected]) void open(rows[selected]);
      else if (query.trim()) {
        rememberQuery(query.trim());
        close();
        navigate(`/search?q=${encodeURIComponent(query.trim())}`);
      }
    }
  };

  return (
    <div
      onMouseDown={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(13,13,15,0.45)",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "14vh",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, calc(100vw - 48px))",
          background: "var(--surface)",
          border: "var(--border-width) solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            height: 48,
            borderBottom: "var(--border-width) solid var(--border-dim)",
          }}
        >
          <Icon name="search" size={16} color="var(--text-low)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search tracks, artists, playlists — or paste a link"
            style={{ flex: 1, fontSize: 14, userSelect: "text" }}
          />
          {results.isFetching && <Spinner />}
        </div>

        <div style={{ maxHeight: "46vh", overflowY: "auto", padding: 6 }}>
          {rows.length === 0 ? (
            <div className="t-label" style={{ padding: "18px 10px", color: "var(--text-low)" }}>
              {query.trim() ? "no matches" : "start typing to search"}
            </div>
          ) : (
            rows.map((row, i) => (
              <button
                key={`${row.kind}-${i}`}
                onMouseEnter={() => setSelected(i)}
                onClick={() => void open(row)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: 6,
                  borderRadius: "var(--radius-sm)",
                  background: i === selected ? "var(--surface2)" : "transparent",
                  textAlign: "left",
                }}
              >
                {row.kind === "link" || row.kind === "recent" ? (
                  <div style={{ width: 32, display: "grid", placeItems: "center" }}>
                    <Icon
                      name={row.kind === "link" ? "link" : "history"}
                      size={16}
                      color={row.kind === "link" ? "var(--acid)" : "var(--text-low)"}
                    />
                  </div>
                ) : (
                  <CoverArt
                    seed={row.title}
                    imageUrl={row.cover}
                    size={32}
                    circular={row.kind === "artist"}
                  />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="truncate t-body">{row.title}</div>
                  <div className="truncate t-label" style={{ fontSize: 11 }}>
                    {row.subtitle}
                  </div>
                </div>
                {i === selected && (
                  <span className="t-mono" style={{ fontSize: 10 }}>
                    ↵
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- shortcuts

export function ShortcutsOverlay() {
  const close = useUiStore((s) => s.closeShortcuts);
  return (
    <div
      onMouseDown={close}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(13,13,15,0.55)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, 100%)",
          maxHeight: "80vh",
          overflowY: "auto",
          padding: 22,
          background: "var(--surface)",
          border: "var(--border-width) solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 18,
          }}
        >
          <h2 className="t-title" style={{ margin: 0, fontSize: 16 }}>
            keyboard shortcuts
          </h2>
          <button onClick={close} title="close" style={{ display: "flex" }}>
            <Icon name="close" size={16} color="var(--text-low)" />
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 24,
          }}
        >
          {SHORTCUT_HELP.map((group) => (
            <div key={group.group}>
              <div className="t-overline" style={{ marginBottom: 8 }}>
                {group.group}
              </div>
              {group.items.map(([keys, what]) => (
                <div
                  key={keys}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    height: 26,
                  }}
                >
                  <span className="t-label">{what}</span>
                  <kbd
                    className="t-code"
                    style={{
                      padding: "2px 6px",
                      background: "var(--surface2)",
                      border: "var(--border-width) solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      color: "var(--text-hi)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {keys}
                  </kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  return (
    <div
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: `calc(var(--player-height) + 16px)`,
        zIndex: 500,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 12,
            maxWidth: 520,
            padding: "9px 14px",
            background: "var(--surface3)",
            border: "var(--border-width) solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
            animation: "wf-toast-in 160ms var(--ease)",
          }}
        >
          <span className="t-body" style={{ fontSize: 12.5 }}>
            {t.message}
          </span>
          {t.action && (
            <button
              onClick={() => {
                t.action?.onTap();
                dismiss(t.id);
              }}
              style={{ fontSize: 12, fontWeight: 600, color: "var(--acid)" }}
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} title="dismiss" style={{ display: "flex" }}>
            <Icon name="close" size={13} color="var(--text-low)" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Shown when a track could not be played, driven by `state.unplayable`. */
export function useUnplayableToast() {
  const unplayable = usePlayerStore((s) => s.unplayable);
  const showToast = useUiStore((s) => s.showToast);
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!unplayable || unplayable.seq === lastSeq.current) return;
    lastSeq.current = unplayable.seq;

    const message =
      unplayable.lock === "goPlus"
        ? `“${unplayable.title}” is GO+ only — can't play without a subscription`
        : unplayable.lock === "drm"
          ? `“${unplayable.title}” is DRM-protected and could not be decoded`
          : `“${unplayable.title}” is unavailable — skipped`;

    showToast(message, { durationMs: 3000 });
  }, [unplayable, showToast]);
}
