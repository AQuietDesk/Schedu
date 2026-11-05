import { AlertTriangle, Check, Clock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushItemNow } from "@/hooks/useGoogle";
import type { ItemSyncStatusValue } from "@/types";

const LABELS: Record<ItemSyncStatusValue, string> = {
  synced: "Synced",
  pending: "Pending",
  failed: "Sync failed",
  conflict: "Conflict",
};

// One badge + (when failed) a "Retry Sync" action, shared by every place an
// Item's sync state is shown, so the status iconography/wording only needs
// to change in one place.
export function SyncStatusCell({
  itemId,
  status,
  error,
}: {
  itemId: string;
  status: ItemSyncStatusValue | undefined;
  error?: string | null;
}) {
  const pushItemNow = usePushItemNow();
  if (!status) return null;

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs" title={error ?? undefined}>
      {status === "synced" && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
      {status === "pending" && <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
      {(status === "failed" || status === "conflict") && (
        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
      )}
      <span className={status === "failed" || status === "conflict" ? "text-destructive" : "text-muted-foreground"}>
        {LABELS[status]}
      </span>
      {status === "failed" && (
        <Button
          size="sm"
          variant="ghost"
          className="h-auto gap-1 px-1.5 py-0 text-xs text-muted-foreground"
          disabled={pushItemNow.isPending}
          onClick={() => pushItemNow.mutate(itemId)}
        >
          <RefreshCw className={`h-3 w-3 ${pushItemNow.isPending ? "animate-spin" : ""}`} />
          Retry
        </Button>
      )}
    </span>
  );
}
