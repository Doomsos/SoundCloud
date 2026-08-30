/**
 * The scrubber. Port of `lib/shared/widgets/waveform_view.dart`.
 *
 * Kept on a canvas because that is what it is: a few hundred individually
 * coloured rectangles redrawn on every position tick. The bar geometry,
 * colours and comment markers follow the Dart painter exactly.
 */

import { useCallback, useEffect, useRef } from "react";

const GAP = 1.5;
const MIN_BAR = 2;

export function Waveform({
  bars,
  progress = 0,
  buffered = 0,
  onSeek,
  height = 64,
  markers = [],
}: {
  bars: number[];
  progress?: number;
  buffered?: number;
  onSeek?: (fraction: number) => void;
  height?: number;
  markers?: number[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || bars.length === 0) return;

    const width = wrap.clientWidth;
    if (width <= 0) return;

    // Backing store at device resolution, CSS box at logical size, so the
    // hairline bars stay crisp on a scaled display.
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const style = getComputedStyle(document.documentElement);
    const acid = style.getPropertyValue("--acid").trim() || "#ff5500";
    const dim = style.getPropertyValue("--wave-dim").trim() || "#34343c";
    const lime = style.getPropertyValue("--lime").trim() || "#c6ff00";

    // Never draw more bars than fit: the source array is resampled down.
    const maxBars = Math.min(bars.length, Math.max(1, Math.floor(width / (MIN_BAR + GAP))));
    const step = bars.length / maxBars;
    const barWidth = (width - GAP * (maxBars - 1)) / maxBars;

    const mid = height / 2;
    const playedX = width * progress;
    const bufferedX = width * Math.min(1, Math.max(progress, buffered));

    for (let i = 0; i < maxBars; i++) {
      const amp = bars[Math.floor(i * step)] ?? 0;
      const h = Math.min(height, Math.max(2, amp * height));
      const x = i * (barWidth + GAP);
      const cx = x + barWidth / 2;

      if (cx <= playedX) ctx.fillStyle = acid;
      else if (cx <= bufferedX) ctx.fillStyle = withAlpha(acid, 0.35);
      else ctx.fillStyle = dim;

      ctx.fillRect(x, mid - h / 2, barWidth, h);
    }

    // Comment pins along the top edge.
    ctx.fillStyle = lime;
    for (const f of markers) {
      ctx.beginPath();
      ctx.arc(width * f, 3, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [bars, progress, buffered, height, markers]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  const seekAt = useCallback(
    (clientX: number) => {
      const wrap = wrapRef.current;
      if (!wrap || !onSeek) return;
      const rect = wrap.getBoundingClientRect();
      onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
    },
    [onSeek],
  );

  // Pointer capture keeps the drag alive when the cursor leaves the strip,
  // which is what makes scrubbing past either end feel right.
  const onPointerDown = (e: React.PointerEvent) => {
    if (!onSeek) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current) seekAt(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* the capture may already be gone */
    }
  };

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        height,
        width: "100%",
        cursor: onSeek ? "pointer" : "default",
        touchAction: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}

/** Accepts the `#rrggbb` the tokens are written in. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
