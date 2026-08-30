/** Port of `lib/features/feed/feed_screen.dart` and `feed_post_card.dart`. */

import { Link } from "react-router-dom";

import { useFeed } from "@/api/queries";
import { CoverArt } from "@/components/CoverArt";
import { Icon } from "@/components/Icon";
import { Waveform } from "@/components/Waveform";
import { AsyncView, EmptyState, LockBadge, Page, PageTitle } from "@/components/common";
import * as fmt from "@/lib/format";
import type { FeedPost } from "@/models";
import { useAuthStore } from "@/state/authStore";
import { bufferedFractionOf, progressOf, usePlayerStore } from "@/state/playerStore";

export function Feed() {
  const feed = useFeed();
  const authenticated = useAuthStore((s) => s.authenticated);

  return (
    <Page>
      <PageTitle>feed</PageTitle>
      <AsyncView
        query={feed}
        isEmpty={(posts) => posts.length === 0}
        empty={
          <EmptyState
            title={authenticated ? "nothing new" : "sign in to see your feed"}
            hint={
              authenticated
                ? "Follow a few more artists and their posts will show up here."
                : "The feed is built from the artists you follow, so it needs an account."
            }
          />
        }
      >
        {(posts) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 760 }}>
            {posts.map((post) => (
              <FeedCard key={post.id} post={post} queue={posts.map((p) => p.track)} />
            ))}
          </div>
        )}
      </AsyncView>
    </Page>
  );
}

function FeedCard({ post, queue }: { post: FeedPost; queue: FeedPost["track"][] }) {
  const track = post.track;
  const s = usePlayerStore();
  const isCurrent = s.track?.id === track.id;
  const isPlaying = isCurrent && s.isPlaying;

  const start = () => {
    if (isCurrent) s.toggle();
    else s.play(track, queue);
  };

  return (
    <article
      style={{
        padding: 14,
        background: "var(--surface)",
        border: "var(--border-width) solid var(--border-dim)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div
        className="t-label"
        style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12 }}
      >
        <CoverArt seed={post.actorSeed} size={18} circular />
        <span style={{ color: "var(--text-hi)", fontWeight: 500 }}>{post.actor}</span>
        <span>{post.actionLabel}</span>
        <span style={{ color: "var(--text-low)" }}>· {post.timeAgo}</span>
      </div>

      <div style={{ display: "flex", gap: 14 }}>
        <div style={{ position: "relative", flexShrink: 0 }}>
          <CoverArt seed={track.id} imageUrl={track.coverUrl} size={96} />
          <button
            onClick={start}
            title={isPlaying ? "pause" : "play"}
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              background: "rgba(0,0,0,0.35)",
              opacity: isCurrent ? 1 : 0,
              transition: `opacity var(--motion) var(--ease)`,
              borderRadius: "var(--radius-md)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = isCurrent ? "1" : "0")}
          >
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "var(--acid)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Icon name={isPlaying ? "pause" : "play"} size={17} color="var(--bg)" />
            </span>
          </button>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Link to={`/track/${track.id}`} className="truncate t-heading">
              {track.title}
            </Link>
            <LockBadge lock={track.lock} />
          </div>
          <Link
            to={`/artist/${encodeURIComponent(track.artistHandle)}`}
            className="truncate t-label"
            style={{ display: "block", marginTop: 2 }}
          >
            {track.artist}
          </Link>

          <div style={{ marginTop: 10 }}>
            <Waveform
              bars={track.waveform}
              progress={isCurrent ? progressOf(s) : 0}
              buffered={isCurrent ? bufferedFractionOf(s) : 0}
              height={38}
              onSeek={isCurrent ? s.seekFraction : undefined}
            />
          </div>

          <div
            className="t-mono"
            style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 11 }}
          >
            <span>{fmt.count(track.plays)} plays</span>
            <span>{fmt.count(track.likes)} likes</span>
            {post.comments > 0 && <span>{fmt.count(post.comments)} comments</span>}
            <span style={{ marginLeft: "auto" }}>{fmt.time(track.durationMs)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
