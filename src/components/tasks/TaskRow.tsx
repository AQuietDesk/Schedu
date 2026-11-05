import { AlertTriangle, Flag, Repeat } from "lucide-react";
import { Dot, TaskCheck } from "@/components/lo/primitives";
import { useUpdateItem } from "@/hooks/useItems";
import { itemContextInfo } from "@/lib/areas";
import { daysUntil } from "@/lib/dates";
import { formatDue, formatMinutes, formatTime, nextStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { usePeekStore } from "@/store/peekStore";
import type { Context, Item, ItemSyncStatusValue } from "@/types";

export function TaskRow({
  item,
  contextsById,
  showContext = true,
  dueStyle = "date",
  syncStatus,
  selected,
  last = false,
}: {
  item: Item;
  contextsById: Map<string, Context>;
  showContext?: boolean;
  /** "date": relative date label; "time": just the time (for day-grouped lists); "none". */
  dueStyle?: "date" | "time" | "none";
  syncStatus?: ItemSyncStatusValue;
  selected?: boolean;
  last?: boolean;
}) {
  const updateItem = useUpdateItem();
  const openPeek = usePeekStore((s) => s.open);
  const peekId = usePeekStore((s) => s.itemId);
  const done = item.status === "Completed";
  const days = daysUntil(item.due_date);
  const overdue = !done && days !== null && days < 0;
  const info = itemContextInfo(item, contextsById);
  const isSelected = selected ?? peekId === item.id;

  const dueLabel =
    dueStyle === "none"
      ? ""
      : dueStyle === "time"
        ? formatTime(item.due_time)
        : formatDue(item, new Date(), days !== null && days >= 0 && days < 7);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openPeek(item.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPeek(item.id);
        }
      }}
      className={cn(
        "group flex min-h-[46px] cursor-default items-center gap-3 rounded-lg px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
        !last && "border-b border-line",
        isSelected ? "bg-brand-soft" : "hover:bg-sunken",
      )}
    >
      <TaskCheck
        status={item.status}
        overdue={overdue}
        label={item.title}
        onToggle={() => updateItem.mutate({ ...item, status: nextStatus(item.status) })}
      />
      <span className={cn("min-w-0 flex-1 truncate text-[14.5px]", done && "text-fg3 line-through")}>{item.title}</span>

      {syncStatus === "failed" || syncStatus === "conflict" ? (
        <AlertTriangle className="size-3.5 shrink-0 text-danger" aria-label={syncStatus === "failed" ? "Sync failed" : "Sync conflict"} />
      ) : null}
      {item.repeat_settings && <Repeat className="size-3.5 shrink-0 text-fg3" aria-label="Repeats" />}
      {item.priority === "High" && !done && <Flag className="size-3.5 shrink-0 text-danger" aria-label="High priority" />}
      {item.estimated_duration && !done ? (
        <span className="hidden shrink-0 text-[12.5px] text-fg3 sm:inline">{formatMinutes(item.estimated_duration)}</span>
      ) : null}
      {showContext && (
        <span className="hidden max-w-[180px] shrink-0 items-center gap-1.5 text-[12.5px] text-fg2 md:inline-flex">
          <Dot color={info.color} className="size-[7px]" />
          <span className="truncate">{info.label}</span>
        </span>
      )}
      {dueLabel && (
        <span className={cn("min-w-[84px] shrink-0 whitespace-nowrap text-right text-[12.5px]", overdue ? "font-medium text-danger" : "text-fg3")}>
          {dueLabel}
        </span>
      )}
    </div>
  );
}
