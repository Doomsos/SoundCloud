/**
 * Ports `test/app/shortcuts_map_test.dart` and
 * `test/shared/chord_controller_test.dart`.
 */

import { describe, expect, it, vi } from "vitest";

import { ChordController, resolveShortcut, type KeyState } from "./shortcuts";

function key(partial: Partial<KeyState> & { code: string }): KeyState {
  return { key: "", shift: false, primary: false, alt: false, ...partial };
}

describe("resolveShortcut: transport", () => {
  it("binds the bare playback keys", () => {
    expect(resolveShortcut(key({ code: "Space" }), "/")).toBe("playPause");
    expect(resolveShortcut(key({ code: "ArrowRight" }), "/")).toBe("seekForward");
    expect(resolveShortcut(key({ code: "ArrowLeft" }), "/")).toBe("seekBackward");
    expect(resolveShortcut(key({ code: "KeyM" }), "/")).toBe("muteToggle");
  });

  it("shift turns seeking into track skipping", () => {
    expect(resolveShortcut(key({ code: "ArrowRight", shift: true }), "/")).toBe("nextTrack");
    expect(resolveShortcut(key({ code: "ArrowLeft", shift: true }), "/")).toBe("prevTrack");
    expect(resolveShortcut(key({ code: "ArrowUp", shift: true }), "/")).toBe("volumeUp");
    expect(resolveShortcut(key({ code: "ArrowDown", shift: true }), "/")).toBe("volumeDown");
  });

  it("leaves unmodified up/down alone so lists can scroll", () => {
    expect(resolveShortcut(key({ code: "ArrowUp" }), "/")).toBeNull();
    expect(resolveShortcut(key({ code: "ArrowDown" }), "/")).toBeNull();
  });

  it("maps the digits to seek percentages", () => {
    expect(resolveShortcut(key({ code: "Digit0" }), "/")).toEqual({ seekToPercent: 0 });
    expect(resolveShortcut(key({ code: "Digit5" }), "/")).toEqual({ seekToPercent: 5 });
    expect(resolveShortcut(key({ code: "Digit9" }), "/")).toEqual({ seekToPercent: 9 });
  });
});

describe("resolveShortcut: shift pairs", () => {
  it("separates like from repeat, and search from shuffle", () => {
    expect(resolveShortcut(key({ code: "KeyL" }), "/")).toBe("likePlaying");
    expect(resolveShortcut(key({ code: "KeyL", shift: true }), "/")).toBe("repeatToggle");
    expect(resolveShortcut(key({ code: "KeyS" }), "/")).toBe("openSearch");
    expect(resolveShortcut(key({ code: "KeyS", shift: true }), "/")).toBe("shuffleToggle");
  });

  it("binds the remaining single letters", () => {
    expect(resolveShortcut(key({ code: "KeyR" }), "/")).toBe("repostPlaying");
    expect(resolveShortcut(key({ code: "KeyP" }), "/")).toBe("navigateToPlaying");
    expect(resolveShortcut(key({ code: "KeyQ" }), "/")).toBe("toggleQueue");
    expect(resolveShortcut(key({ code: "KeyH" }), "/")).toBe("showShortcuts");
  });
});

describe("resolveShortcut: primary modifier", () => {
  it("binds the app-level jumps", () => {
    expect(resolveShortcut(key({ code: "KeyK", primary: true }), "/")).toBe("focusOmnibox");
    expect(resolveShortcut(key({ code: "KeyF", primary: true }), "/")).toBe("focusOmnibox");
    expect(resolveShortcut(key({ code: "KeyL", primary: true }), "/")).toBe("jumpLikes");
    expect(resolveShortcut(key({ code: "KeyL", primary: true, shift: true }), "/")).toBe(
      "jumpLogs",
    );
    expect(resolveShortcut(key({ code: "KeyC", primary: true, shift: true }), "/")).toBe(
      "copyLink",
    );
    expect(resolveShortcut(key({ code: "Comma", primary: true, key: "," }), "/")).toBe(
      "jumpSettings",
    );
  });

  it("does not let a modified key fall through to its bare binding", () => {
    // Ctrl+Space must not play/pause, and Alt+M must not mute.
    expect(resolveShortcut(key({ code: "Space", primary: true }), "/")).toBeNull();
    expect(resolveShortcut(key({ code: "KeyM", alt: true }), "/")).toBeNull();
    expect(resolveShortcut(key({ code: "Digit5", primary: true }), "/")).toBeNull();
  });
});

describe("resolveShortcut: route-dependent bindings", () => {
  it("binds Enter to play only on a track page", () => {
    expect(resolveShortcut(key({ code: "Enter" }), "/track/123")).toBe("playPageTrack");
    expect(resolveShortcut(key({ code: "NumpadEnter" }), "/track/123")).toBe("playPageTrack");
    expect(resolveShortcut(key({ code: "Enter" }), "/")).toBeNull();
    expect(resolveShortcut(key({ code: "Enter" }), "/library")).toBeNull();
  });
});

describe("ChordController", () => {
  it("resolves g-then-letter to a target", () => {
    const c = new ChordController();
    expect(c.armed).toBe(false);
    c.arm();
    expect(c.armed).toBe(true);
    expect(c.resolve("KeyL")).toBe("likes");
    // The chord is spent.
    expect(c.armed).toBe(false);
  });

  it("maps every bound letter", () => {
    const c = new ChordController();
    const pairs: Array<[string, string]> = [
      ["KeyL", "likes"],
      ["KeyS", "feed"],
      ["KeyC", "library"],
      ["KeyP", "profile"],
      ["KeyH", "history"],
    ];
    for (const [code, target] of pairs) {
      c.arm();
      expect(c.resolve(code)).toBe(target);
    }
  });

  it("consumes the chord even on an unbound letter", () => {
    const c = new ChordController();
    c.arm();
    // A mistyped second key must not leak through as a normal shortcut.
    expect(c.resolve("KeyZ")).toBeNull();
    expect(c.armed).toBe(false);
  });

  it("does nothing when it was never armed", () => {
    const c = new ChordController();
    expect(c.resolve("KeyL")).toBeNull();
  });

  it("expires after its window", () => {
    vi.useFakeTimers();
    try {
      const c = new ChordController(1200);
      c.arm();
      vi.advanceTimersByTime(1199);
      expect(c.armed).toBe(true);
      vi.advanceTimersByTime(2);
      expect(c.armed).toBe(false);
      expect(c.resolve("KeyL")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms on demand", () => {
    const c = new ChordController();
    c.arm();
    c.disarm();
    expect(c.armed).toBe(false);
  });
});
