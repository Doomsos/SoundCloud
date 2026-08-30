/**
 * Sign-in state. Port of the controller half of `soundcloud_auth.dart`.
 *
 * The tokens themselves never reach the frontend: Rust holds them, attaches
 * them to requests, and refreshes them. This store only mirrors *whether* we
 * are signed in, which is all the UI needs to decide what to render.
 */

import { create } from "zustand";

import * as api from "@/api/client";
import type { AuthStatus } from "@/models";
import { useLikesStore, useRepostsStore } from "./likesStore";

interface AuthState extends AuthStatus {
  /** True while a browser sign-in is in flight. */
  signingIn: boolean;
  error: string | null;
  restore(): Promise<void>;
  signIn(): Promise<void>;
  signInWithToken(token: string): Promise<void>;
  signOut(): Promise<void>;
  saveClientId(id: string): Promise<void>;
  clearError(): void;
}

/** Likes and reposts belong to whoever is signed in, so they follow it. */
function refreshUserCollections(authenticated: boolean): void {
  if (authenticated) {
    void useLikesStore.getState().load();
    void useRepostsStore.getState().load();
  } else {
    useLikesStore.getState().reset();
    useRepostsStore.getState().reset();
  }
}

export const useAuthStore = create<AuthState>((set) => {
  const apply = (status: AuthStatus) => {
    set({ ...status, signingIn: false });
    refreshUserCollections(status.authenticated);
  };

  return {
    authenticated: false,
    hasClientId: false,
    compiledIn: false,
    signingIn: false,
    error: null,

    async restore() {
      apply(await api.safe(() => api.authRestore(), {
        authenticated: false,
        hasClientId: false,
        compiledIn: false,
      }, "auth restore"));
    },

    async signIn() {
      set({ signingIn: true, error: null });
      try {
        apply(await api.authSignIn());
      } catch (e) {
        // The browser flow surfaces real, actionable messages (port in use,
        // consent denied), so they go straight to the dialog.
        set({ signingIn: false, error: String(e) });
      }
    },

    async signInWithToken(token) {
      set({ signingIn: true, error: null });
      try {
        apply(await api.authSignInWithToken(token));
      } catch (e) {
        set({ signingIn: false, error: String(e) });
      }
    },

    async signOut() {
      apply(await api.authSignOut());
    },

    async saveClientId(id) {
      await api.authSaveClientId(id);
      set({ hasClientId: id.trim().length > 0 });
    },

    clearError() {
      set({ error: null });
    },
  };
});
