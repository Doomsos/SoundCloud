/** Covers the `Fmt` helpers ported from `lib/shared/format.dart`. */

import { describe, expect, it } from "vitest";

import { count, time, wallet } from "./format";

describe("count", () => {
  it("leaves small numbers alone", () => {
    expect(count(0)).toBe("0");
    expect(count(999)).toBe("999");
  });

  it("abbreviates thousands and millions, trimming trailing zeros", () => {
    expect(count(1000)).toBe("1K");
    expect(count(1234)).toBe("1.23K");
    expect(count(12_340)).toBe("12.3K");
    expect(count(123_400)).toBe("123K");
    expect(count(1_000_000)).toBe("1M");
    expect(count(2_500_000)).toBe("2.5M");
  });
});

describe("time", () => {
  it("formats as m:ss below an hour", () => {
    expect(time(0)).toBe("0:00");
    expect(time(9000)).toBe("0:09");
    expect(time(65_000)).toBe("1:05");
    expect(time(599_000)).toBe("9:59");
  });

  it("adds hours once past one", () => {
    expect(time(3_600_000)).toBe("1:00:00");
    expect(time(3_725_000)).toBe("1:02:05");
  });

  it("clamps a negative position to zero", () => {
    // Seeking backwards past the start should not render "-0:01".
    expect(time(-500)).toBe("0:00");
  });
});

describe("wallet", () => {
  it("abbreviates long addresses only", () => {
    expect(wallet("short")).toBe("short");
    expect(wallet("0x1234567890abcdef")).toBe("0x1234…cdef");
  });
});
