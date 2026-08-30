/**
 * The keyboard map. Port of `lib/app/shortcut_bindings.dart` and
 * `lib/shared/chord_controller.dart`.
 *
 * Flutter resolved `ShortcutActivator`s against `Intent`s; here a key event is
 * reduced to an `Action` name that the shell dispatches. Keeping it a pure
 * function of the event keeps it testable without a DOM.
 */

export type Action =
  | "playPause"
  | "nextTrack"
  | "prevTrack"
  | "seekForward"
  | "seekBackward"
  | "volumeUp"
  | "volumeDown"
  | "muteToggle"
  | "likePlaying"
  | "repeatToggle"
  | "repostPlaying"
  | "navigateToPlaying"
  | "openSearch"
  | "shuffleToggle"
  | "toggleQueue"
  | "showShortcuts"
  | "focusOmnibox"
  | "jumpLikes"
  | "jumpSettings"
  | "jumpLogs"
  | "copyLink"
  | "playPageTrack"
  | { seekToPercent: number };

export interface KeyState {
  key: string;
  code: string;
  shift: boolean;
  /** Meta on macOS, Control elsewhere - the platform's primary modifier. */
  primary: boolean;
  alt: boolean;
}

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function keyStateOf(e: KeyboardEvent, mac = isMac()): KeyState {
  return {
    key: e.key,
    code: e.code,
    shift: e.shiftKey,
    primary: mac ? e.metaKey : e.ctrlKey,
    alt: e.altKey,
  };
}

/**
 * Resolves one key press to an action, or `null` if nothing is bound.
 *
 * `location` matters because Enter only plays a track while a track page is
 * open, exactly as the Dart map was rebuilt per route.
 */
export function resolveShortcut(k: KeyState, location: string): Action | null {
  const letter = k.code.startsWith("Key") ? k.code.slice(3).toLowerCase() : "";
  const digit = k.code.startsWith("Digit") ? Number(k.code.slice(5)) : null;

  if (k.primary && !k.alt) {
    if (letter === "k") return "focusOmnibox";
    if (letter === "f") return "focusOmnibox";
    if (letter === "l") return k.shift ? "jumpLogs" : "jumpLikes";
    if (letter === "c" && k.shift) return "copyLink";
    if (k.key === "," || k.code === "Comma") return "jumpSettings";
    return null;
  }
  // Everything below is unmodified (or shift-only); a stray Ctrl/Alt press
  // must not trigger a bare-key action.
  if (k.primary || k.alt) return null;

  if (k.code === "Space") return "playPause";
  if (k.code === "ArrowRight") return k.shift ? "nextTrack" : "seekForward";
  if (k.code === "ArrowLeft") return k.shift ? "prevTrack" : "seekBackward";
  if (k.code === "ArrowUp" && k.shift) return "volumeUp";
  if (k.code === "ArrowDown" && k.shift) return "volumeDown";

  if (letter === "m" && !k.shift) return "muteToggle";
  if (letter === "l") return k.shift ? "repeatToggle" : "likePlaying";
  if (letter === "r" && !k.shift) return "repostPlaying";
  if (letter === "p" && !k.shift) return "navigateToPlaying";
  if (letter === "s") return k.shift ? "shuffleToggle" : "openSearch";
  if (letter === "q" && !k.shift) return "toggleQueue";
  if (letter === "h" && !k.shift) return "showShortcuts";

  if (digit !== null && !k.shift) return { seekToPercent: digit };

  if ((k.code === "Enter" || k.code === "NumpadEnter") && location.startsWith("/track/")) {
    return "playPageTrack";
  }
  return null;
}

// ---- the `g` chord -------------------------------------------------------

export type ChordTarget = "likes" | "feed" | "library" | "profile" | "history";

const CHORD_WINDOW_MS = 1200;

/** Press `g`, then a letter within the window, to jump somewhere. */
export class ChordController {
  private armedUntil = 0;

  constructor(private readonly windowMs = CHORD_WINDOW_MS) {}

  get armed(): boolean {
    return Date.now() < this.armedUntil;
  }

  arm(): void {
    this.armedUntil = Date.now() + this.windowMs;
  }

  disarm(): void {
    this.armedUntil = 0;
  }

  /**
   * Consumes the chord. Returns the target, or `null` for an unbound letter -
   * either way the chord is spent, so a mistyped second key does not leak
   * through as a normal shortcut.
   */
  resolve(code: string): ChordTarget | null {
    if (!this.armed) return null;
    this.disarm();
    switch (code) {
      case "KeyL":
        return "likes";
      case "KeyS":
        return "feed";
      case "KeyC":
        return "library";
      case "KeyP":
        return "profile";
      case "KeyH":
        return "history";
      default:
        return null;
    }
  }
}

/** True when the event came from a text field, so shortcuts must stand down. */
export function isEditing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

/** The rows rendered by the shortcuts overlay. */
export const SHORTCUT_HELP: Array<{ group: string; items: Array<[string, string]> }> = [
  {
    group: "playback",
    items: [
      ["space", "play / pause"],
      ["← / →", "seek 5s"],
      ["shift ← / →", "previous / next track"],
      ["shift ↑ / ↓", "volume"],
      ["0-9", "seek to 0-90%"],
      ["m", "mute"],
      ["shift+l", "repeat"],
      ["shift+s", "shuffle"],
    ],
  },
  {
    group: "actions",
    items: [
      ["l", "like the playing track"],
      ["r", "repost the playing track"],
      ["p", "open the playing track"],
      ["q", "toggle the queue"],
      ["enter", "play this page's track"],
    ],
  },
  {
    group: "navigation",
    items: [
      ["s", "search"],
      ["g then l", "likes"],
      ["g then s", "feed"],
      ["g then c", "library"],
      ["g then h", "history"],
      ["g then p", "your profile"],
    ],
  },
  {
    group: "app",
    items: [
      ["ctrl/⌘ k", "omnibox"],
      ["ctrl/⌘ l", "likes"],
      ["ctrl/⌘ ,", "settings"],
      ["ctrl/⌘ shift l", "logs"],
      ["ctrl/⌘ shift c", "copy link"],
      ["h", "this help"],
    ],
  },
];
