/** Port of `lib/features/search/search_screen.dart`. */

import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useSearch } from "@/api/queries";
import { CardGrid } from "@/components/CollectionCard";
import { CollectionCard } from "@/components/CollectionCard";
import { TrackRow } from "@/components/TrackRow";
import { AsyncView, EmptyState, Page, PageTitle } from "@/components/common";
import type { Artist, Collection } from "@/models";

const TABS = ["tracks", "artists", "playlists"] as const;
type Tab = (typeof TABS)[number];

export function Search() {
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const results = useSearch(query);
  const [tab, setTab] = useState<Tab>("tracks");

  if (!query.trim()) {
    return (
      <Page>
        <PageTitle>search</PageTitle>
        <EmptyState
          title="what are you after?"
          hint="Press Ctrl/⌘ K, or S, to open the omnibox. You can paste a soundcloud.com link into it too."
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageTitle>{`search: ${query}`}</PageTitle>

      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 20,
          borderBottom: "var(--border-width) solid var(--border-dim)",
          paddingBottom: 8,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              height: 28,
              padding: "0 11px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              fontWeight: tab === t ? 600 : 500,
              background: tab === t ? "var(--surface3)" : "transparent",
              color: tab === t ? "var(--text-hi)" : "var(--text-mid)",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <AsyncView query={results}>
        {(d) => {
          if (tab === "tracks") {
            return d.tracks.length === 0 ? (
              <EmptyState title="no tracks found" />
            ) : (
              <div>
                {d.tracks.map((t, i) => (
                  <TrackRow key={t.id} track={t} queue={d.tracks} index={i} />
                ))}
              </div>
            );
          }
          if (tab === "artists") {
            return d.artists.length === 0 ? (
              <EmptyState title="no artists found" />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
                  gap: "var(--card-gap)",
                  justifyItems: "start",
                }}
              >
                {d.artists.map((a) => (
                  <CollectionCard key={a.id} item={artistAsCard(a)} size={140} />
                ))}
              </div>
            );
          }
          return d.playlists.length === 0 ? (
            <EmptyState title="no playlists found" />
          ) : (
            <CardGrid items={d.playlists} />
          );
        }}
      </AsyncView>
    </Page>
  );
}

/** Artists are rendered with the shared card, so they are adapted here. */
function artistAsCard(a: Artist): Collection {
  return {
    id: a.id,
    title: a.name,
    subtitle: `${a.followers} followers`,
    kind: "station",
    trackCount: 0,
    minted: false,
    coverUrl: a.avatarUrl,
    target: "artist",
    handle: a.handle,
    isCircular: true,
    coverSeed: a.coverSeed,
  };
}
