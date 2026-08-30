/**
 * A card in a shelf or grid. Port of `collection_card.dart` and the shelf
 * carousel from `media_carousel.dart`.
 *
 * A `Collection` is whatever the shelf is made of - a playlist, an album, an
 * artist station, or a single track dressed as a card - so `target` decides
 * where it navigates and `isCircular` decides how the art is cropped.
 */

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { CoverArt } from "./CoverArt";
import { Icon } from "./Icon";
import { SectionHeader } from "./common";
import type { Collection } from "@/models";

const CARD_SIZE = 160;

export function CollectionCard({
  item,
  size = CARD_SIZE,
  onPlay,
}: {
  item: Collection;
  size?: number;
  onPlay?: (item: Collection) => void;
}) {
  const navigate = useNavigate();
  const [hover, setHover] = useState(false);

  const go = () => {
    switch (item.target) {
      case "track":
        navigate(`/track/${item.id}`);
        break;
      case "artist":
        navigate(`/artist/${encodeURIComponent(item.handle ?? item.id)}`);
        break;
      default:
        navigate(`/playlist/${encodeURIComponent(item.id)}`);
    }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={go}
      style={{ width: size, cursor: "pointer", flexShrink: 0 }}
    >
      <div style={{ position: "relative" }}>
        <CoverArt
          seed={item.coverSeed}
          imageUrl={item.coverUrl}
          size={size}
          circular={item.isCircular}
        />
        {onPlay && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay(item);
            }}
            title="play"
            style={{
              position: "absolute",
              right: 8,
              bottom: 8,
              width: 34,
              height: 34,
              borderRadius: "50%",
              background: "var(--acid)",
              display: "grid",
              placeItems: "center",
              opacity: hover ? 1 : 0,
              transform: hover ? "translateY(0)" : "translateY(4px)",
              transition: `opacity var(--motion) var(--ease), transform var(--motion) var(--ease)`,
              boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
            }}
          >
            <Icon name="play" size={17} color="var(--bg)" />
          </button>
        )}
      </div>

      <div
        className="truncate t-body"
        style={{ marginTop: 9, color: hover ? "var(--acid)" : "var(--text-hi)" }}
        title={item.title}
      >
        {item.title}
      </div>
      <div className="truncate t-label" style={{ marginTop: 1 }} title={item.subtitle}>
        {item.trackCount > 0 && item.target !== "track"
          ? `${item.subtitle} · ${item.trackCount} tracks`
          : item.subtitle}
      </div>
    </div>
  );
}

/** A horizontally scrolling shelf of cards. */
export function Shelf({
  title,
  items,
  action,
  size = CARD_SIZE,
  onPlay,
}: {
  title: string;
  items: Collection[];
  action?: ReactNode;
  size?: number;
  onPlay?: (item: Collection) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section style={{ marginBottom: "var(--section-gap)" }}>
      <SectionHeader title={title} action={action} />
      <div
        style={{
          display: "flex",
          gap: "var(--card-gap)",
          overflowX: "auto",
          paddingBottom: 6,
          // The shelf scrolls; the page must not grow sideways with it.
          scrollSnapType: "x proximity",
        }}
      >
        {items.map((item) => (
          <div key={`${item.target}-${item.id}`} style={{ scrollSnapAlign: "start" }}>
            <CollectionCard item={item} size={size} onPlay={onPlay} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** A wrapping grid, used by the library tabs. */
export function CardGrid({
  items,
  size = CARD_SIZE,
  onPlay,
}: {
  items: Collection[];
  size?: number;
  onPlay?: (item: Collection) => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))`,
        gap: "var(--card-gap)",
        justifyItems: "start",
      }}
    >
      {items.map((item) => (
        <CollectionCard key={`${item.target}-${item.id}`} item={item} size={size} onPlay={onPlay} />
      ))}
    </div>
  );
}
