import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import { useFocusStore } from "@/store/focusStore";

const FOCUS_SESSIONS_KEY = ["focusSessions"];

export function useFocusSessions() {
  // closedVersion bumps whenever a session closes (see focusStore.ts) — kept
  // in the query key so a just-finished session shows up here without extra
  // invalidate wiring between the store and the query cache.
  const closedVersion = useFocusStore((s) => s.closedVersion);
  return useQuery({
    queryKey: [...FOCUS_SESSIONS_KEY, closedVersion],
    queryFn: commands.listFocusSessions,
  });
}

export function useDeleteFocusSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => commands.deleteFocusSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: FOCUS_SESSIONS_KEY }),
  });
}
