/**
 * Artwork with a generated fallback. Port of `lib/shared/widgets/cover_art.dart`.
 *
 * When a track has no artwork - or it has not loaded yet - the Dart build
 * painted a deterministic gradient with diagonal hairlines, derived from the
 * seed string. That is reproduced here in CSS rather than on a canvas: it is
 * the same picture, but a grid of 60 covers costs no canvas contexts.
 */

import { useState } from "react";

export function CoverArt({
  seed,
  imageUrl,
  size = 160,
  circular = false,
  className,
}: {
  seed: string;
  imageUrl?: string | null;
  size?: number;
  circular?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const h = hash(seed);

  // Matches the Dart HSL values exactly: two near-black tints, one derived
  // from the seed and one from the seed shifted three bits.
  const base = `hsl(${h % 360} 18% 16%)`;
  const tint = `hsl(${(h >> 3) % 360} 22% 24%)`;
  // The Dart painter offset the hairlines by (seed % 20) - 10.
  const offset = (h % 20) - 10;

  const radius = circular ? "50%" : size >= 72 ? "var(--radius-md)" : "var(--radius-sm)";
  const showImage = !!imageUrl && !failed;

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: radius,
        border: "var(--border-width) solid var(--border-dim)",
        overflow: "hidden",
        position: "relative",
        background: `
          repeating-linear-gradient(45deg,
            rgba(255,255,255,0.03) 0px,
            rgba(255,255,255,0.03) 1px,
            transparent 1px,
            transparent 9.9px),
          linear-gradient(135deg, ${base}, ${tint})
        `,
        backgroundPosition: `${offset}px 0, 0 0`,
      }}
    >
      {showImage && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}
    </div>
  );
}

/**
 * FNV-1a. Any stable hash does - the Dart original used `String.hashCode`,
 * which is not reproducible across runtimes and only ever fed decoration.
 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h | 0);
}
