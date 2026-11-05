import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { Dot, Segmented, TopBar } from "@/components/lo/primitives";
import { useContexts } from "@/hooks/useContexts";
import { useCalendarEventsInRangeForCalendars, useCalendarList, useGoogleConnected } from "@/hooks/useGoogle";
import { useItems, useUpdateItem } from "@/hooks/useItems";
import { useNowTick } from "@/hooks/useNowTick";
import { usePreferences, useSetPreference } from "@/hooks/usePreferences";
import { contextsMap, itemContextInfo } from "@/lib/areas";
import {
  addDays,
  addMonths,
  formatHourLabel,
  formatMonthYear,
  getMonthGrid,
  getWeekDays,
  HOUR_GRID_END,
  HOUR_GRID_START,
  HOUR_ROW_HEIGHT,
  isSameDay,
  minutesFromTimeString,
  minutesToTimeString,
  parseDateOnly,
  toDateKey,
  WEEKDAY_SHORT_LABELS,
} from "@/lib/calendarGrid";
import { tint } from "@/lib/classColors";
import { googleEventColor } from "@/lib/googleEventColors";
import {
  parseSelectedCalendarIds,
  resolveCalendarIdsToQuery,
  SELECTED_CALENDARS_PREF_KEY,
} from "@/lib/googleCalendarSelection";
import { compareByDue, formatMinutes, isDone } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { usePeekStore } from "@/store/peekStore";
import type { Context, GoogleCalendarEvent, Item } from "@/types";

type ViewMode = "week" | "month";
const DEFAULT_DURATION_MINUTES = 60;
const DRAG_MIME = "application/x-life-os-item";
const NEUTRAL = "#8e8e8a";

// A day cell mixes local Items (by due_date) with Google Calendar events
// fetched live for the visible range — from the primary calendar and any
// other calendars ticked in the side panel.
interface DayEntry {
  key: string;
  title: string;
  time: string | null; // "HH:MM", or null for all-day
  durationMinutes: number;
  color: string;
  item: Item | null;
}

function googleEventDateKey(event: GoogleCalendarEvent): string | null {
  const start = event.start;
  if (!start) return null;
  if (start.date) return start.date;
  if (start.dateTime) return toDateKey(new Date(start.dateTime));
  return null;
}

function googleEventTime(event: GoogleCalendarEvent): string | null {
  if (!event.start?.dateTime) return null;
  const d = new Date(event.start.dateTime);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function googleEventDurationMinutes(event: GoogleCalendarEvent): number {
  if (!event.start?.dateTime || !event.end?.dateTime) return DEFAULT_DURATION_MINUTES;
  const minutes = Math.round((new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()) / 60_000);
  return minutes > 0 ? minutes : DEFAULT_DURATION_MINUTES;
}

function sortForDay(entries: DayEntry[]): DayEntry[] {
  return [...entries].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return -1;
    if (!b.time) return 1;
    return a.time.localeCompare(b.time);
  });
}

function entryStyle(entry: DayEntry): CSSProperties {
  return { background: tint(entry.color, 0.16) };
}

function onDragStartItem(e: DragEvent, itemId: string) {
  e.dataTransfer.setData(DRAG_MIME, itemId);
  e.dataTransfer.effectAllowed = "move";
}

function EntryPill({ entry }: { entry: DayEntry }) {
  const openPeek = usePeekStore((s) => s.open);
  const done = entry.item && isDone(entry.item);
  const className = cn(
    "block w-full truncate rounded-md px-1.5 py-0.5 text-left text-xs font-medium",
    done && "text-fg3 line-through",
  );
  const inner = (
    <>
      {entry.time && <span className="mr-1 font-mono text-[11px] text-fg2">{entry.time}</span>}
      {entry.title}
    </>
  );
  if (!entry.item) {
    return (
      <div className={className} style={entryStyle(entry)} title={`${entry.title} (Google Calendar)`}>
        {inner}
      </div>
    );
  }
  const item = entry.item;
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => onDragStartItem(e, item.id)}
      onClick={() => openPeek(item.id)}
      className={className}
      style={entryStyle(entry)}
    >
      {inner}
    </button>
  );
}

