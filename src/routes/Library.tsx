/**
 * Port of `lib/features/library/library_screen.dart`.
 *
 * Six tabs, as the Dart `_tabs` had them. Likes is the odd one out: it pages
 * through `next_href` rather than reading `LibraryData.likes`, because a real
 * library is thousands of tracks and the bulk call only returns fifty. Every
 * tab shares the in-tab filter field.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useLibrary, useLikedTracks } from "@/api/queries";
import { CardGrid } from "@/components/CollectionCard";
import { Icon } from "@/components/Icon";
import { TrackRow } from "@/components/TrackRow";
import {
  AsyncView,
  EmptyState,
  LoadingRow,
  Page,
  PageTitle,
} from "@/components/common";
import type { Collection, Track } from "@/models";
import { useAuthStore } from "@/state/authStore";

const TABS = ["likes", "playlists", "albums", "stations", "following", "history"] as const;
type Tab = (typeof TABS)[number];

export function Library() {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");

  const raw = params.get("tab") ?? "likes";
  // `/library` with no tab lands on likes, matching the nav's active rule.
  const tab: Tab = (TABS as readonly string[]).includes(raw) ? (raw as Tab) : "likes";

  return (
    <Page>
      <PageTitle>library</PageTitle>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginBottom: 20,
          borderBottom: "var(--border-width) solid var(--border-dim)",
          paddingBottom: 8,
          flexWrap: "wrap",
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setParams({ tab: t })}
            style={{
              height: 28,
              padding: "0 11px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              fontWeight: tab === t ? 600 : 500,
              background: tab === t ? "var(--surface3)" : "transparent",
              color: tab === t ? "var(--text-hi)" : "var(--text-mid)",
              transition: `background var(--motion) var(--ease)`,
            }}
          >
            {t}
          </button>
        ))}

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 7,
            height: 28,
            padding: "0 9px",
            borderRadius: "var(--radius-sm)",
            background: "var(--surface)",
            border: "var(--border-width) solid var(--border-dim)",
          }}
        >
          <Icon name="search" size={13} color="var(--text-low)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`filter ${tab}`}
            style={{ width: 150, fontSize: 12, userSelect: "text" }}
          />
        </div>
      </div>

      {tab === "likes" ? <LikesTab query={query} /> : <BulkTab tab={tab} query={query} />}
    </Page>
  );
}

// ---- likes ---------------------------------------------------------------

function LikesTab({ query }: { query: string }) {
  const likes = useLikedTracks();
  const authenticated = useAuthStore((s) => s.authenticated);
  const sentinel = useRef<HTMLDivElement>(null);

  const tracks = useMemo(
    () => likes.data?.pages.flatMap((p) => p.tracks) ?? [],
    [likes.data],
  );
  const filtered = useMemo(() => filterTracks(tracks, query), [tracks, query]);

  // Filtering only sees what has loaded, so a search keeps pulling pages in
  // until the list is complete - the Dart tab did the same on a query.
  const wantsMore = query.trim().length > 0;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !likes.hasNextPage || likes.isFetchingNextPage) return;
    if (wantsMore) {
      void likes.fetchNextPage();
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void likes.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [likes, wantsMore]);

  if (likes.isPending) return <LoadingRow label="loading likes" />;
  if (likes.isError) {
    return (
      <EmptyState
        title="couldn't load your likes"
        hint={String(likes.error)}
      />
    );
  }
  if (tracks.length === 0) {
    return <SignedOutOr authenticated={authenticated} what="likes" />;
  }
  if (filtered.length === 0) {
    return <EmptyState title="nothing matches that filter" />;
  }

  return (
    <div>
      {filtered.map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} queue={filtered} index={i} />
      ))}
      <div ref={sentinel} style={{ height: 1 }} />
      {likes.isFetchingNextPage && <LoadingRow label="loading more" />}
    </div>
  );
}

// ---- everything else -----------------------------------------------------

function BulkTab({ tab, query }: { tab: Exclude<Tab, "likes">; query: string }) {
  const library = useLibrary();
  const authenticated = useAuthStore((s) => s.authenticated);

  return (
    <AsyncView query={library}>
      {(data) => {
        if (tab === "history") {
          const items = filterTracks(data.history, query);
          if (data.history.length === 0) {
            return <SignedOutOr authenticated={authenticated} what="history" />;
          }
          if (items.length === 0) return <EmptyState title="nothing matches that filter" />;
          return (
            <div>
              {items.map((t, i) => (
                <TrackRow key={`${t.id}-${i}`} track={t} queue={items} index={i} />
              ))}
            </div>
          );
        }

        const source = {
          playlists: data.playlists,
          albums: data.albums,
          stations: data.stations,
          following: data.following,
        }[tab];

        if (source.length === 0) {
          return <SignedOutOr authenticated={authenticated} what={tab} />;
        }
        const items = filterCollections(source, query);
        if (items.length === 0) return <EmptyState title="nothing matches that filter" />;
        return <CardGrid items={items} />;
      }}
    </AsyncView>
  );
}

const filterTracks = (tracks: Track[], q: string): Track[] => {
  const needle = q.trim().toLowerCase();
  if (!needle) return tracks;
  return tracks.filter(
    (t) =>
      t.title.toLowerCase().includes(needle) || t.artist.toLowerCase().includes(needle),
  );
};

const filterCollections = (items: Collection[], q: string): Collection[] => {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (c) =>
      c.title.toLowerCase().includes(needle) || c.subtitle.toLowerCase().includes(needle),
  );
};

function SignedOutOr({ authenticated, what }: { authenticated: boolean; what: string }) {
  return authenticated ? (
    <EmptyState
      title={`no ${what} yet`}
      hint="Once you have some, they show up here."
    />
  ) : (
    <EmptyState
      title={`sign in to see your ${what}`}
      hint="Your library is tied to your SoundCloud account. Sign in from the bottom of the sidebar."
    />
  );
}
