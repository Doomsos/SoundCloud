/** Display formatting. Port of `lib/shared/format.dart`. */

/** `1234` -> `1.23K`, `2_500_000` -> `2.5M`. Trailing zeros are trimmed. */
export function count(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

/** Fewer decimals as the number grows, so the width stays roughly stable. */
function trim(v: number): string {
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** `m:ss`, or `h:mm:ss` once it runs past an hour. */
export function time(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function wallet(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
