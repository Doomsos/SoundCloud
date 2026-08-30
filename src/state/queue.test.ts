/**
 * Ports `test/player/queue_test.dart` and `test/player/crossfade_trigger_test.dart`.
 *
 * Shuffling is injected as a deterministic reversal so the assertions are
 * about ordering rules rather than luck.
 */

import { describe, expect, it } from "vitest";

import type { Track } from "@/models";
import { QueueModel, isGenuineCompletion, shouldStartCrossfade } from "./queue";

function track(id: string): Track {
  return {
    id,
    title: `track ${id}`,
    artist: "artist",
    durationMs: 200_000,
    likes: 0,
    reposts: 0,
    plays: 0,
    genre: "electronic",
    postedAt: "",
    description: "",
    waveform: [],
    streamCandidates: ["https://example/stream"],
    drmCandidates: [],
    lock: "none",
    minted: false,
    artistHandle: "artist",
    goPlus: false,
    locked: false,
  };
}

const list = (...ids: string[]) => ids.map(track);
const ids = (ts: readonly Track[]) => ts.map((t) => t.id);

/** Deterministic stand-in for Fisher-Yates. */
const reverse = (input: Track[]) => [...input].reverse();

describe("QueueModel: linear playback", () => {
  it("walks the queue in order and wraps at the end", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);

    expect(q.upNext()?.id).toBe("b");
    q.stepForward(b);
    expect(q.upNext()?.id).toBe("c");
    q.stepForward(c);
    // A finite queue loops rather than stopping dead.
    expect(q.upNext()?.id).toBe("a");
  });

  it("has no next track for a queue of one", () => {
    const q = new QueueModel();
    const a = track("a");
    q.start(a);
    expect(q.upNext()).toBeNull();
    expect(q.queue.map((t) => t.id)).toEqual(["a"]);
  });

  it("reports what is still upcoming, excluding the playing track", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);
    expect(ids(q.upcoming("a"))).toEqual(["b", "c"]);
    q.stepForward(b);
    expect(ids(q.upcoming("b"))).toEqual(["c"]);
    expect(q.currentQueueIndex("b")).toBe(1);
  });
});

describe("QueueModel: history", () => {
  it("retraces the same path backwards and forwards", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);
    q.stepForward(b);
    q.stepForward(c);

    expect(q.stepBack()?.id).toBe("b");
    // Going back must not re-decide what comes next.
    expect(q.upNext()?.id).toBe("c");
    expect(q.stepBack()?.id).toBe("a");
    expect(q.upNext()?.id).toBe("b");
  });

  it("stops at the start of history", () => {
    const q = new QueueModel();
    const [a, b] = list("a", "b");
    q.start(a, [a, b]);
    expect(q.peekPrevious()).toBeNull();
    expect(q.stepBack()).toBeNull();
  });

  it("appends rather than truncating when the path diverges", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);
    q.stepForward(b);
    q.stepBack(); // back to a

    // Jumping somewhere else from mid-history extends the path.
    q.stepForward(c);
    expect(ids(q.history)).toEqual(["a", "b", "c"]);
    expect(q.historyIndex).toBe(2);
    expect(q.stepBack()?.id).toBe("b");
  });

  it("caps history and keeps the most recent entries", () => {
    const q = new QueueModel();
    const many = Array.from({ length: 320 }, (_, i) => track(`t${i}`));
    q.start(many[0], many);
    for (let i = 1; i < many.length; i++) q.stepForward(many[i]);

    expect(q.history.length).toBeLessThanOrEqual(300);
    expect(q.history[q.history.length - 1].id).toBe("t319");
    expect(q.historyIndex).toBe(q.history.length - 1);
  });
});

describe("QueueModel: shuffle", () => {
  it("follows the shuffled order once enabled", () => {
    const q = new QueueModel(reverse);
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);

    expect(q.upNext()?.id).toBe("b");
    q.setShuffle(true);
    // Reversed order is c, b, a - so after a comes nothing ahead of it, and
    // the pass restarts.
    expect(ids(q.upcoming("a"))).toEqual([]);
    expect(q.upNext()).not.toBeNull();
  });

  it("never repeats the same track across a reshuffle boundary", () => {
    const q = new QueueModel(reverse);
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);
    q.setShuffle(true);

    // `a` is last in the reversed order, so the next pick must come from a
    // fresh pass - and must not be `a` again.
    const next = q.upNext();
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe("a");
  });

  it("keeps the shuffled order in step when the queue is edited", () => {
    const q = new QueueModel(reverse);
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);
    q.setShuffle(true);
    q.upNext(); // forces the order to be built

    const d = track("d");
    q.add(d);
    expect(q.queue.map((t) => t.id)).toContain("d");
    // The live sequence must still contain everything in the queue.
    expect(q.activeSeq().length).toBe(q.queue.length);
  });

  it("turning shuffle off returns to queue order", () => {
    const q = new QueueModel(reverse);
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);
    q.setShuffle(true);
    q.setShuffle(false);
    expect(ids(q.upcoming("a"))).toEqual(["b", "c"]);
  });
});

