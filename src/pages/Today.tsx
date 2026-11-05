import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Timer } from "lucide-react";
import { EmptyState, PrimaryButton, SecondaryButton, TopBar } from "@/components/lo/primitives";
import { QueryBoundary } from "@/components/QueryBoundary";
import { InlineAdd } from "@/components/tasks/InlineAdd";
import { TaskRow } from "@/components/tasks/TaskRow";
import { DayRing } from "@/components/today/DayRing";
import { SyncConflicts } from "@/components/today/SyncConflicts";
import { AttentionStrip, FocusCard, NotesCard, WeatherChip } from "@/components/today/Widgets";
import { useContexts } from "@/hooks/useContexts";
import { useGoogleConnected, useItemSyncStatuses } from "@/hooks/useGoogle";
import { useItems } from "@/hooks/useItems";
import { useNowTick } from "@/hooks/useNowTick";
import { usePreferences } from "@/hooks/usePreferences";
import { contextsMap, itemContextInfo } from "@/lib/areas";
import { parseDateOnly } from "@/lib/calendarGrid";
import { daysUntil } from "@/lib/dates";
import { comingUp, formatTime, isDone, todayItems } from "@/lib/tasks";
import { usePeekStore } from "@/store/peekStore";
import { useSearchStore } from "@/store/searchStore";
import type { Item } from "@/types";

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function summaryLine(items: Item[], today: Item[]): string {
  const left = today.filter((i) => !isDone(i));
  const overdue = left.filter((i) => (daysUntil(i.due_date) ?? 0) < 0).length;
  const next = items
    .filter((i) => !isDone(i) && (daysUntil(i.due_date) ?? -1) >= 1)
    .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1))[0];
  const parts: string[] = [];
  if (left.length === 0) parts.push("Nothing left for today.");
  else parts.push(`${left.length} task${left.length === 1 ? "" : "s"} left today${overdue ? `, ${overdue} overdue` : ""}.`);
  if (next) {
    const when = parseDateOnly(next.due_date!).toLocaleDateString(undefined, { weekday: "long" });
    parts.push(`Next up: ${next.title} ${daysUntil(next.due_date) === 1 ? "tomorrow" : `on ${when}`}.`);
  }
  return parts.join(" ");
}

export default function Today() {
  const navigate = useNavigate();
  const openSearch = useSearchStore((s) => s.open);
  const openPeek = usePeekStore((s) => s.open);
  const itemsQuery = useItems();
  const { data: contexts } = useContexts();
  const { data: prefs } = usePreferences();
  const { data: connected } = useGoogleConnected();
  const { data: syncStatuses } = useItemSyncStatuses(!!connected);
  const now = useNowTick(60_000);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const byId = useMemo(() => contextsMap(contexts), [contexts]);
  const syncById = useMemo(() => new Map((syncStatuses ?? []).map((s) => [s.item_id, s.status])), [syncStatuses]);
  // Recomputed on the minute tick so "today" rolls over at midnight.
  const today = useMemo(() => todayItems(items, now), [items, now]);
  const upcoming = useMemo(() => comingUp(items, 7, now), [items, now]);
  const name = prefs?.user_name?.trim();

  return (
    <div className="flex min-h-full flex-col">
      <TopBar
        actions={
          <>
            <WeatherChip />
            <SecondaryButton onClick={() => navigate("/focus")}>
              <Timer />
              Focus
            </SecondaryButton>
            <PrimaryButton onClick={() => openSearch()}>
              <Plus />
              New task
            </PrimaryButton>
          </>
        }
      >
        Today
      </TopBar>

      <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-9 px-6 pb-14 pt-11 md:px-12">
        <header className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg3">
            {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </span>
          <h1 className="text-[36px] font-semibold leading-tight tracking-[-0.025em]">
            {greeting(now)}
            {name ? `, ${name}` : ""}
          </h1>
          <p className="mt-1 text-[15px] text-fg2">{itemsQuery.isSuccess && summaryLine(items, today)}</p>
        </header>

        <QueryBoundary
          isLoading={itemsQuery.isLoading}
          isError={itemsQuery.isError}
          error={itemsQuery.error}
          onRetry={() => itemsQuery.refetch()}
        >
          <div className="flex flex-wrap items-start gap-10">
            <div className="flex min-w-0 flex-[999_1_460px] flex-col gap-9">
              <AttentionStrip items={items} itemsReady={itemsQuery.isSuccess} contextsById={byId} />
              <SyncConflicts />

              <section className="flex flex-col">
                <div className="flex items-baseline justify-between pb-2.5">
                  <h2 className="text-base font-semibold">
                    Today <span className="ml-1 font-normal text-fg3">{today.filter((i) => !isDone(i)).length}</span>
                  </h2>
                  <Link to="/tasks" className="text-[13px] text-fg3 hover:text-fg2">
                    All tasks
                  </Link>
                </div>
                <InlineAdd placeholder="Add a task — try “cello prep tomorrow 4pm”" showKbd />
                {today.length === 0 ? (
                  <EmptyState>You’re clear for today.</EmptyState>
                ) : (
                  today.map((item, i) => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      contextsById={byId}
                      syncStatus={syncById.get(item.id)}
                      dueStyle={daysUntil(item.due_date, now)! < 0 ? "date" : item.due_time ? "time" : "none"}
                      last={i === today.length - 1}
                    />
                  ))
                )}
              </section>

              <section className="flex flex-col">
                <div className="flex items-baseline justify-between pb-2.5">
                  <h2 className="text-base font-semibold">Coming up</h2>
                  <Link to="/calendar" className="text-[13px] text-fg3 hover:text-fg2">
                    Next 7 days
                  </Link>
                </div>
                {upcoming.length === 0 ? (
                  <EmptyState>Nothing due in the next week.</EmptyState>
                ) : (
                  upcoming.map(({ date, items: dayItems }, gi) => {
                    const d = parseDateOnly(date);
                    return (
                      <div key={date} className={gi < upcoming.length - 1 ? "flex gap-4 border-b border-line p-3" : "flex gap-4 p-3"}>
                        <div className="flex w-[84px] shrink-0 flex-col">
                          <span className="text-[13px] font-semibold">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                          <span className="text-[12.5px] text-fg3">{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                          {dayItems.map((item) => {
                            const info = itemContextInfo(item, byId);
                            return (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => openPeek(item.id)}
                                className="flex items-center gap-2.5 rounded-md text-left text-sm hover:text-brand"
                              >
                                <span className="h-[18px] w-[3px] shrink-0 rounded-sm" style={{ background: info.color }} />
                                <span className="min-w-0 flex-1 truncate">
                                  {item.title}
                                  {info.classId && <span className="text-fg3"> — {info.label}</span>}
                                </span>
                                {item.assignment_type && (
                                  <span className="hidden shrink-0 rounded-full bg-sunken px-2 py-0.5 text-xs text-fg2 sm:inline">
                                    {item.assignment_type}
                                  </span>
                                )}
                                <span className="w-[70px] shrink-0 text-right text-[12.5px] text-fg3">{formatTime(item.due_time)}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}
              </section>
            </div>

            <div className="flex min-w-0 flex-[1_1_330px] flex-col gap-4">
              <DayRing items={items} />
              <FocusCard />
              <NotesCard />
            </div>
          </div>
        </QueryBoundary>
      </div>
    </div>
  );
}

