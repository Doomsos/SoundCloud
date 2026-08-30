/**
 * Transient shell state: overlays, panels and toasts. Ports
 * `omnibox_providers.dart`, `queue_visibility.dart`, the shortcuts-overlay
 * provider and `toast.dart`.
 */

import { create } from "zustand";

export interface ToastAction {
  label: string;
  onTap: () => void;
}

export interface Toast {
  id: number;
  message: string;
  durationMs: number;
  action?: ToastAction;
}

interface UiState {
  omniboxOpen: boolean;
  omniboxQuery: string;
  queueVisible: boolean;
  shortcutsOpen: boolean;
  /** The slim transport bar, from `player_ui_state.dart`. */
  playerCollapsed: boolean;
  toasts: Toast[];

  openOmnibox(): void;
  closeOmnibox(): void;
  toggleOmnibox(): void;
  setOmniboxQuery(q: string): void;

  toggleQueue(): void;
  showQueue(): void;
  hideQueue(): void;

  openShortcuts(): void;
  closeShortcuts(): void;

  togglePlayerCollapsed(): void;

  showToast(message: string, opts?: { durationMs?: number; action?: ToastAction }): void;
  dismissToast(id: number): void;

  /** True when any overlay owns the keyboard, so shortcuts must stand down. */
  overlayOpen(): boolean;
}

let toastSeq = 0;

export const useUiStore = create<UiState>((set, get) => ({
  omniboxOpen: false,
  omniboxQuery: "",
  // Up next is shown by default; the top-bar and player buttons toggle it.
  queueVisible: true,
  shortcutsOpen: false,
  playerCollapsed: false,
  toasts: [],

  openOmnibox() {
    // Dropping focus first stops the field underneath from swallowing keys.
    (document.activeElement as HTMLElement | null)?.blur();
    set({ omniboxOpen: true });
  },
  closeOmnibox() {
    set({ omniboxOpen: false });
  },
  toggleOmnibox() {
    if (!get().omniboxOpen) (document.activeElement as HTMLElement | null)?.blur();
    set({ omniboxOpen: !get().omniboxOpen });
  },
  setOmniboxQuery(q) {
    if (get().omniboxQuery !== q) set({ omniboxQuery: q });
  },

  toggleQueue() {
    set({ queueVisible: !get().queueVisible });
  },
  showQueue() {
    set({ queueVisible: true });
  },
  hideQueue() {
    set({ queueVisible: false });
  },

  openShortcuts() {
    set({ shortcutsOpen: true });
  },
  closeShortcuts() {
    set({ shortcutsOpen: false });
  },

  togglePlayerCollapsed() {
    set({ playerCollapsed: !get().playerCollapsed });
  },

  showToast(message, opts) {
    const toast: Toast = {
      id: ++toastSeq,
      message,
      durationMs: opts?.durationMs ?? 3000,
      action: opts?.action,
    };
    set({ toasts: [...get().toasts, toast] });
    window.setTimeout(() => get().dismissToast(toast.id), toast.durationMs);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  overlayOpen() {
    const s = get();
    return s.omniboxOpen || s.shortcutsOpen;
  },
}));