describe("QueueModel: editing", () => {
  it("refuses to add a duplicate", () => {
    const q = new QueueModel();
    const [a, b] = list("a", "b");
    q.start(a, [a, b]);
    expect(q.add(b)).toBe(false);
    expect(q.queue.length).toBe(2);
    expect(q.add(track("c"))).toBe(true);
    expect(q.queue.length).toBe(3);
  });

  it("play next inserts directly after the playing track", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);

    const d = track("d");
    q.playNext(d, "a");
    expect(q.queue.map((t) => t.id)).toEqual(["a", "d", "b", "c"]);
    expect(q.upNext()?.id).toBe("d");
  });

  it("play next moves a track that is already queued", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);

    q.playNext(c, "a");
    expect(q.queue.map((t) => t.id)).toEqual(["a", "c", "b"]);
    // It must not appear twice.
    expect(q.queue.filter((t) => t.id === "c").length).toBe(1);
  });

  it("removes a queued track but never the playing one", () => {
    const q = new QueueModel();
    const [a, b, c] = list("a", "b", "c");
    q.start(a, [a, b, c]);

    expect(q.remove("a", "a")).toBe(false);
    expect(q.queue.length).toBe(3);
    expect(q.remove("b", "a")).toBe(true);
    expect(q.queue.map((t) => t.id)).toEqual(["a", "c"]);
    expect(q.remove("zzz", "a")).toBe(false);
    // The frontier must be recomputed, not left pointing at the dropped track.
    expect(q.upNext()?.id).toBe("c");
  });

  it("reorders upcoming tracks by their visible index", () => {
    const q = new QueueModel();
    const [a, b, c, d] = list("a", "b", "c", "d");
    q.start(a, [a, b, c, d]);

    // Move "d" (upcoming index 2) to the front of upcoming.
    expect(q.reorderUpcoming(2, 0, "a")).toBe(true);
    expect(ids(q.upcoming("a"))).toEqual(["d", "b", "c"]);
    expect(q.upNext()?.id).toBe("d");
  });

  it("ignores out-of-range reorders", () => {
    const q = new QueueModel();
    const [a, b] = list("a", "b");
    q.start(a, [a, b]);
    expect(q.reorderUpcoming(9, 0, "a")).toBe(false);
    expect(q.reorderUpcoming(0, 0, "nobody")).toBe(false);
  });
});

describe("shouldStartCrossfade", () => {
  const base = {
    positionMs: 197_000,
    durationMs: 200_000,
    crossfadeMs: 4000,
    isPlaying: true,
    repeat: false,
    hasPreload: true,
    swapping: false,
  };

  it("fires inside the crossfade window", () => {
    expect(shouldStartCrossfade(base)).toBe(true);
  });

  it("does not fire before the window", () => {
    expect(shouldStartCrossfade({ ...base, positionMs: 100_000 })).toBe(false);
  });

  it("needs a preloaded next track", () => {
    expect(shouldStartCrossfade({ ...base, hasPreload: false })).toBe(false);
  });

  it("is off when crossfade is zero", () => {
    expect(shouldStartCrossfade({ ...base, crossfadeMs: 0 })).toBe(false);
  });

  it("never interrupts repeat, a pause, or a swap already running", () => {
    expect(shouldStartCrossfade({ ...base, repeat: true })).toBe(false);
    expect(shouldStartCrossfade({ ...base, isPlaying: false })).toBe(false);
    expect(shouldStartCrossfade({ ...base, swapping: true })).toBe(false);
  });

  it("ignores an unknown duration or a zero position", () => {
    expect(shouldStartCrossfade({ ...base, durationMs: 0 })).toBe(false);
    expect(shouldStartCrossfade({ ...base, positionMs: 0 })).toBe(false);
  });
});

describe("isGenuineCompletion", () => {
  it("accepts a track that played most of the way through", () => {
    expect(
      isGenuineCompletion({
        secondsSinceStart: 190,
        maxPositionMs: 190_000,
        durationMs: 200_000,
      }),
    ).toBe(true);
  });

  it("rejects a stream that died early", () => {
    // Fires `ended` after two seconds having reached nowhere.
    expect(
      isGenuineCompletion({ secondsSinceStart: 2, maxPositionMs: 1500, durationMs: 200_000 }),
    ).toBe(false);
    // Long enough, but nowhere near the end.
    expect(
      isGenuineCompletion({ secondsSinceStart: 30, maxPositionMs: 30_000, durationMs: 200_000 }),
    ).toBe(false);
  });

  it("falls back to elapsed time when the duration is unknown", () => {
    expect(
      isGenuineCompletion({ secondsSinceStart: 8, maxPositionMs: 0, durationMs: 0 }),
    ).toBe(true);
    expect(
      isGenuineCompletion({ secondsSinceStart: 3, maxPositionMs: 0, durationMs: 0 }),
    ).toBe(false);
  });
});
