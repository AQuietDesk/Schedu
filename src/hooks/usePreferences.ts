import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { commands } from "@/lib/commands";
import { GRADE_SCALE_PREF_KEY, parseGradeScale } from "@/lib/gradeScale";

const PREFS_KEY = ["preferences"];

export function usePreferences() {
  return useQuery({
    queryKey: PREFS_KEY,
    queryFn: async () => Object.fromEntries(await commands.listPreferences()) as Record<string, string>,
  });
}

/** The school-wide letter scale (falls back to the default until the user edits it). */
export function useGradeScale() {
  const { data: prefs } = usePreferences();
  return useMemo(() => parseGradeScale(prefs?.[GRADE_SCALE_PREF_KEY]), [prefs]);
}

export function useSetPreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => commands.setPreference(key, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PREFS_KEY }),
  });
}

export function useBackupNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => commands.backupNow(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PREFS_KEY }), // refreshes last_backup_at
  });
}

/**
 * Manually pulls whatever's in the shared backup folder, rather than waiting
 * for useRemoteBackupStatus's poll to notice it. Reuses check_remote_backup's
 * device-id/already-seen guards, so this stays a no-op when the folder holds
 * nothing newer than what's already here (including this device's own last
 * push) — it just runs that check on demand instead of every 5 minutes.
 * `synced: true` never actually resolves for the caller, since
 * restore_from_backup restarts the app on success.
 */
export function useSyncFromBackup() {
  return useMutation({
    mutationFn: async () => {
      const status = await commands.checkRemoteBackup();
      if (!status) return { synced: false as const };
      await commands.restoreFromBackup(status.written_at);
      return { synced: true as const };
    },
  });
}

const REMOTE_BACKUP_KEY = ["remoteBackupStatus"];
// Matches backup.rs's QUIET_PERIOD, so a device that just made an edit and a
// device that's just polling for a newer snapshot notice a change on roughly
// the same cadence.
const REMOTE_BACKUP_POLL_MS = 5 * 60 * 1000;

/** Polls for a newer backup pushed by another device into the shared folder. */
export function useRemoteBackupStatus() {
  return useQuery({
    queryKey: REMOTE_BACKUP_KEY,
    queryFn: () => commands.checkRemoteBackup(),
    refetchInterval: REMOTE_BACKUP_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

export function useDismissRemoteBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (writtenAt: string) => commands.dismissRemoteBackup(writtenAt),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: REMOTE_BACKUP_KEY }),
  });
}

/** Restarts the app on success, so there's nothing further for callers to do on resolve. */
export function useRestoreFromBackup() {
  return useMutation({
    mutationFn: (writtenAt: string) => commands.restoreFromBackup(writtenAt),
  });
}
