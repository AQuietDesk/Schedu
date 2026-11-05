// Local-calendar-day utilities for the Calendar page's grid. `due_date` is a
// plain "YYYY-MM-DD" string with no time zone of its own — it means that
// calendar day, full stop. Parsing it via `new Date(dueDate)` reads it as UTC
// midnight, which `.toLocaleDateString`/getters then re-express in local
// time, silently shifting it a day earlier for anyone west of UTC. Every date
// here is built from y/m/d components instead, so it's always local midnight
// on the intended day (mirrors CompletionHeatmap.tsx's toDateKey rationale,
// just parsing instead of formatting).

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDateOnly(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function isSameDay(a: Date, b: Date): boolean {
  return toDateKey(a) === toDateKey(b);
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

export function addMonths(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setMonth(copy.getMonth() + n);
  return copy;
}

// Sunday-based week start, matching CompletionHeatmap's convention elsewhere in the app.
export function startOfWeek(d: Date): Date {
  const copy = startOfDay(d);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
}

export function getWeekDays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Full weeks covering the month containing `anchor`, padded with the leading/trailing days of neighboring months so every row is a complete week. */
export function getMonthGrid(anchor: Date): Date[][] {
  const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lastOfMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const gridStart = startOfWeek(firstOfMonth);
  const gridEnd = addDays(startOfWeek(lastOfMonth), 6);
  const totalDays = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86_400_000) + 1;

  const days = Array.from({ length: totalDays }, (_, i) => addDays(gridStart, i));
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

export function formatMonthYear(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// The calendar month's own boundaries (1st–last day) — distinct from
// getMonthGrid's padded grid, which spills into neighboring months so every
// displayed row is a full week.
export function formatMonthRange(anchor: Date): string {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const startStr = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endStr = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}

export const WEEKDAY_SHORT_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Week view's hourly grid — fixed 6 AM–11 PM window (covers the vast
// majority of real events without needing a scrolling sub-container); an
// event outside this range gets clamped into it rather than clipped away
// entirely, so nothing silently disappears.
export const HOUR_GRID_START = 6;
export const HOUR_GRID_END = 23;
export const HOUR_ROW_HEIGHT = 56; // px

export function minutesFromTimeString(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// Inverse of minutesFromTimeString — wraps first, so a Day Ring block that
// was dragged past midnight (raw minutes >= 1440 or negative) still lands on
// a valid "HH:MM" for that block's actual clock time.
export function minutesToTimeString(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.round(wrapped % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatHourLabel(hour: number): string {
  const h = ((hour + 11) % 12) + 1; // 0->12, 13->1, etc.
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}