const MONTH_CELL_LIMIT = 3;

function MonthGrid({ anchor, entriesByDay, onDropOnDay }: { anchor: Date; entriesByDay: Map<string, DayEntry[]>; onDropOnDay: (dayKey: string, itemId: string, minutes: number | null) => void }) {
  const weeks = useMemo(() => getMonthGrid(anchor), [anchor]);
  const today = new Date();
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="grid grid-cols-7 border-b border-line">
        {WEEKDAY_SHORT_LABELS.map((label) => (
          <div key={label} className="px-2 py-2 text-xs text-fg3">
            {label}
          </div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="grid grid-cols-7">
          {week.map((day) => {
            const key = toDateKey(day);
            const dayEntries = sortForDay(entriesByDay.get(key) ?? []);
            const inMonth = day.getMonth() === anchor.getMonth();
            const isToday = isSameDay(day, today);
            return (
              <div
                key={key}
                onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData(DRAG_MIME);
                  if (id) onDropOnDay(key, id, null);
                }}
                className={cn("min-h-28 border-b border-r border-line p-1.5 [&:nth-child(7n)]:border-r-0", !inMonth && "bg-sidebar")}
              >
                <div
                  className={cn(
                    "mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs",
                    isToday && "bg-danger font-semibold text-white",
                    !inMonth && !isToday && "text-fg3",
                  )}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayEntries.slice(0, MONTH_CELL_LIMIT).map((entry) => (
                    <EntryPill key={entry.key} entry={entry} />
                  ))}
                  {dayEntries.length > MONTH_CELL_LIMIT && <p className="px-1 text-xs text-fg3">+{dayEntries.length - MONTH_CELL_LIMIT} more</p>}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface PositionedEntry {
  entry: DayEntry;
  top: number;
  height: number;
  column: number;
  columnCount: number;
}

// Greedy interval-partitioning so simultaneous events get side-by-side lanes.
function layoutColumns(entries: DayEntry[]): PositionedEntry[] {
  const withRange = entries
    .filter((e): e is DayEntry & { time: string } => e.time !== null)
    .map((e) => ({ entry: e, start: minutesFromTimeString(e.time), end: minutesFromTimeString(e.time) + e.durationMinutes }))
    .sort((a, b) => a.start - b.start);

  const columnEnds: number[] = [];
  const placed: { entry: DayEntry; start: number; end: number; column: number }[] = [];
  for (const item of withRange) {
    let column = columnEnds.findIndex((end) => end <= item.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.end);
    } else {
      columnEnds[column] = item.end;
    }
    placed.push({ ...item, column });
  }

  const columnCount = Math.max(1, columnEnds.length);
  const gridStart = HOUR_GRID_START * 60;
  const gridEnd = HOUR_GRID_END * 60;
  return placed.map((p) => {
    const clampedStart = Math.min(Math.max(p.start, gridStart), gridEnd);
    const clampedEnd = Math.min(Math.max(p.end, clampedStart + 20), gridEnd);
    const top = ((clampedStart - gridStart) / 60) * HOUR_ROW_HEIGHT;
    const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_ROW_HEIGHT, 22);
    return { entry: p.entry, top, height, column: p.column, columnCount };
  });
}

function HourEventBlock({ positioned }: { positioned: PositionedEntry }) {
  const openPeek = usePeekStore((s) => s.open);
  const { entry, top, height, column, columnCount } = positioned;
  const widthPct = 100 / columnCount;
  const done = entry.item && isDone(entry.item);
  const style: CSSProperties = { top, height, left: `calc(${column * widthPct}% + 3px)`, width: `calc(${widthPct}% - 6px)`, ...entryStyle(entry) };
  const body = (
    <>
      <p className={cn("truncate font-semibold", done && "text-fg3 line-through")}>{entry.title}</p>
      {height > 34 && entry.time && <p className="truncate text-fg2">{entry.time}</p>}
    </>
  );
  const className = "absolute overflow-hidden rounded-lg px-2 py-1 text-left text-xs leading-snug";
  if (!entry.item) {
    return (
      <div title={entry.title} style={style} className={className}>
        {body}
      </div>
    );
  }
  const item = entry.item;
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => onDragStartItem(e, item.id)}
      onClick={() => openPeek(item.id)}
      style={style}
      className={cn(className, "cursor-grab active:cursor-grabbing")}
    >
      {body}
    </button>
  );
}

const HOURS = Array.from({ length: HOUR_GRID_END - HOUR_GRID_START }, (_, i) => HOUR_GRID_START + i);

function WeekHourGrid({
  anchor,
  entriesByDay,
  onDropOnDay,
}: {
  anchor: Date;
  entriesByDay: Map<string, DayEntry[]>;
  onDropOnDay: (dayKey: string, itemId: string, minutes: number | null) => void;
}) {
  const days = useMemo(() => getWeekDays(anchor), [anchor]);
  const now = useNowTick();
  const gridHeight = HOURS.length * HOUR_ROW_HEIGHT;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMinutes - HOUR_GRID_START * 60) / 60) * HOUR_ROW_HEIGHT;
  const nowInGrid = nowMinutes >= HOUR_GRID_START * 60 && nowMinutes <= HOUR_GRID_END * 60;
  const [dropHint, setDropHint] = useState<{ key: string; top: number } | null>(null);

  const dayData = useMemo(
    () =>
      days.map((day) => {
        const key = toDateKey(day);
        const all = entriesByDay.get(key) ?? [];
        return { day, key, allDay: all.filter((e) => e.time === null), timed: layoutColumns(all) };
      }),
    [days, entriesByDay],
  );

  const minutesAt = (e: DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = HOUR_GRID_START * 60 + ((e.clientY - rect.top) / HOUR_ROW_HEIGHT) * 60;
    return Math.min(Math.max(Math.round(raw / 15) * 15, HOUR_GRID_START * 60), HOUR_GRID_END * 60 - 15);
  };

  return (
    <div className="min-w-[680px]">
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-line">
        <div />
        {dayData.map(({ day, key }) => {
          const isToday = isSameDay(day, now);
          return (
            <div key={key} className="flex items-baseline gap-1.5 px-2.5 pb-2.5 pt-3">
              <span className={cn("text-xs", isToday ? "font-medium text-danger" : "text-fg3")}>
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </span>
              <span
                className={cn(
                  "text-lg font-medium",
                  isToday && "inline-flex size-[30px] items-center justify-center rounded-full bg-danger font-semibold text-white",
                )}
              >
                {day.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-line">
        <div className="px-1.5 py-2 text-right text-[11px] text-fg3">all-day</div>
        {dayData.map(({ key, allDay }) => (
          <div
            key={key}
            onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) onDropOnDay(key, id, null);
            }}
            className="min-h-9 space-y-0.5 border-l border-line p-1"
          >
            {allDay.map((entry) => (
              <EntryPill key={entry.key} entry={entry} />
            ))}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]">
        <div className="relative font-mono text-[11px] text-fg3" style={{ height: gridHeight }}>
          {HOURS.map((hour, i) => (
            <span key={hour} className="absolute right-2 -translate-y-1/2" style={{ top: i * HOUR_ROW_HEIGHT }}>
              {i === 0 ? "" : formatHourLabel(hour)}
            </span>
          ))}
        </div>
        {dayData.map(({ day, key, timed }) => (
          <div
            key={key}
            className={cn("relative border-l border-line", isSameDay(day, now) && "bg-sidebar")}
            style={{
              height: gridHeight,
              backgroundImage: "linear-gradient(var(--border) 1px, transparent 1px)",
              backgroundSize: `100% ${HOUR_ROW_HEIGHT}px`,
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              const m = minutesAt(e);
              setDropHint({ key, top: ((m - HOUR_GRID_START * 60) / 60) * HOUR_ROW_HEIGHT });
            }}
            onDragLeave={() => setDropHint(null)}
            onDrop={(e) => {
              setDropHint(null);
              const id = e.dataTransfer.getData(DRAG_MIME);
              if (id) onDropOnDay(key, id, minutesAt(e));
            }}
          >
            {timed.map((positioned) => (
              <HourEventBlock key={positioned.entry.key} positioned={positioned} />
            ))}
            {dropHint?.key === key && (
              <div
                className="pointer-events-none absolute inset-x-1 rounded-lg border-[1.5px] border-dashed border-brand bg-brand-soft/60"
                style={{ top: dropHint.top, height: HOUR_ROW_HEIGHT }}
              />
            )}
            {nowInGrid && isSameDay(day, now) && (
              <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }}>
                <span className="-ml-[5px] size-2.5 shrink-0 rounded-full bg-danger" />
                <div className="h-0.5 flex-1 bg-danger" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniMonth({ anchor, onPick }: { anchor: Date; onPick: (d: Date) => void }) {
  const weeks = useMemo(() => getMonthGrid(anchor), [anchor]);
  const weekKeys = new Set(getWeekDays(anchor).map(toDateKey));
  const today = new Date();
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-sm font-semibold">{anchor.toLocaleDateString(undefined, { month: "long" })}</span>
      <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs">
        {WEEKDAY_SHORT_LABELS.map((l) => (
          <span key={l} className="py-1 text-fg3">
            {l[0]}
          </span>
        ))}
        {weeks.flat().map((day) => {
          const key = toDateKey(day);
          const isToday = isSameDay(day, today);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPick(day)}
              className={cn(
                "py-1.5",
                weekKeys.has(key) && "bg-sunken",
                isToday && "rounded-md bg-danger font-semibold text-white",
                day.getMonth() !== anchor.getMonth() && "text-fg3",
                !isToday && "hover:text-brand",
              )}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UnscheduledList({ items, contextsById }: { items: Item[]; contextsById: Map<string, Context> }) {
  const openPeek = usePeekStore((s) => s.open);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">Not scheduled</span>
      <span className="text-[12.5px] leading-snug text-fg3">Drag a task onto the week to block time for it.</span>
      {items.length === 0 && <span className="text-[13px] text-fg3">Everything open has a time.</span>}
      {items.slice(0, 10).map((item) => {
        const info = itemContextInfo(item, contextsById);
        return (
          <button
            key={item.id}
            type="button"
            draggable
            onDragStart={(e) => onDragStartItem(e, item.id)}
            onClick={() => openPeek(item.id)}
            className="group flex min-h-10 cursor-grab items-center gap-2.5 rounded-[10px] border border-line bg-card px-2.5 text-left text-[13.5px] hover:border-line2 active:cursor-grabbing"
          >
            <GripVertical className="-ml-1 size-3.5 shrink-0 text-fg3 opacity-0 group-hover:opacity-100" />
            <Dot color={info.color} />
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            {item.estimated_duration ? <span className="shrink-0 text-xs text-fg3">{formatMinutes(item.estimated_duration)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export default function CalendarPage() {
  const [params] = useSearchParams();
  const { data: items } = useItems();
  const { data: contexts } = useContexts();
  const updateItem = useUpdateItem();
  const { data: connected } = useGoogleConnected();
  const { data: calendars, isError: calendarListError } = useCalendarList(!!connected);
  const { data: prefs } = usePreferences();
  const setPreference = useSetPreference();
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [showTasks, setShowTasks] = useState(true);
  const [anchor, setAnchor] = useState(() => {
    const date = params.get("date");
    return date ? parseDateOnly(date) : new Date();
  });

  useEffect(() => {
    const date = params.get("date");
    if (date) setAnchor(parseDateOnly(date));
  }, [params]);

  const byId = useMemo(() => contextsMap(contexts), [contexts]);
  const weeks = useMemo(() => getMonthGrid(anchor), [anchor]);
  const weekDays = useMemo(() => getWeekDays(anchor), [anchor]);
  const rangeStart = viewMode === "month" ? weeks[0][0] : weekDays[0];
  const rangeEnd = viewMode === "month" ? weeks[weeks.length - 1][6] : weekDays[6];
  const timeMin = rangeStart.toISOString();
  const timeMax = addDays(rangeEnd, 1).toISOString();

  const selectedCalendarIds = useMemo(() => parseSelectedCalendarIds(prefs?.[SELECTED_CALENDARS_PREF_KEY]), [prefs]);
  const calendarIdsToQuery = useMemo(
    () => resolveCalendarIdsToQuery(!!connected, calendars, selectedCalendarIds),
    [connected, calendars, selectedCalendarIds],
  );
  const colorByCalendarId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const cal of calendars ?? []) map.set(cal.id, cal.background_color ?? null);
    return map;
  }, [calendars]);

  const eventQueries = useCalendarEventsInRangeForCalendars(calendarIdsToQuery, timeMin, timeMax, !!connected);
  const eventsQueryError = eventQueries.find((q) => q.isError)?.error;

  // Items already pushed to Google come back in the range fetch as the same event — skip those.
  const knownGoogleCalendarIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of items ?? []) if (item.google_calendar_id) set.add(item.google_calendar_id);
    return set;
  }, [items]);

  const eventsKey = eventQueries.map((q) => q.dataUpdatedAt).join(",");
  const entriesByDay = useMemo(() => {
    const map = new Map<string, DayEntry[]>();
    const push = (key: string, entry: DayEntry) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    };
    if (showTasks) {
      for (const item of items ?? []) {
        if (!item.due_date) continue;
        push(toDateKey(parseDateOnly(item.due_date)), {
          key: `item-${item.id}`,
          title: item.title,
          time: item.due_time,
          durationMinutes: item.estimated_duration ?? DEFAULT_DURATION_MINUTES,
          color: itemContextInfo(item, byId).color,
          item,
        });
      }
    }
    eventQueries.forEach((query, i) => {
      const calendarId = calendarIdsToQuery[i];
      const calColor = colorByCalendarId.get(calendarId) ?? null;
      for (const event of (query.data as GoogleCalendarEvent[] | undefined) ?? []) {
        if (event.status === "cancelled" || knownGoogleCalendarIds.has(event.id)) continue;
        const key = googleEventDateKey(event);
        if (!key) continue;
        push(key, {
          key: `gcal-${calendarId}-${event.id}`,
          title: event.summary ?? "(untitled)",
          time: googleEventTime(event),
          durationMinutes: googleEventDurationMinutes(event),
          color: googleEventColor(event.color_id, calColor) ?? NEUTRAL,
          item: null,
        });
      }
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, eventsKey, calendarIdsToQuery, colorByCalendarId, knownGoogleCalendarIds, showTasks, byId]);

  const unscheduled = useMemo(
    () => (items ?? []).filter((i) => !isDone(i) && !i.due_time).sort(compareByDue),
    [items],
  );

  const onDropOnDay = (dayKey: string, itemId: string, minutes: number | null) => {
    const item = items?.find((i) => i.id === itemId);
    if (!item) return;
    updateItem.mutate({
      ...item,
      due_date: dayKey,
      due_time: minutes === null ? item.due_time : minutesToTimeString(minutes),
      estimated_duration: item.estimated_duration ?? (minutes === null ? null : DEFAULT_DURATION_MINUTES),
    });
  };

  const toggleCalendar = (id: string) => {
    const next = selectedCalendarIds.includes(id) ? selectedCalendarIds.filter((x) => x !== id) : [...selectedCalendarIds, id];
    setPreference.mutate({ key: SELECTED_CALENDARS_PREF_KEY, value: JSON.stringify(next) });
  };

  const goPrev = () => setAnchor((a) => (viewMode === "month" ? addMonths(a, -1) : addDays(a, -7)));
  const goNext = () => setAnchor((a) => (viewMode === "month" ? addMonths(a, 1) : addDays(a, 7)));

  return (
    <div className="flex min-h-full flex-col">
      <TopBar
        actions={
          <Segmented<ViewMode>
            label="Calendar view"
            size="sm"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ]}
          />
        }
      >
        <h1 className="mr-2 text-[22px] font-semibold tracking-[-0.02em] text-foreground">{formatMonthYear(anchor)}</h1>
        <button type="button" aria-label="Previous" onClick={goPrev} className="flex size-8 items-center justify-center rounded-lg hover:bg-hover">
          <ChevronLeft className="size-4" />
        </button>
        <button type="button" onClick={() => setAnchor(new Date())} className="h-8 rounded-lg border border-line2 px-3 text-[13px] text-foreground hover:bg-hover">
          Today
        </button>
        <button type="button" aria-label="Next" onClick={goNext} className="flex size-8 items-center justify-center rounded-lg hover:bg-hover">
          <ChevronRight className="size-4" />
        </button>
      </TopBar>

      {connected && (calendarListError || eventsQueryError) && (
        <p className="border-b border-line bg-danger-soft px-7 py-2 text-[13px] text-danger">
          {calendarListError
            ? "Couldn’t load your Google calendar list, so only your primary calendar is shown. Try reconnecting Google in "
            : `Couldn’t load Google events for this range: ${String(eventsQueryError)}. `}
          {calendarListError && (
            <Link to="/settings?section=google" className="underline">
              Settings
            </Link>
          )}
        </p>
      )}

      <div className="flex flex-1 flex-wrap items-stretch">
        <div className="min-w-0 flex-[999_1_600px] overflow-x-auto pb-6">
          {viewMode === "week" ? (
            <WeekHourGrid anchor={anchor} entriesByDay={entriesByDay} onDropOnDay={onDropOnDay} />
          ) : (
            <div className="p-5">
              <MonthGrid anchor={anchor} entriesByDay={entriesByDay} onDropOnDay={onDropOnDay} />
            </div>
          )}
        </div>

        <aside className="flex min-w-0 max-w-[320px] flex-[1_1_260px] flex-col gap-7 border-l border-line px-5 py-5">
          <MiniMonth anchor={anchor} onPick={setAnchor} />
          <UnscheduledList items={unscheduled} contextsById={byId} />
          <div className="flex flex-col gap-1 text-[13.5px]">
            <span className="mb-1 text-sm font-semibold">Show</span>
            <label className="flex min-h-8 items-center gap-2.5">
              <input type="checkbox" checked={showTasks} onChange={(e) => setShowTasks(e.target.checked)} className="size-4 accent-[var(--brand)]" />
              Schedu tasks
            </label>
            {connected ? (
              (calendars ?? []).map((cal) => (
                <label key={cal.id} className="flex min-h-8 items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={!!cal.primary || selectedCalendarIds.includes(cal.id)}
                    disabled={!!cal.primary}
                    onChange={() => toggleCalendar(cal.id)}
                    className="size-4 accent-[var(--brand)]"
                  />
                  <Dot color={cal.background_color ?? NEUTRAL} square={false} />
                  <span className="truncate">{cal.summary ?? cal.id}</span>
                </label>
              ))
            ) : (
              <Link to="/settings?section=google" className="text-[13px] text-fg3 hover:text-fg2">
                Connect Google Calendar →
              </Link>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
