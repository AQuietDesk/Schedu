import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Dot, Panel, Segmented, StatTile, TopBar } from "@/components/lo/primitives";
import { QueryBoundary } from "@/components/QueryBoundary";
import { useContexts } from "@/hooks/useContexts";
import { useFocusSessions } from "@/hooks/useFocusSessions";
import { useItems } from "@/hooks/useItems";
import { activeClasses, contextsMap, itemContextInfo, PERSONAL_HEX } from "@/lib/areas";
import { parseDateOnly } from "@/lib/calendarGrid";
import { classColorHex } from "@/lib/classColors";
import { formatFocusDuration } from "@/lib/focusStatistics";
import { useGradeScale } from "@/hooks/usePreferences";
import { calculateGrade } from "@/lib/gradeCalculation";
import { completedInRange, dailyCompletionTrend, missedDeadlines, onTimeRate, studyStreak } from "@/lib/statistics";
import { cn } from "@/lib/utils";

type Range = "7" | "30" | "120";
const RANGE_LABEL: Record<Range, string> = { "7": "7 days", "30": "30 days", "120": "Term" };

export default function Stats() {
  const itemsQuery = useItems();
  const contextsQuery = useContexts();
  const schoolScale = useGradeScale();
  const { data: sessionsData } = useFocusSessions();
  const [range, setRange] = useState<Range>("30");
  const days = Number(range);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const sessions = useMemo(() => sessionsData ?? [], [sessionsData]);
  const byId = useMemo(() => contextsMap(contextsQuery.data), [contextsQuery.data]);
  const classes = activeClasses(contextsQuery.data);

  const now = new Date();
  const completed = completedInRange(items, days, now).length;
  const previous = completedInRange(items, days * 2, now).length - completed;
  const delta = completed - previous;
  const onTime = onTimeRate(items, days, now);
  const missed = missedDeadlines(items, now);

  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  const rangeSessions = sessions.filter((s) => new Date(s.started_at) >= from);
  const focusSeconds = rangeSessions.reduce((sum, s) => sum + (s.actual_duration_seconds ?? 0), 0);
  const streak = studyStreak(items, sessions, now);

  const trend = dailyCompletionTrend(items, Math.min(days, 60), now);
  const maxCount = Math.max(1, ...trend.map((t) => t.count));

  // Focus time by class (via the linked task), else by area.
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const focusBy = new Map<string, { label: string; color: string; seconds: number }>();
  for (const s of rangeSessions) {
    const item = s.item_id ? itemsById.get(s.item_id) : undefined;
    const info = item
      ? itemContextInfo(item, byId)
      : s.category === "School"
        ? { label: "School", color: classColorHex(null), classId: null }
        : { label: "Personal", color: PERSONAL_HEX, classId: null };
    const key = info.label;
    const cur = focusBy.get(key) ?? { label: info.label, color: info.color, seconds: 0 };
    cur.seconds += s.actual_duration_seconds ?? 0;
    focusBy.set(key, cur);
  }
  const focusRows = Array.from(focusBy.values())
    .filter((r) => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const focusTotal = focusRows.reduce((a, r) => a + r.seconds, 0);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar>Stats</TopBar>
      <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-8 px-6 pb-14 pt-10 md:px-12">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[34px] font-semibold tracking-[-0.025em]">Stats</h1>
          <Segmented<Range>
            label="Range"
            value={range}
            onChange={setRange}
            options={(["7", "30", "120"] as Range[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
          />
        </div>

        <QueryBoundary
          isLoading={itemsQuery.isLoading || contextsQuery.isLoading}
          isError={itemsQuery.isError || contextsQuery.isError}
          error={itemsQuery.error ?? contextsQuery.error}
          onRetry={() => {
            itemsQuery.refetch();
            contextsQuery.refetch();
          }}
        >
          <div className="flex flex-col gap-8">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile
                label="Completed"
                value={completed}
                hint={delta === 0 ? "Same as the period before" : `${delta > 0 ? "+" : ""}${delta} vs the period before`}
                hintTone={delta > 0 ? "good" : undefined}
              />
              <StatTile
                label="On time"
                value={onTime === null ? "—" : `${Math.round(onTime * 100)}%`}
                hint={missed === 0 ? "Nothing overdue" : `${missed} overdue now`}
                hintTone={missed > 0 ? "bad" : undefined}
              />
              <StatTile
                label="Focus time"
                value={formatFocusDuration(focusSeconds)}
                hint={`${rangeSessions.length} session${rangeSessions.length === 1 ? "" : "s"}`}
              />
              <StatTile label="Study streak" value={`${streak.current} day${streak.current === 1 ? "" : "s"}`} hint={`Best: ${streak.best}`} />
            </div>

            <Panel
              title="Tasks completed per day"
              action={`${parseDateOnly(trend[0].date).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – today`}
            >
              <div
                role="img"
                aria-label={`Tasks completed each day over the last ${trend.length} days, up to ${maxCount} in a day`}
                className="flex h-40 items-end gap-[3px] border-b border-line"
              >
                {trend.map((t, i) => (
                  <span
                    key={t.date}
                    title={`${parseDateOnly(t.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${t.count}`}
                    className={cn("min-w-0 flex-1 rounded-t-[4px]", i === trend.length - 1 ? "bg-foreground" : "bg-line2 hover:bg-fg3")}
                    style={{ height: Math.max(3, (t.count / maxCount) * 152) }}
                  />
                ))}
              </div>
            </Panel>

            <div className="flex flex-wrap gap-4">
              <Panel title="Class progress" className="min-w-0 flex-[1_1_380px]">
                {classes.length === 0 ? (
                  <p className="text-sm text-fg3">No active classes.</p>
                ) : (
                  <div className="flex flex-col gap-3.5 text-[13.5px]">
                    {classes.map((c) => {
                      const classItems = items.filter((i) => i.subcategory_id === c.id);
                      const done = classItems.filter((i) => i.status === "Completed").length;
                      const grade = calculateGrade(classItems, c, schoolScale).currentGrade;
                      const color = classColorHex(c.color);
                      return (
                        <Link key={c.id} to={`/school/${c.id}`} className="flex flex-col gap-1.5 hover:opacity-80">
                          <div className="flex justify-between gap-3">
                            <span className="flex min-w-0 items-center gap-2">
                              <Dot color={color} />
                              <span className="truncate">{c.name}</span>
                            </span>
                            <span className="shrink-0 text-fg2">
                              {done}/{classItems.length}
                              {grade != null && ` · ${grade.toFixed(1)}%`}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-sunken">
                            <div className="h-1.5 rounded-full" style={{ width: `${classItems.length ? (done / classItems.length) * 100 : 0}%`, background: color }} />
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </Panel>

              <Panel title="Where focus went" className="min-w-0 flex-[1_1_300px]">
                {focusRows.length === 0 ? (
                  <p className="text-sm text-fg3">No focus sessions in this range.</p>
                ) : (
                  <>
                    <div aria-hidden="true" className="flex h-3 gap-0.5 overflow-hidden rounded-md">
                      {focusRows.map((r) => (
                        <span key={r.label} style={{ width: `${(r.seconds / focusTotal) * 100}%`, background: r.color }} />
                      ))}
                    </div>
                    <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-2">
                      {focusRows.map((r) => (
                        <span key={r.label} className="flex items-center gap-2">
                          <Dot color={r.color} />
                          <span className="truncate">{r.label}</span>
                          <span className="ml-auto shrink-0 text-fg3">{formatFocusDuration(r.seconds)}</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </Panel>
            </div>
          </div>
        </QueryBoundary>
      </div>
    </div>
  );
}
