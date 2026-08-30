/** Port of `lib/features/track/track_screen.dart`. */

import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";

import { useTrackDetail } from "@/api/queries";
import { CoverArt } from "@/components/CoverArt";
import { Icon } from "@/components/Icon";
import { TrackRow } from "@/components/TrackRow";
import { Waveform } from "@/components/Waveform";
import {
  AsyncView,
  LockBadge,
  Page,
  SectionHeader,
  hoverPill,
} from "@/components/common";
import * as fmt from "@/lib/format";
import { commentFraction } from "@/models";
import { useLikesStore, useRepostsStore } from "@/state/likesStore";
import { bufferedFractionOf, progressOf, usePlayerStore } from "@/state/playerStore";

export function TrackPage() {
  const { id = "" } = useParams();
  const detail = useTrackDetail(id);
  const s = usePlayerStore();

  const isCurrent = s.track?.id === id;
  const isPlaying = isCurrent && s.isPlaying;

  const liked = useLikesStore((k) => k.ids.has(id));
  const toggleLike = useLikesStore((k) => k.toggle);
  const reposted = useRepostsStore((k) => k.ids.has(id));
  const toggleRepost = useRepostsStore((k) => k.toggle);

  // The shell dispatches this for the Enter shortcut, which only binds on a
  // track route.
  useEffect(() => {
    const onPlayPage = () => {
      const d = detail.data;
      if (!d) return;
      if (usePlayerStore.getState().track?.id === id) {
        if (!usePlayerStore.getState().isPlaying) usePlayerStore.getState().toggle();
      } else {
        usePlayerStore.getState().play(d.track, d.related);
      }
    };
    window.addEventListener("wf:play-page-track", onPlayPage);
    return () => window.removeEventListener("wf:play-page-track", onPlayPage);
  }, [detail.data, id]);

  return (
    <Page>
      <AsyncView query={detail}>
        {(d) => {
          const track = d.track;
          const start = () => {
            if (isCurrent) s.toggle();
            else s.play(track, d.related);
          };

          return (
            <>
              <div style={{ display: "flex", gap: 22, marginBottom: 26 }}>
                <CoverArt seed={track.id} imageUrl={track.coverUrl} size={200} />

                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <div className="t-overline">{track.genre}</div>
                  <h1
                    className="t-title"
                    style={{ margin: "6px 0 4px", fontSize: 26, userSelect: "text" }}
                  >
                    {track.title}
                  </h1>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Link
                      to={`/artist/${encodeURIComponent(track.artistHandle)}`}
                      className="t-body"
                      style={{ color: "var(--text-mid)" }}
                    >
                      {track.artist}
                    </Link>
                    <span className="t-label" style={{ color: "var(--text-low)" }}>
                      · {track.postedAt}
                    </span>
                    <LockBadge lock={track.lock} />
                  </div>

                  <div className="t-mono" style={{ display: "flex", gap: 16, marginTop: 12 }}>
                    <span>{fmt.count(track.plays)} plays</span>
                    <span>{fmt.count(track.likes)} likes</span>
                    <span>{fmt.count(track.reposts)} reposts</span>
                    <span>{fmt.time(track.durationMs)}</span>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: "auto", paddingTop: 18 }}>
                    <button
                      onClick={start}
                      style={{
                        ...hoverPill,
                        height: 34,
                        padding: "0 16px",
                        background: "var(--acid)",
                        color: "var(--bg)",
                        fontWeight: 600,
                      }}
                    >
                      <Icon name={isPlaying ? "pause" : "play"} size={15} color="var(--bg)" />
                      {isPlaying ? "pause" : "play"}
                    </button>
                    <button onClick={() => void toggleLike(id)} style={hoverPill}>
                      <Icon
                        name={liked ? "heart" : "heartOutline"}
                        size={14}
                        color={liked ? "var(--acid)" : "var(--text-mid)"}
                      />
                      {liked ? "liked" : "like"}
                    </button>
                    <button onClick={() => void toggleRepost(id)} style={hoverPill}>
                      <Icon
                        name="repost"
                        size={14}
                        color={reposted ? "var(--acid)" : "var(--text-mid)"}
                      />
                      {reposted ? "reposted" : "repost"}
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ marginBottom: "var(--section-gap)" }}>
                <Waveform
                  bars={track.waveform}
                  progress={isCurrent ? progressOf(s) : 0}
                  buffered={isCurrent ? bufferedFractionOf(s) : 0}
                  height={72}
                  onSeek={isCurrent ? s.seekFraction : undefined}
                  markers={d.comments.map((c) => commentFraction(c, track.durationMs))}
                />
              </div>

              {track.description && (
                <section style={{ marginBottom: "var(--section-gap)", maxWidth: 720 }}>
                  <SectionHeader title="description" />
                  <p
                    className="t-label"
                    style={{ whiteSpace: "pre-wrap", userSelect: "text", margin: 0 }}
                  >
                    {track.description}
                  </p>
                </section>
              )}

              {d.comments.length > 0 && (
                <section style={{ marginBottom: "var(--section-gap)", maxWidth: 720 }}>
                  <SectionHeader title={`${d.comments.length} comments`} />
                  {d.comments.map((c) => (
                    <div
                      key={c.id}
                      style={{ display: "flex", gap: 10, padding: "7px 0", alignItems: "flex-start" }}
                    >
                      <CoverArt seed={c.authorSeed} size={24} circular />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
                          <span className="t-body" style={{ fontSize: 12.5 }}>
                            {c.author}
                          </span>
                          <button
                            className="t-mono"
                            style={{ fontSize: 11, color: "var(--acid)" }}
                            onClick={() => {
                              if (!isCurrent) s.play(track, d.related);
                              s.seekFraction(commentFraction(c, track.durationMs));
                            }}
                          >
                            {fmt.time(c.timecodeMs)}
                          </button>
                        </div>
                        <div className="t-label" style={{ userSelect: "text" }}>
                          {c.text}
                        </div>
                      </div>
                    </div>
                  ))}
                </section>
              )}

              {d.related.length > 0 && (
                <section>
                  <SectionHeader title="related" />
                  {d.related.map((t, i) => (
                    <TrackRow key={t.id} track={t} queue={d.related} index={i} />
                  ))}
                </section>
              )}
            </>
          );
        }}
      </AsyncView>
    </Page>
  );
}
