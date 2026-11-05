import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Search } from "lucide-react";
import { Dot, EmptyState, PrimaryButton, Segmented, TopBar } from "@/components/lo/primitives";
import { QueryBoundary } from "@/components/QueryBoundary";
import { InlineAdd } from "@/components/tasks/InlineAdd";
import { TaskRow } from "@/components/tasks/TaskRow";
import { useContexts } from "@/hooks/useContexts";
import { useGoogleConnected, useItemSyncStatuses } from "@/hooks/useGoogle";
import { useItems } from "@/hooks/useItems";
import { contextsMap, itemArea, itemContextInfo, PERSONAL_HEX, personalList } from "@/lib/areas";
import { daysUntil } from "@/lib/dates";
import { BUCKET_LABEL, compareByDue, groupByBucket, isDone } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { useSearchStore } from "@/store/searchStore";
import type { Item, Priority } from "@/types";

type View = "upcoming" | "all" | "overdue" | "done";
type GroupBy = "due" | "context";

const selectClass =
  "h-8 rounded-lg border border-line2 bg-transparent px-2.5 text-[13px] text-fg2 outline-none hover:bg-hover focus:ring-2 focus:ring-ring/40";

export default function Tasks() {
  const [params, setParams] = useSearchParams();
  const openSearch = useSearchStore((s) => s.open);
  const itemsQuery = useItems();
  const { data: contexts } = useContexts();
  const { data: connected } = useGoogleConnected();
  const { data: syncStatuses } = useItemSyncStatuses(!!connected);
  const [filter, setFilter] = useState("");
  const [priority, setPriority] = useState<Priority | "any">("any");
  const [groupBy, setGroupBy] = useState<GroupBy>("due");

  const view = (params.get("view") as View | null) ?? "upcoming";
  const area = params.get("area") as "School" | "Personal" | null;
  const list = params.get("list");
  const byId = useMemo(() => contextsMap(contexts), [contexts]);
  const syncById = useMemo(() => new Map((syncStatuses ?? []).map((s) => [s.item_id, s.status])), [syncStatuses]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const scoped = useMemo(() => {
    const all = itemsQuery.data ?? [];
    return all.filter((i) => {
      if (list) return personalList(i) === list;
      if (area) return itemArea(i) === area;
      return true;
    });
  }, [itemsQuery.data, area, list]);

  const overdueCount = scoped.filter((i) => !isDone(i) && (daysUntil(i.due_date) ?? 0) < 0).length;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return scoped.filter((i) => {
      if (view === "upcoming" && isDone(i)) return false;
      if (view === "overdue" && (isDone(i) || (daysUntil(i.due_date) ?? 0) >= 0)) return false;
      if (view === "done" && !isDone(i)) return false;
      if (priority !== "any" && i.priority !== priority) return false;
      if (q && !`${i.title} ${i.notes ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [scoped, view, priority, filter]);

  const groups: { key: string; label: string; color?: string; tone?: "danger"; items: Item[] }[] = useMemo(() => {
    if (view === "done") {
      const sorted = [...visible].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return sorted.length ? [{ key: "done", label: "Completed", items: sorted }] : [];
    }
    if (groupBy === "context") {
      const map = new Map<string, { label: string; color: string; items: Item[] }>();
      for (const item of [...visible].sort(compareByDue)) {
        const info = itemContextInfo(item, byId);
        const key = `${itemArea(item)}:${info.label}`;
        if (!map.has(key)) map.set(key, { label: info.label, color: info.color, items: [] });
        map.get(key)!.items.push(item);
      }
      return Array.from(map.entries())
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([key, g]) => ({ key, ...g }));
    }
    return groupByBucket(visible).map(({ bucket, items }) => ({
      key: bucket,
      label: BUCKET_LABEL[bucket],
      tone: bucket === "overdue" ? ("danger" as const) : undefined,
      items,
    }));
  }, [visible, view, groupBy, byId]);

  const title = list ?? area ?? "Tasks";

  return (
    <div className="flex min-h-full flex-col">
      <TopBar
        actions={
          <PrimaryButton onClick={() => openSearch(list ? `#${list} ` : "")}>
            <Plus />
            New task
          </PrimaryButton>
        }
      >
        <span>Tasks</span>
        {(list || area) && (
          <>
            <span className="text-fg3">/</span>
            <span className="text-foreground">{title}</span>
          </>
        )}
      </TopBar>

      <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-5 px-6 pb-14 pt-9 md:px-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="flex items-center gap-3 text-[32px] font-semibold tracking-[-0.025em]">
            {list && <Dot color={PERSONAL_HEX} className="size-3" />}
            {title}
          </h1>
          <Segmented<View>
            label="View"
            value={view}
            onChange={(v) => setParam("view", v === "upcoming" ? null : v)}
            options={[
              { value: "upcoming", label: "Upcoming" },
              { value: "all", label: "All" },
              {
                value: "overdue",
                label: (
                  <>
                    Overdue {overdueCount > 0 && <span className="text-danger">{overdueCount}</span>}
                  </>
                ),
              },
              { value: "done", label: "Done" },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!list && (
            <select aria-label="Area" className={selectClass} value={area ?? ""} onChange={(e) => setParam("area", e.target.value || null)}>
              <option value="">All areas</option>
              <option value="School">School</option>
              <option value="Personal">Personal</option>
            </select>
          )}
          {list && (
            <button type="button" className={selectClass} onClick={() => setParam("list", null)}>
              {list} ✕
            </button>
          )}
          <select aria-label="Priority" className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value as Priority | "any")}>
            <option value="any">Any priority</option>
            <option value="High">High</option>
            <option value="Medium">Medium</option>
            <option value="Low">Low</option>
          </select>
          {view !== "done" && (
            <select aria-label="Group by" className={selectClass} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="due">Group: Due date</option>
              <option value="context">Group: Class or list</option>
            </select>
          )}
          <label className="ml-auto flex h-8 items-center gap-2 rounded-lg bg-sunken px-2.5 text-[13px] text-fg3 focus-within:ring-2 focus-within:ring-ring/40">
            <Search className="size-3.5" />
            <input
              aria-label="Filter tasks"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-36 bg-transparent text-foreground outline-none placeholder:text-fg3"
            />
          </label>
        </div>

        <QueryBoundary isLoading={itemsQuery.isLoading} isError={itemsQuery.isError} error={itemsQuery.error} onRetry={() => itemsQuery.refetch()}>
          <div className="flex flex-col">
            {view !== "done" && (
              <InlineAdd
                placeholder={list ? `Add to ${list}` : area === "School" ? "Add a school task — #class to file it" : "Add a task"}
                defaults={{ list: list ?? undefined, school: area === "School" && !list }}
              />
            )}
            {groups.length === 0 ? (
              <EmptyState>{view === "done" ? "Nothing completed yet." : view === "overdue" ? "Nothing overdue. Nice." : "No tasks here."}</EmptyState>
            ) : (
              groups.map((group) => (
                <div key={group.key} className="flex flex-col">
                  <h2 className={cn("flex items-center gap-2 px-3 pb-1.5 pt-[18px] text-[13px] font-semibold", group.tone === "danger" && "text-danger")}>
                    {group.color && <Dot color={group.color} />}
                    {group.label}
                    <span className="font-normal text-fg3">{group.items.length}</span>
                  </h2>
                  {group.items.map((item, i) => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      contextsById={byId}
                      showContext={groupBy === "due" || view === "done"}
                      syncStatus={syncById.get(item.id)}
                      last={i === group.items.length - 1}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        </QueryBoundary>
      </div>
    </div>
  );
}
