import { describe, expect, it } from "vitest";

import { __test } from "./playerStore";

const { parseLastPlayed, clampPosition } = __test;

describe("parseLastPlayed", () => {
  it("reads a well-formed note", () => {
    expect(parseLastPlayed('{"id":"123","positionMs":45000}')).toEqual({
      id: "123",
      positionMs: 45000,
    });
  });

  it("opens an empty player rather than throwing on anything malformed", () => {
    for (const raw of [null, "", "not json", "{}", '{"id":""}', '{"id":42}', "[]"]) {
      expect(parseLastPlayed(raw)).toBeNull();
    }
  });

  it("falls back to the start when the position is unusable", () => {
    expect(parseLastPlayed('{"id":"1"}')?.positionMs).toBe(0);
    expect(parseLastPlayed('{"id":"1","positionMs":-5}')?.positionMs).toBe(0);
    expect(parseLastPlayed('{"id":"1","positionMs":"x"}')?.positionMs).toBe(0);
  });
});

describe("clampPosition", () => {
  it("keeps a position inside the track", () => {
    expect(clampPosition(45000, 200000)).toBe(45000);
  });

  it("starts over when the last session ended within the grace window", () => {
    // Reopening on the final second would play nothing before skipping on.
    expect(clampPosition(199000, 200000)).toBe(0);
    expect(clampPosition(500000, 200000)).toBe(0);
  });

  it("starts over on a missing or nonsensical position", () => {
    expect(clampPosition(0, 200000)).toBe(0);
    expect(clampPosition(-1, 200000)).toBe(0);
    expect(clampPosition(Number.NaN, 200000)).toBe(0);
  });

  it("trusts the stored position when the duration is unknown", () => {
    expect(clampPosition(45000, 0)).toBe(45000);
  });
});
