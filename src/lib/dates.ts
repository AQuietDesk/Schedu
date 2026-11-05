import { parseDateOnly, startOfDay } from "@/lib/calendarGrid";

export function daysUntil(dueDate: string | null, now: Date = new Date()): number | null {
  if (!dueDate) return null;
  // `parseDateOnly` builds local midnight from the y/m/d components directly
  // — `new Date(dueDate)` parses the bare "YYYY-MM-DD" as UTC midnight, which
  // silently lands a day early once re-expressed in local time for anyone
  // west of UTC (see calendarGrid.ts's header comment for the full story).
  const today = startOfDay(now);
  const due = parseDateOnly(dueDate);
  return Math.round((due.getTime() - today.getTime()) / 86_400_000);
}
