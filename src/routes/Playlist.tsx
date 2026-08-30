/** Port of `lib/features/playlist/playlist_screen.dart`. */

import { useParams } from "react-router-dom";

import { usePlaylist, usePlaylistTracks } from "@/api/queries";
import { CoverArt } from "@/components/CoverArt";
import { Icon } from "@/components/Icon";
import { TrackRow } from "@/components/TrackRow";
import { AsyncView, LoadingRow, Page, hoverPill } from "@/components/common";
import * as fmt from "@/lib/format";
import { usePlayerStore } from "@/state/playerStore";

export function Playlist() {
  const { id = "" } = useParams();
  const decoded = decodeURIComponent(id);

  const detail = usePlaylist(decoded);
  // The playlist payload only inlines the first few tracks; this hydrates the
  // rest, and is what "play all" needs.
  const full = usePlaylistTracks(decoded, detail.isSuccess);
  const play = usePlayerStore((s) => s.play);

  return (
    <Page>
      <AsyncView query={detail}>
        {(d) => {
          const tracks = full.data ?? d.tracks;
          const totalMs = tracks.reduce((sum, t) => sum + t.durationMs, 0);

          return (
            <>
              <header style={{ display: "flex", gap: 20, marginBottom: 24 }}>
                <CoverArt
                  seed={d.playlist.coverSeed}
                  imageUrl={d.playlist.coverUrl}
                  size={168}
                />
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <div className="t-overline">{d.playlist.kind}</div>
                  <h1
                    className="t-title"
                    style={{ margin: "6px 0 4px", fontSize: 26, userSelect: "text" }}
                  >
                    {d.playlist.title}
                  </h1>
                  <div className="t-label">{d.playlist.subtitle}</div>
                  <div className="t-mono" style={{ marginTop: 10 }}>
                    {tracks.length || d.playlist.trackCount} tracks
                    {totalMs > 0 && ` · ${fmt.time(totalMs)}`}
                  </div>

                  <div style={{ marginTop: "auto", paddingTop: 18, display: "flex", gap: 8 }}>
                    <button
                      onClick={() => {
                        if (tracks.length > 0) play(tracks[0], tracks);
                      }}
                      disabled={tracks.length === 0}
                      style={{
                        ...hoverPill,
                        height: 34,
                        padding: "0 16px",
                        background: tracks.length ? "var(--acid)" : "var(--surface3)",
                        color: tracks.length ? "var(--bg)" : "var(--text-low)",
                        fontWeight: 600,
                      }}
                    >
                      <Icon
                        name="play"
                        size={15}
                        color={tracks.length ? "var(--bg)" : "var(--text-low)"}
                      />
                      play
                    </button>
                    <button
                      onClick={() => {
                        if (tracks.length > 0) {
                          usePlayerStore.getState().setShuffle(true);
                          play(tracks[0], tracks);
                        }
                      }}
                      disabled={tracks.length === 0}
                      style={hoverPill}
                    >
                      <Icon name="shuffle" size={14} />
                      shuffle
                    </button>
                  </div>
                </div>
              </header>

              {full.isPending && d.tracks.length === 0 ? (
                <LoadingRow label="loading tracks" />
              ) : (
                <div>
                  {tracks.map((t, i) => (
                    <TrackRow key={`${t.id}-${i}`} track={t} queue={tracks} index={i} />
                  ))}
                  {full.isPending && <LoadingRow label="loading the rest" />}
                </div>
              )}
            </>
          );
        }}
      </AsyncView>
    </Page>
  );
}
