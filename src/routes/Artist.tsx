/** Port of `lib/features/artist/artist_screen.dart`. */

import { useParams } from "react-router-dom";

import { useArtistProfile } from "@/api/queries";
import { CardGrid } from "@/components/CollectionCard";
import { CoverArt } from "@/components/CoverArt";
import { Icon } from "@/components/Icon";
import { TrackRow } from "@/components/TrackRow";
import { AsyncView, Page, SectionHeader, hoverPill } from "@/components/common";
import * as fmt from "@/lib/format";
import * as api from "@/api/client";
import { usePlayerStore } from "@/state/playerStore";

export function Artist() {
  const { handle = "" } = useParams();
  const decoded = decodeURIComponent(handle);
  const profile = useArtistProfile(decoded);
  const play = usePlayerStore((s) => s.play);

  return (
    <Page>
      <AsyncView query={profile}>
        {(d) => (
          <>
            <header style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 26 }}>
              <CoverArt
                seed={d.artist.coverSeed}
                imageUrl={d.artist.avatarUrl}
                size={128}
                circular
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h1 className="t-title" style={{ margin: 0, fontSize: 26, userSelect: "text" }}>
                    {d.artist.name}
                  </h1>
                  {d.artist.verified && (
                    <Icon name="verified" size={17} color="var(--acid)" />
                  )}
                </div>
                <div className="t-label" style={{ marginTop: 3 }}>
                  @{d.artist.handle}
                </div>

                <div className="t-mono" style={{ display: "flex", gap: 16, marginTop: 12 }}>
                  <span>{fmt.count(d.artist.followers)} followers</span>
                  <span>{fmt.count(d.artist.trackCount)} tracks</span>
                  <span>{fmt.count(d.artist.playlistCount)} playlists</span>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                  <button
                    onClick={() => {
                      if (d.tracks.length > 0) play(d.tracks[0], d.tracks);
                    }}
                    disabled={d.tracks.length === 0}
                    style={{
                      ...hoverPill,
                      height: 32,
                      padding: "0 14px",
                      background: d.tracks.length ? "var(--acid)" : "var(--surface3)",
                      color: d.tracks.length ? "var(--bg)" : "var(--text-low)",
                      fontWeight: 600,
                    }}
                  >
                    <Icon
                      name="play"
                      size={14}
                      color={d.tracks.length ? "var(--bg)" : "var(--text-low)"}
                    />
                    play
                  </button>
                  <button
                    onClick={() =>
                      void api.openExternal(`https://soundcloud.com/${d.artist.handle}`)
                    }
                    style={hoverPill}
                  >
                    <Icon name="openInNew" size={13} />
                    open in browser
                  </button>
                </div>
              </div>
            </header>

            {d.tracks.length > 0 && (
              <section style={{ marginBottom: "var(--section-gap)" }}>
                <SectionHeader title="tracks" />
                {d.tracks.map((t, i) => (
                  <TrackRow key={t.id} track={t} queue={d.tracks} index={i} />
                ))}
              </section>
            )}

            {d.albums.length > 0 && (
              <section style={{ marginBottom: "var(--section-gap)" }}>
                <SectionHeader title="albums" />
                <CardGrid items={d.albums} />
              </section>
            )}

            {d.playlists.length > 0 && (
              <section>
                <SectionHeader title="playlists" />
                <CardGrid items={d.playlists} />
              </section>
            )}
          </>
        )}
      </AsyncView>
    </Page>
  );
}
