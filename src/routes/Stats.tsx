/**
 * Port of `lib/features/stats/stats_screen.dart`.
 *
 * Everything here is derived from the play-history page rather than stored:
 * SoundCloud has no stats endpoint, so the Dart version counted the same way.
 */

import { useMemo } from "react";
import { Link } from "react-router-dom";

import { useHistory } from "@/api/queries";
import { CoverArt } from "@/components/CoverArt";
import { TrackRow } from "@/components/TrackRow";
import { AsyncView, EmptyState, Page, PageTitle, SectionHeader } from "@/components/common";
import * as fmt from "@/lib/format";
import type { Track } from "@/models";

const HISTORY_LIMIT = 200;

export function Stats() {
  const history = useHistory(HISTORY_LIMIT);

  return (
    <Page>
      <PageTitle>stats</PageTitle>
      <AsyncView
        query={history}
        isEmpty={(tracks) => tracks.length === 0}
        empty={
          <EmptyState
            title="no listening data yet"
            hint="Stats are counted from your play history. Play a few tracks and check back."
          />
        }
      >
        {(tracks) => <StatsBody tracks={tracks} />}
      </AsyncView>
    </Page>
  );
}

function StatsBody({ tracks }: { tracks: Track[] }) {
  const { totalMs, artists, genres } = useMemo(() => {
    const byArtist = new Map<string, { count: number; handle: string; cover?: string }>();
    const byGenre = new Map<string, number>();
    let total = 0;

    for (const t of tracks) {
      total += t.durationMs;
      const a = byArtist.get(t.artist) ?? { count: 0, handle: t.artistHandle, cover: t.coverUrl };
      a.count++;
      byArtist.set(t.artist, a);
      byGenre.set(t.genre, (byGenre.get(t.genre) ?? 0) + 1);
    }

    return {
      totalMs: total,
      artists: [...byArtist.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 10),
      genres: [...byGenre.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8),
    };
  }, [tracks]);

  const topCount = artists[0]?.[1].count ?? 1;

  return (
    <>
      <div style={{ display: "flex", gap: 28, marginBottom: "var(--section-gap)" }}>
        <Stat label="tracks played" value={String(tracks.length)} />
        <Stat label="listening time" value={fmt.time(totalMs)} />
        <Stat label="artists" value={String(artists.length)} />
      </div>

      <section style={{ marginBottom: "var(--section-gap)" }}>
        <SectionHeader title="top artists" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {artists.map(([name, info]) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <CoverArt seed={`artist-${name}`} imageUrl={info.cover} size={30} circular />
              <Link
                to={`/artist/${encodeURIComponent(info.handle)}`}
                className="truncate t-body"
                style={{ width: 180, fontSize: 12.5 }}
              >
                {name}
              </Link>
              <div
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: "var(--surface2)",
                  overflow: "hidden",
                  maxWidth: 360,
                }}
              >
                <div
                  style={{
                    width: `${(info.count / topCount) * 100}%`,
                    height: "100%",
                    background: "var(--acid)",
                  }}
                />
              </div>
              <span className="t-mono" style={{ width: 34, textAlign: "right" }}>
                {info.count}
              </span>
            </div>
          ))}
        </div>
      </section>

      {genres.length > 0 && (
        <section style={{ marginBottom: "var(--section-gap)" }}>
          <SectionHeader title="top genres" />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {genres.map(([genre, n]) => (
              <span
                key={genre}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "5px 10px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--surface2)",
                  border: "var(--border-width) solid var(--border)",
                  fontSize: 12,
                }}
              >
                {genre}
                <span className="t-mono" style={{ color: "var(--acid)" }}>
                  {n}
                </span>
              </span>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionHeader title="recently played" />
        {tracks.slice(0, 25).map((t, i) => (
          <TrackRow key={`${t.id}-${i}`} track={t} queue={tracks} index={i} />
        ))}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="t-title" style={{ fontSize: 24, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div className="t-overline" style={{ marginTop: 2 }}>
        {label}
      </div>
    </div>
  );
}
