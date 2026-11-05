import { RefreshCw } from "lucide-react";
import { SecondaryButton } from "@/components/lo/primitives";
import { useGoogleConnected, useResolveConflict, useSyncConflicts } from "@/hooks/useGoogle";

/** Shown on Today only when Google and Schedu both changed the same task. */
export function SyncConflicts() {
  const { data: connected } = useGoogleConnected();
  const { data: conflicts } = useSyncConflicts();
  const resolveConflict = useResolveConflict();

  if (!connected || !conflicts || conflicts.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-line bg-card p-5">
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 text-danger" />
        <h2 className="text-[15px] font-semibold">
          {conflicts.length} sync conflict{conflicts.length === 1 ? "" : "s"}
        </h2>
      </div>
      {conflicts.map((conflict) => (
        <div key={conflict.id} className="rounded-xl bg-sunken p-4 text-sm">
          <p className="mb-3 text-[13px] text-fg2">
            Both Schedu and Google {conflict.source === "calendar" ? "Calendar" : "Tasks"} changed this since the last sync.
          </p>
          {conflict.diff.length > 0 ? (
            <div className="mb-3 space-y-2">
              {conflict.diff.map((d) => (
                <div key={d.field} className="grid grid-cols-2 gap-3 text-[13px]">
                  <div>
                    <p className="text-xs text-fg3">{d.field} · yours</p>
                    <p className="whitespace-pre-wrap">{d.local}</p>
                  </div>
                  <div>
                    <p className="text-xs text-fg3">{d.field} · Google</p>
                    <p className="whitespace-pre-wrap">{d.remote}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-3 text-[13px] text-fg3">Nothing visibly different — probably a sync timing overlap.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              disabled={resolveConflict.isPending}
              onClick={() => resolveConflict.mutate({ id: conflict.id, resolution: "mine" })}
            >
              Keep mine
            </SecondaryButton>
            <SecondaryButton
              disabled={resolveConflict.isPending}
              onClick={() => resolveConflict.mutate({ id: conflict.id, resolution: "google" })}
            >
              Keep Google’s
            </SecondaryButton>
            <button
              type="button"
              disabled={resolveConflict.isPending}
              onClick={() => resolveConflict.mutate({ id: conflict.id, resolution: "dismiss" })}
              className="h-[34px] px-3 text-[13px] text-fg3 hover:text-fg2"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
