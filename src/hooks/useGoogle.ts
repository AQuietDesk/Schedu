import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";

const CONNECTED_KEY = ["google", "connected"];
const CONFLICTS_KEY = ["google", "conflicts"];
const UPCOMING_EVENTS_KEY = ["google", "upcomingEvents"];
const UPCOMING_TASKS_KEY = ["google", "upcomingTasks"];
const CALENDAR_LIST_KEY = ["google", "calendarList"];
export const ITEM_SYNC_STATUSES_KEY = ["google", "itemSyncStatuses"];

export function useGoogleConnected() {
  return useQuery({
    queryKey: CONNECTED_KEY,
    queryFn: commands.isGoogleConnected,
    // The background sync loop can disconnect on its own (a dead refresh
    // token) with no way to push that into the frontend's cache directly —
    // polling is what makes an already-open Settings page notice and swap
    // to the reconnect prompt without the user having to navigate away and back.
    refetchInterval: 60_000,
  });
}

export function useConnectGoogle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.connectGoogle(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["google"] }),
  });
}

export function useDisconnectGoogle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.disconnectGoogle(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["google"] }),
  });
}

export function useSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.syncNow(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items"] });
      // Prefix match: also covers ["google", "itemSyncStatuses"] and
      // ["google", "conflicts"].
      queryClient.invalidateQueries({ queryKey: ["google"] });
    },
    // A dead refresh token gets cleared server-side as part of the failure
    // itself (see oauth::RECONNECT_REQUIRED) — refetching here is what makes
    // the UI notice and swap to the reconnect prompt immediately instead of
    // waiting on the next poll.
    onError: () => {
      queryClient.invalidateQueries({ queryKey: ["google"] });
    },
  });
}

export function useSyncConflicts() {
  return useQuery({ queryKey: CONFLICTS_KEY, queryFn: commands.listSyncConflicts });
}

// Polled rather than only invalidated on mutation: the background sync loop
// and the debounced per-item push (see google/sync.rs's PushDebouncer) can
// both change an item's sync status without any frontend action at all —
// this is what makes a "Sync failed" badge or a Pending→Synced transition
// show up on its own instead of only after the user does something.
export function useItemSyncStatuses(enabled: boolean) {
  return useQuery({
    queryKey: ITEM_SYNC_STATUSES_KEY,
    queryFn: commands.listItemSyncStatuses,
    enabled,
    refetchInterval: 15_000,
  });
}

export function usePushItemNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => commands.pushItemNow(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["google"] });
    },
  });
}

export function useResolveConflict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: "mine" | "google" | "dismiss" }) =>
      commands.resolveConflict(id, resolution),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CONFLICTS_KEY });
      queryClient.invalidateQueries({ queryKey: ["items"] });
    },
  });
}

export function useUpcomingCalendarEvents(enabled: boolean) {
  return useQuery({
    queryKey: UPCOMING_EVENTS_KEY,
    queryFn: commands.listUpcomingCalendarEvents,
    enabled,
  });
}

export function useUpcomingGoogleTasks(enabled: boolean) {
  return useQuery({
    queryKey: UPCOMING_TASKS_KEY,
    queryFn: commands.listUpcomingGoogleTasks,
    enabled,
  });
}

export function useCalendarList(enabled: boolean) {
  return useQuery({ queryKey: CALENDAR_LIST_KEY, queryFn: commands.listCalendars, enabled });
}

// One request per calendar (Google has no "merge these N calendars" events
// endpoint) — keyed by calendar + the visible range so navigating the
// Calendar page's month/week grid, or changing which calendars are shown in
// Settings, refetches exactly what changed. `useQueries` (plural) is what
// lets the number of queries vary at runtime with the selected calendar list,
// which a fixed set of `useQuery` calls can't do (rules of hooks).
export function useCalendarEventsInRangeForCalendars(
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  enabled: boolean,
) {
  return useQueries({
    queries: calendarIds.map((calendarId) => ({
      queryKey: ["google", "calendarRange", calendarId, timeMin, timeMax],
      queryFn: () => commands.listCalendarEventsInRange(calendarId, timeMin, timeMax),
      enabled,
      staleTime: 60_000,
    })),
  });
}
