/**
 * Port of `lib/features/settings/settings_screen.dart` - the same sections in
 * the same order: account, playback, last.fm, cache, logs, about.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import * as api from "@/api/client";
import { Icon } from "@/components/Icon";
import { Page, PageTitle, hoverPill } from "@/components/common";
import { CROSSFADE_MAX_MS, usePrefsStore } from "@/state/prefsStore";
import { useAuthStore } from "@/state/authStore";
import { useUiStore } from "@/state/uiStore";
import { useRail } from "@/api/queries";
import { LoginDialog } from "@/shell/LoginDialog";
import type { LastfmSession } from "@/models";

const REPO_URL = "https://github.com/Doomsos/SoundCloud";

export function Settings() {
  const navigate = useNavigate();
  const [loginOpen, setLoginOpen] = useState(false);

  return (
    <Page>
      <PageTitle>settings</PageTitle>
      <div style={{ maxWidth: 660, display: "flex", flexDirection: "column", gap: 18 }}>
        <AccountSection onLogin={() => setLoginOpen(true)} />
        <PlaybackSection />
        <LastfmSection />
        <CacheSection />
        <Section title="logs">
          <Row label="in-app log history" hint="Everything the app and the API layer have said.">
            <button onClick={() => navigate("/logs")} style={hoverPill}>
              open
            </button>
          </Row>
        </Section>
        <AboutSection />
      </div>
      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </Page>
  );
}

function AccountSection({ onLogin }: { onLogin: () => void }) {
  const { authenticated, signOut } = useAuthStore();
  const rail = useRail();
  const me = rail.data?.me;

  return (
    <Section title="account">
      <Row
        label={authenticated ? (me?.name ?? "signed in") : "not signed in"}
        hint={
          authenticated
            ? `@${me?.handle ?? "…"} — your stream, likes and history are available.`
            : "Browsing works signed out; your own library needs an account."
        }
      >
        {authenticated ? (
          <button onClick={() => void signOut()} style={hoverPill}>
            sign out
          </button>
        ) : (
          <button onClick={onLogin} style={hoverPill}>
            sign in
          </button>
        )}
      </Row>
    </Section>
  );
}

function PlaybackSection() {
  const crossfadeMs = usePrefsStore((s) => s.crossfadeMs);
  const setCrossfadeMs = usePrefsStore((s) => s.setCrossfadeMs);

  return (
    <Section title="playback">
      <Row
        label="crossfade"
        hint={
          crossfadeMs === 0
            ? "Off — tracks cut straight from one to the next."
            : `Overlap the last ${(crossfadeMs / 1000).toFixed(1)}s of a track with the start of the next.`
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="range"
            min={0}
            max={CROSSFADE_MAX_MS}
            step={250}
            value={crossfadeMs}
            onChange={(e) => setCrossfadeMs(Number(e.target.value))}
            style={{ width: 150, accentColor: "var(--acid)" }}
          />
          <span className="t-mono" style={{ width: 42, textAlign: "right" }}>
            {(crossfadeMs / 1000).toFixed(1)}s
          </span>
        </div>
      </Row>
      <Note>
        Crossfading needs the next track pre-buffered, so it does not apply to
        DRM tracks — those decode through a single CDM session and cut instead.
      </Note>
    </Section>
  );
}

function LastfmSection() {
  const [configured, setConfigured] = useState(false);
  const [session, setSession] = useState<LastfmSession | null>(null);
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const showToast = useUiStore((s) => s.showToast);

  useEffect(() => {
    void api.safe(() => api.lastfmConfigured(), false, "lastfm").then(setConfigured);
    void api.safe(() => api.lastfmSession(), null, "lastfm").then(setSession);
  }, []);

  if (!configured) {
    return (
      <Section title="last.fm">
        <Note>
          This build has no last.fm API key compiled in. Rebuild with
          <code className="t-code"> LASTFM_API_KEY</code> and
          <code className="t-code"> LASTFM_SHARED_SECRET</code> set to enable
          scrobbling.
        </Note>
      </Section>
    );
  }

  const connect = async () => {
    try {
      const token = await api.lastfmBeginAuth();
      setPendingToken(token);
      showToast("approve the request in your browser, then press finish", {
        durationMs: 6000,
      });
    } catch (e) {
      showToast(String(e));
    }
  };

  const finish = async () => {
    if (!pendingToken) return;
    const s = await api.safe(() => api.lastfmCompleteAuth(pendingToken), null, "lastfm");
    if (s) {
      setSession(s);
      setPendingToken(null);
      showToast(`connected as ${s.name}`);
    } else {
      showToast("last.fm did not accept that yet — approve it and try again");
    }
  };

  return (
    <Section title="last.fm">
      <Row
        label={session ? `connected as ${session.name}` : "not connected"}
        hint="Scrobbles at half the track, or four minutes, whichever comes first."
      >
        {session ? (
          <button
            onClick={async () => {
              await api.lastfmSignOut();
              setSession(null);
            }}
            style={hoverPill}
          >
            disconnect
          </button>
        ) : pendingToken ? (
          <button onClick={() => void finish()} style={hoverPill}>
            finish
          </button>
        ) : (
          <button onClick={() => void connect()} style={hoverPill}>
            connect
          </button>
        )}
      </Row>
    </Section>
  );
}

function CacheSection() {
  const [size, setSize] = useState<number | null>(null);
  const [dir, setDir] = useState("");
  const showToast = useUiStore((s) => s.showToast);

  const refresh = () => {
    void api.safe(() => api.cacheSize(), 0, "cache size").then(setSize);
  };

  useEffect(() => {
    refresh();
    void api.safe(() => api.appDataDir(), "", "data dir").then(setDir);
  }, []);

  return (
    <Section title="cache">
      <Row
        label="cached audio"
        hint="Played tracks are kept on disk so they start instantly next time. Trimmed to 512 MB, oldest first."
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="t-mono">{size === null ? "…" : formatBytes(size)}</span>
          <button
            onClick={async () => {
              await api.cacheClear();
              refresh();
              showToast("cache cleared");
            }}
            style={hoverPill}
          >
            <Icon name="trash" size={13} />
            clear
          </button>
        </div>
      </Row>
      <Row label="data folder" hint={dir || "…"}>
        <button onClick={() => void api.revealDataDir()} style={hoverPill}>
          <Icon name="openInNew" size={13} />
          reveal
        </button>
      </Row>
    </Section>
  );
}

function AboutSection() {
  return (
    <Section title="about">
      <Row
        label="SoundCloud"
        hint="Tauri v2 · Rust core · React frontend. An unofficial client; not affiliated with SoundCloud."
      >
        <button onClick={() => void api.openExternal(REPO_URL)} style={hoverPill}>
          <Icon name="openInNew" size={13} />
          repo
        </button>
      </Row>
    </Section>
  );
}

// ---- layout --------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: "var(--surface)",
        border: "var(--border-width) solid var(--border-dim)",
        borderRadius: "var(--radius-md)",
        padding: "14px 16px",
      }}
    >
      <div className="t-overline" style={{ marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "8px 0",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="t-body" style={{ fontSize: 12.5 }}>
          {label}
        </div>
        {hint && (
          <div className="t-label" style={{ fontSize: 11, marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="t-label" style={{ fontSize: 11, color: "var(--text-low)", paddingTop: 4 }}>
      {children}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
