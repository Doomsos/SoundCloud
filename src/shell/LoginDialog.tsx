/**
 * Sign-in. Port of `lib/features/auth/login_dialog.dart`.
 *
 * Two routes in, as the Dart dialog had: the proper OAuth browser flow, which
 * needs an app client id, and pasting an `OAuth` token straight from a logged
 * in soundcloud.com session for anyone who does not want to register an app.
 */

import { useEffect, useState } from "react";

import * as api from "@/api/client";
import { Icon, ScLogo } from "@/components/Icon";
import { Spinner } from "@/components/common";
import { useAuthStore } from "@/state/authStore";

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const { signingIn, error, compiledIn, signIn, signInWithToken, saveClientId, clearError } =
    useAuthStore();

  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [mode, setMode] = useState<"oauth" | "token">("oauth");

  useEffect(() => {
    if (compiledIn) return;
    void api.safe(() => api.authGetClientId(), "", "client id").then(setClientId);
  }, [compiledIn]);

  // Close as soon as the sign-in lands.
  useEffect(
    () =>
      useAuthStore.subscribe((s) => {
        if (s.authenticated) onClose();
      }),
    [onClose],
  );

  useEffect(() => () => clearError(), [clearError]);

  const startOauth = async () => {
    if (!compiledIn) await saveClientId(clientId);
    await signIn();
  };

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 320,
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
          width: "min(460px, 100%)",
          padding: 24,
          background: "var(--surface)",
          border: "var(--border-width) solid var(--border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "0 18px 60px rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <ScLogo size={18} />
          <h2 className="t-title" style={{ margin: 0, fontSize: 16, flex: 1 }}>
            sign in to SoundCloud
          </h2>
          <button onClick={onClose} title="close" style={{ display: "flex" }}>
            <Icon name="close" size={16} color="var(--text-low)" />
          </button>
        </div>

        <p className="t-label" style={{ margin: "0 0 18px" }}>
          Browsing works signed out. Signing in adds your stream, likes,
          playlists and history.
        </p>

        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          <Tab active={mode === "oauth"} onClick={() => setMode("oauth")} label="browser sign-in" />
          <Tab active={mode === "token"} onClick={() => setMode("token")} label="paste a token" />
        </div>

        {mode === "oauth" ? (
          <>
            {!compiledIn && (
              <Field
                label="OAuth client id"
                hint="From your app at soundcloud.com/you/apps. Stored locally."
                value={clientId}
                onChange={setClientId}
                placeholder="your app's client_id"
              />
            )}
            <button
              onClick={() => void startOauth()}
              disabled={signingIn || (!compiledIn && clientId.trim() === "")}
              style={primaryButton(signingIn || (!compiledIn && clientId.trim() === ""))}
            >
              {signingIn ? <Spinner size={12} /> : <Icon name="openInNew" size={14} color="var(--bg)" />}
              {signingIn ? "waiting for the browser…" : "open browser and sign in"}
            </button>
            {signingIn && (
              <p className="t-label" style={{ marginTop: 10, fontSize: 11 }}>
                Approve the request in your browser. This window will close on
                its own once it lands.
              </p>
            )}
          </>
        ) : (
          <>
            <Field
              label="OAuth token"
              hint="DevTools → Application → Cookies → soundcloud.com → oauth_token."
              value={token}
              onChange={setToken}
              placeholder="2-294538-…"
              mono
            />
            <button
              onClick={() => void signInWithToken(token)}
              disabled={signingIn || token.trim() === ""}
              style={primaryButton(signingIn || token.trim() === "")}
            >
              {signingIn ? <Spinner size={12} /> : <Icon name="check" size={14} color="var(--bg)" />}
              {signingIn ? "verifying…" : "verify and sign in"}
            </button>
          </>
        )}

        {error && (
          <div
            style={{
              marginTop: 14,
              padding: "9px 12px",
              borderRadius: "var(--radius-sm)",
              background: "rgba(196,43,28,0.12)",
              border: "var(--border-width) solid rgba(196,43,28,0.4)",
            }}
          >
            <span className="t-label" style={{ color: "#ff9b90", userSelect: "text" }}>
              {error}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        height: 30,
        borderRadius: "var(--radius-sm)",
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        background: active ? "var(--surface3)" : "transparent",
        color: active ? "var(--text-hi)" : "var(--text-mid)",
        transition: `background var(--motion) var(--ease)`,
      }}
    >
      {label}
    </button>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="t-overline" style={{ marginBottom: 6 }}>
        {label}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        style={{
          width: "100%",
          height: 32,
          padding: "0 10px",
          borderRadius: "var(--radius-sm)",
          background: "var(--bg)",
          border: "var(--border-width) solid var(--border)",
          fontFamily: mono ? "var(--mono)" : "var(--sans)",
          fontSize: mono ? 11.5 : 13,
          userSelect: "text",
        }}
      />
      <div className="t-label" style={{ marginTop: 5, fontSize: 11, color: "var(--text-low)" }}>
        {hint}
      </div>
    </div>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    width: "100%",
    height: 34,
    borderRadius: "var(--radius-sm)",
    background: disabled ? "var(--surface3)" : "var(--acid)",
    color: disabled ? "var(--text-low)" : "var(--bg)",
    fontSize: 13,
    fontWeight: 600,
    cursor: disabled ? "default" : "pointer",
    transition: `background var(--motion) var(--ease)`,
  };
}
