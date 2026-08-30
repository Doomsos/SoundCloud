/**
 * Data-fetching hooks. Port of the `FutureProvider`s in
 * `lib/core/api/feeds.dart`.
 *
 * TanStack Query stands in for Riverpod's `AsyncValue`: the same
 * loading/error/data triple, with caching and de-duplication that the Dart
 * providers got from the provider container.
 */

import {
  useInfiniteQuery,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import * as api from "./client";
import type {
  ArtistProfile,
  FeedPost,
  HomeData,
  LibraryData,
  PlaylistDetail,
  RailData,
  SearchResults,
  Track,
  TrackDetail,
} from "@/models";

/**
 * SoundCloud's editorial shelves change slowly and the calls are expensive, so
 * a screen revisited within the window renders from cache instead of refetching.
 */
const FRESH_MS = 5 * 60 * 1000;

export const queryKeys = {
  home: ["home"] as const,
  library: ["library"] as const,
  feed: ["feed"] as const,
  rail: ["rail"] as const,
  track: (id: string) => ["track", id] as const,
  artist: (handle: string) => ["artist", handle] as const,
  search: (q: string) => ["search", q] as const,
  playlist: (id: string) => ["playlist", id] as const,
  playlistTracks: (id: string) => ["playlistTracks", id] as const,
  history: ["history"] as const,
  likes: ["likes"] as const,
  logs: ["logs"] as const,
};

export const useHome = (): UseQueryResult<HomeData> =>
  useQuery({ queryKey: queryKeys.home, queryFn: api.home, staleTime: FRESH_MS });

export const useLibrary = (): UseQueryResult<LibraryData> =>
  useQuery({ queryKey: queryKeys.library, queryFn: api.library, staleTime: FRESH_MS });

export const useFeed = (): UseQueryResult<FeedPost[]> =>
  useQuery({ queryKey: queryKeys.feed, queryFn: api.feed, staleTime: FRESH_MS });

export const useRail = (): UseQueryResult<RailData> =>
  useQuery({ queryKey: queryKeys.rail, queryFn: api.rail, staleTime: FRESH_MS });

export const useTrackDetail = (id: string): UseQueryResult<TrackDetail> =>
  useQuery({
    queryKey: queryKeys.track(id),
    queryFn: () => api.trackDetail(id),
    enabled: id.length > 0,
  });

export const useArtistProfile = (handle: string): UseQueryResult<ArtistProfile> =>
  useQuery({
    queryKey: queryKeys.artist(handle),
    queryFn: () => api.artistProfile(handle),
    enabled: handle.length > 0,
  });

export const useSearch = (query: string): UseQueryResult<SearchResults> =>
  useQuery({
    queryKey: queryKeys.search(query),
    queryFn: () => api.search(query),
    enabled: query.trim().length > 0,
    // Search results are cheap to refetch and go stale quickly as the user
    // types; a short window is enough to de-duplicate keystrokes.
    staleTime: 30_000,
  });

export const usePlaylist = (id: string): UseQueryResult<PlaylistDetail> =>
  useQuery({
    queryKey: queryKeys.playlist(id),
    queryFn: () => api.playlist(id),
    enabled: id.length > 0,
  });

/**
 * Every track in a playlist, hydrating the stubs the playlist payload leaves
 * behind. Separate from `usePlaylist` because it is only needed when the user
 * actually presses play.
 */
export const usePlaylistTracks = (id: string, enabled: boolean): UseQueryResult<Track[]> =>
  useQuery({
    queryKey: queryKeys.playlistTracks(id),
    queryFn: () => api.allPlaylistTracks(id),
    enabled: enabled && id.length > 0,
  });

export const useHistory = (limit = 50): UseQueryResult<Track[]> =>
  useQuery({
    queryKey: [...queryKeys.history, limit],
    queryFn: () => api.historyPage(limit, 0),
    staleTime: 60_000,
  });

/**
 * Every liked track, a page at a time. Port of `_PaginatedLikesTab`: a large
 * library is thousands of tracks, so the tab pages through `next_href` rather
 * than showing the first fifty.
 */
export const useLikedTracks = (): UseInfiniteQueryResult<
  { pages: import("@/models").LikesPage[] },
  Error
> =>
  useInfiniteQuery({
    queryKey: queryKeys.likes,
    queryFn: ({ pageParam }) => api.likesPage(pageParam ?? undefined, 50),
    initialPageParam: undefined as string | undefined,
    // A missing cursor is the end of the list.
    getNextPageParam: (last) => last.nextHref ?? undefined,
    staleTime: FRESH_MS,
  });

export const useLogs = (): UseQueryResult<import("@/models").LogEntry[]> =>
  useQuery({
    queryKey: queryKeys.logs,
    queryFn: api.logsSnapshot,
    // The logs view is a live tail.
    refetchInterval: 1000,
    staleTime: 0,
  });
