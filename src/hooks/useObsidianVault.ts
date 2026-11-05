import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands } from "@/lib/commands";

export function useObsidianSearch(query: string) {
  return useQuery({
    queryKey: ["search", "obsidian", query],
    queryFn: () => commands.searchObsidianVault(query),
    enabled: query.trim().length > 0,
  });
}

export function useObsidianNote(relativePath: string | null) {
  return useQuery({
    queryKey: ["obsidian-note", relativePath],
    queryFn: () => commands.readObsidianNote(relativePath as string),
    enabled: !!relativePath,
  });
}

export function useTestObsidianVault() {
  return useMutation({
    mutationFn: (path: string) => commands.testObsidianVault(path),
  });
}

/**
 * Runs the deterministic "Next Steps" / "Action Items" checkbox scan (build
 * spec Phase 11). Invalidates `items` (new/completed tasks) and
 * `preferences` (the persisted last-scan status the Settings page reads).
 */
export function useScanObsidianTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.scanObsidianTasks(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
    },
  });
}
