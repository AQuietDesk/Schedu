import { useState } from "react";
import { CloudDownload } from "lucide-react";
import { PrimaryButton, SecondaryButton } from "@/components/lo/primitives";
import { useDismissRemoteBackup, useRemoteBackupStatus, useRestoreFromBackup } from "@/hooks/usePreferences";

/**
 * Surfaces whenever another device has pushed a newer snapshot into the
 * shared backup folder (see backup.rs's check_remote_backup, polled every
 * few minutes by useRemoteBackupStatus). Loading it restarts the app onto
 * that snapshot; "Keep this device's" just marks it seen so it stops resurfacing.
 */
export function RemoteBackupPrompt() {
  const { data: status } = useRemoteBackupStatus();
  const dismiss = useDismissRemoteBackup();
  const restore = useRestoreFromBackup();
  const [restoring, setRestoring] = useState(false);

  if (!status) return null;
  const writtenAt = status.written_at;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-24 dark:bg-black/50">
      <div role="alertdialog" aria-label="Newer data found" className="w-full max-w-md rounded-[18px] border border-line bg-popover p-6 shadow-pop">
        <div className="flex items-start gap-3">
          <CloudDownload className="mt-0.5 size-5 shrink-0 text-brand" />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">Newer data found</p>
            <p className="mt-1.5 text-sm leading-relaxed text-fg2">
              Another device backed up to your shared folder on {new Date(writtenAt).toLocaleString()}. Load it here? This
              replaces everything on this device with that snapshot.
            </p>
            {restore.isError && <p className="mt-2 text-sm text-danger">{String(restore.error)}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <SecondaryButton disabled={restoring} onClick={() => dismiss.mutate(writtenAt)}>
            Keep this device’s
          </SecondaryButton>
          <PrimaryButton
            disabled={restoring}
            onClick={() => {
              setRestoring(true);
              restore.mutate(writtenAt, { onError: () => setRestoring(false) });
            }}
          >
            {restoring ? "Restoring…" : "Load it"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
