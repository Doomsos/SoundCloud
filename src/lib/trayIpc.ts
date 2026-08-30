/**
 * Wire format between the main window and the tray card. Port of
 * `lib/core/tray/tray_ipc.dart`.
 *
 * The card runs in its own webview, so it shares no JavaScript state with the
 * app: everything it draws is pushed across Tauri's event bus, and everything
 * it does comes back the same way.
 *
 * The Dart build had to encode these as JSON *strings*, because
 * `desktop_multi_window` handed `arguments` through as an opaque value. Tauri
 * serialises real objects, so they travel as structured payloads here.
 */

import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/** main -> popup: the current player state. */
export const EVT_STATE = "player://state";
/** popup -> main, and tray menu -> main: a control was used. */
export const EVT_COMMAND = "tray://command";

export type TrayCommand =
  | "playPause"
  | "next"
  | "previous"
  | "toggleLike"
  | "toggleShuffle"
  | "toggleRepeat"
  | "toggleMute"
  | "setVolume"
  | "seek"
  | "openApp"
  | "quit";

export interface TrayCommandMessage {
  cmd: TrayCommand;
  /** 0..1, for `setVolume` and `seek`. */
  value?: number;
}

/** What the card needs to draw itself. A subset of the full player state. */
export interface TrayNowPlaying {
  title: string;
  artist: string;
  coverUrl?: string;
  waveform: number[];
  positionMs: number;
  durationMs: number;
  bufferedFraction: number;
  isPlaying: boolean;
  liked: boolean;
  shuffle: boolean;
  repeat: boolean;
  muted: boolean;
  volume: number;
  hasTrack: boolean;
  /** Drives the GO+ badge beside the title. */
  isGoPlus: boolean;
}

export const emitTrayState = (state: TrayNowPlaying): Promise<void> => emit(EVT_STATE, state);

export const onTrayState = (cb: (s: TrayNowPlaying) => void): Promise<UnlistenFn> =>
  listen<TrayNowPlaying>(EVT_STATE, (e) => cb(e.payload));

export const sendTrayCommand = (msg: TrayCommandMessage): Promise<void> =>
  emit(EVT_COMMAND, msg);

/**
 * The tray *menu* in Rust emits a bare string, while the card emits a message
 * object. This normalises both.
 */
export function onTrayCommand(cb: (msg: TrayCommandMessage) => void): Promise<UnlistenFn> {
  return listen<TrayCommandMessage | string>(EVT_COMMAND, (e) => {
    const p = e.payload;
    cb(typeof p === "string" ? { cmd: p as TrayCommand } : p);
  });
}
