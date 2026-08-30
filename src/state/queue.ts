/**
 * Queue sequencing: what plays next, and how shuffle and history interact.
 * Extracted from `PlayerController`'s private fields in
 * `lib/features/player/player_controller.dart`.
 *
 * This is pure - no engine, no store, no I/O - because it is the part of
 * playback most likely to be subtly wrong, and it is far easier to be sure
 * about with tests than by ear.
 *
 * Two ideas do most of the work:
 *
 * * **History is a path, not a log.** Going back then forward retraces the
 *   same tracks rather than re-deciding them, so `upNext` prefers the next
 *   entry in history and only falls through to `frontierNext` at the tip.
 * * **The shuffled order is tied to the queue that built it.** `orderSource`
 *   is an identity check: replace the queue and the order is rebuilt; mutate
 *   it in place and the order is kept in step by hand.
 */

import type { Track } from "@/models";

/** The Dart controller capped history here. */
export const HISTORY_CAP = 300;

export type ShuffleFn = (input: Track[]) => Track[];

export function fisherYates(input: Track[], rand: () => number = Math.random): Track[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class QueueModel {
  private _queue: Track[] = [];
  private _history: Track[] = [];
  private _histIdx = -1;
  private _frontierNext: Track | null = null;
  private _order: Track[] = [];
  private _orderSource: Track[] | null = null;

  shuffle = false;

  /** Injectable so tests can make shuffling deterministic. */
  constructor(private readonly shuffleFn: ShuffleFn = (i) => fisherYates(i)) {}

  get queue(): readonly Track[] {
    return this._queue;
  }
  get history(): readonly Track[] {
    return this._history;
  }
  get historyIndex(): number {
    return this._histIdx;
  }
  get frontierNext(): Track | null {
    return this._frontierNext;
  }

  /** Begins a new listening session at `track`, optionally with a queue. */
  start(track: Track, queue?: Track[]): void {
    this._queue = queue && queue.length > 0 ? [...queue] : [track];
    this._orderSource = null;
    this._order = [];
    this._history = [track];
    this._histIdx = 0;
    this.recomputeFrontier();
  }

  setShuffle(on: boolean): void {
    if (this.shuffle === on) return;
    this.shuffle = on;
    this.recomputeFrontier();
  }

  /** The sequence that is authoritative right now. */
  activeSeq(): Track[] {
    return this.shuffle && this._order.length > 0 && this._orderSource === this._queue
      ? this._order
      : this._queue;
  }

  upcoming(currentId: string | undefined): Track[] {
    const seq = this.activeSeq();
    const i = seq.findIndex((t) => t.id === currentId);
    return i === -1 ? [...seq] : seq.slice(i + 1);
  }

  currentQueueIndex(currentId: string | undefined): number {
    return this._queue.findIndex((t) => t.id === currentId);
  }

  /** The track `next()` would play, or `null` at the end of a finite queue. */
  upNext(): Track | null {
    if (this._histIdx >= 0 && this._histIdx < this._history.length - 1) {
      return this._history[this._histIdx + 1];
    }
    return this._frontierNext;
  }

  /** The track `previous()` would step back to, or `null` at the start. */
  peekPrevious(): Track | null {
    return this._histIdx > 0 ? this._history[this._histIdx - 1] : null;
  }

  stepBack(): Track | null {
    if (this._histIdx <= 0) return null;
    this._histIdx--;
    return this._history[this._histIdx];
  }

  /**
   * Records that `track` is now playing. Re-treads the existing path when it
   * is already the next entry, and truncates nothing otherwise - the Dart
   * version appended, which lets a divergence still be walked back through.
   */
  stepForward(track: Track): void {
    if (
      this._histIdx >= 0 &&
      this._histIdx < this._history.length - 1 &&
      this._history[this._histIdx + 1].id === track.id
    ) {
      this._histIdx++;
    } else {
      this._history.push(track);
      if (this._history.length > HISTORY_CAP) {
        this._history.splice(0, this._history.length - HISTORY_CAP);
      }
      this._histIdx = this._history.length - 1;
    }
    this.recomputeFrontier();
  }

  add(t: Track): boolean {
    if (this._queue.some((x) => x.id === t.id)) return false;
    this._queue.push(t);
    if (this._order.length > 0) this._order.push(t);
    this.recomputeFrontier();
    return true;
  }

  /** Inserts `t` directly after the playing track in whichever order is live. */
  playNext(t: Track, currentId: string | undefined): void {
    this._queue = this._queue.filter((x) => x.id !== t.id);
    this._order = this._order.filter((x) => x.id !== t.id);
    // Filtering rebuilt `_queue`, so the order's identity link is stale.
    if (this._orderSource !== null) this._orderSource = this._queue;

    const seq = this.activeSeq();
    const cur = currentId ? seq.findIndex((x) => x.id === currentId) : -1;
    seq.splice(cur < 0 ? 0 : cur + 1, 0, t);

    if (seq === this._queue) {
      if (this._order.length > 0) {
        const co = currentId ? this._order.findIndex((x) => x.id === currentId) : -1;
        this._order.splice(co < 0 ? this._order.length : co + 1, 0, t);
      }
    } else if (!this._queue.some((x) => x.id === t.id)) {
      // Inserted into the shuffled order only; the queue still needs it.
      this._queue.push(t);
    }
    this.recomputeFrontier();
  }

  /** The playing track cannot be removed. */
  remove(trackId: string, currentId: string | undefined): boolean {
    if (trackId === currentId) return false;
    const before = this._queue.length;
    this._queue = this._queue.filter((t) => t.id !== trackId);
    if (this._order.length > 0) this._order = this._order.filter((t) => t.id !== trackId);
    if (this._queue.length === before) return false;
    if (this._orderSource !== null) this._orderSource = this._queue;
    this.recomputeFrontier();
    return true;
  }

  /** Indices are relative to `upcoming()`, which is what the panel renders. */
  reorderUpcoming(
    oldIndex: number,
    newIndex: number,
    currentId: string | undefined,
  ): boolean {
    const seq = this.activeSeq();
    const cur = seq.findIndex((t) => t.id === currentId);
    if (cur < 0) return false;

    const base = cur + 1;
    const oldAbs = base + oldIndex;
    let newAbs = base + newIndex;
    if (oldAbs < base || oldAbs >= seq.length) return false;
    if (newAbs > seq.length) newAbs = seq.length;
    // Removing first shifts everything after it down by one.
    if (newAbs > oldAbs) newAbs -= 1;

    const [item] = seq.splice(oldAbs, 1);
    seq.splice(newAbs, 0, item);
    this.recomputeFrontier();
    return true;
  }

  recomputeFrontier(): void {
    const last = this._history.length === 0 ? null : this._history[this._history.length - 1];
    this._frontierNext = this.generateAfter(last);
  }

  private ensureOrder(): void {
    if (this._orderSource !== this._queue || this._order.length !== this._queue.length) {
      this._order = this.shuffleFn(this._queue);
      this._orderSource = this._queue;
    }
  }

  private generateAfter(cur: Track | null): Track | null {
    if (this._queue.length <= 1 || !cur) return null;

    if (this.shuffle) {
      this.ensureOrder();
      let pos = this._order.findIndex((t) => t.id === cur.id);
      if (pos === -1) pos = 0;
      if (pos + 1 < this._order.length) return this._order[pos + 1];

      // Ran off the end: reshuffle for the next pass, and rotate if the new
      // first track is the one that just played - back to back is the one
      // thing shuffle must not do.
      this._order = this.shuffleFn(this._queue);
      this._orderSource = this._queue;
      if (this._order.length > 1 && this._order[0].id === cur.id) {
        this._order.push(this._order.shift() as Track);
      }
      return this._order[0];
    }

    const idx = this._queue.findIndex((t) => t.id === cur.id);
    if (idx === -1) return this._queue[0] ?? null;
    // Wraps, so a finite queue loops rather than stopping dead.
    return this._queue[(idx + 1) % this._queue.length];
  }
}

/**
 * Whether the crossfade into the next track should begin now. Extracted from
 * `_maybeStartCrossfade`.
 */
export function shouldStartCrossfade(opts: {
  positionMs: number;
  durationMs: number;
  crossfadeMs: number;
  isPlaying: boolean;
  repeat: boolean;
  hasPreload: boolean;
  swapping: boolean;
}): boolean {
  const { positionMs, durationMs, crossfadeMs, isPlaying, repeat, hasPreload, swapping } = opts;
  if (swapping) return false;
  if (repeat || !isPlaying) return false;
  if (durationMs <= 0 || positionMs <= 0) return false;
  if (crossfadeMs <= 0) return false;
  if (!hasPreload) return false;
  const remaining = durationMs - positionMs;
  return remaining > 0 && remaining <= crossfadeMs;
}

/**
 * Whether an `ended` event is a real end of track. Extracted from the
 * completion handler.
 *
 * A stream that dies early also fires `ended`, and treating that as "finished"
 * would race through the queue. The Dart original required both a few seconds
 * of playback and having reached 70% of a known duration.
 */
export function isGenuineCompletion(opts: {
  secondsSinceStart: number;
  maxPositionMs: number;
  durationMs: number;
}): boolean {
  const { secondsSinceStart, maxPositionMs, durationMs } = opts;
  const reachedEnd =
    durationMs > 0 ? maxPositionMs >= durationMs * 0.7 : secondsSinceStart > 5;
  return secondsSinceStart >= 5 && reachedEnd;
}
