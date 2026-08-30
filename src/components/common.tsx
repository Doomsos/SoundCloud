/**
 * Small shared widgets: `lock_badge.dart`, `async_view.dart`,
 * `empty_state.dart` and the section headers the screens share.
 */

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import { Icon } from "./Icon";
import type { TrackLock } from "@/models";

/**
 * Marks a track that will not stream in full. Go+ is a hard wall; DRM now
 * plays through the PlayReady engine, so its badge is informational - it says
 * why the track took a different path, not that it is blocked.
 */
export function LockBadge({ lock }: { lock: TrackLock }) {
  if (lock === "none") return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        padding: "2px 6px",
        background: "var(--surface2)",
        borderRadius: "var(--radius-sm)",
        border: "var(--border-width) solid var(--border)",
        color: "var(--text-mid)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.5px",
        fontVariantNumeric: "tabular-nums",
      }}
      title={
        lock === "goPlus"
          ? "GO+ only - needs a SoundCloud GO+ subscription"
          : "DRM-protected - played through the PlayReady engine"
      }
    >
      <Icon name="lock" size={9} color="var(--text-mid)" />
      {lock === "goPlus" ? "GO+" : "DRM"}
    </span>
  );
}

/**
 * Renders a query's three states. Port of `async_view.dart`, including its
 * rule that an error is shown inline rather than replacing the whole screen.
 */
export function AsyncView<T>({
  query,
  children,
  empty,
  isEmpty,
  skeleton,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  /** Shown instead of the spinner while loading, when a screen has one. */
  skeleton?: ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <LoadingRow />}</>;
  if (query.isError) {
    return (
      <ErrorRow
        message={String(query.error)}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const data = query.data as T;
  if (empty && isEmpty?.(data)) return <>{empty}</>;
  return <>{children(data)}</>;
}

export function LoadingRow({ label = "loading" }: { label?: string }) {
  return (
    <div
      className="t-label"
      style={{ padding: "32px 0", display: "flex", alignItems: "center", gap: 10 }}
    >
      <Spinner />
      {label}
    </div>
  );
}

export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid var(--surface3)",
        borderTopColor: "var(--acid)",
        display: "inline-block",
        animation: "wf-spin 700ms linear infinite",
      }}
    />
  );
}

/** Port of `skeleton_box.dart`: a shimmering placeholder block. */
export function SkeletonBox({
  width,
  height,
  radius = "var(--radius-sm)",
}: {
  width: number | string;
  height: number;
  radius?: string;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background:
          "linear-gradient(90deg, var(--surface) 25%, var(--surface2) 50%, var(--surface) 75%)",
        backgroundSize: "200% 100%",
        animation: "wf-shimmer 1.4s ease-in-out infinite",
        flexShrink: 0,
      }}
    />
  );
}

export function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      style={{
        padding: 16,
        border: "var(--border-width) solid var(--border)",
        borderRadius: "var(--radius-md)",
        background: "var(--surface)",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <Icon name="info" size={16} color="var(--text-low)" />
      <span className="t-label" style={{ flex: 1, userSelect: "text" }}>
        {message}
      </span>
      {onRetry && (
        <button className="t-label" onClick={onRetry} style={hoverPill}>
          <Icon name="refresh" size={13} />
          retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "56px 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        textAlign: "center",
      }}
    >
      <div className="t-heading" style={{ color: "var(--text-mid)" }}>
        {title}
      </div>
      {hint && (
        <div className="t-label" style={{ color: "var(--text-low)", maxWidth: 420 }}>
          {hint}
        </div>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        marginBottom: "var(--header-gap)",
      }}
    >
      <h2 className="t-overline" style={{ margin: 0 }}>
        {title}
      </h2>
      {action}
    </div>
  );
}

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="t-title" style={{ margin: "0 0 var(--header-gap)" }}>
      {children}
    </h1>
  );
}

export const hoverPill: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 10px",
  borderRadius: "var(--radius-sm)",
  background: "var(--surface2)",
  color: "var(--text-hi)",
  transition: `background var(--motion) var(--ease)`,
};

/** The page container every route sits in. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: `var(--content-pad-top) var(--page-pad) var(--content-pad-bottom)`,
        maxWidth: 1400,
      }}
    >
      {children}
    </div>
  );
}
