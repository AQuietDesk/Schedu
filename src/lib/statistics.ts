import { toDateKey } from "@/lib/calendarGrid";
import { daysUntil } from "@/lib/dates";
import type { FocusSession, Item } from "@/types";

// There's no dedicated `completed_at` column, so `updated_at` of a Completed
// item is used as its completion date throughout (same as before the redesign).

function cutoff(days: number, now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

export function completedInRange(items: Item[], days: number, now: Date = new Date()): Item[] {
  const from = cutoff(days, now);
  return items.filter((i) => i.status === "Completed" && new Date(i.updated_at) >= from);
}

export function missedDeadlines(items: Item[], now: Date = new Date()): number {
  return items.filter((i) => {
    const d = daysUntil(i.due_date, now);
    return d !== null && d < 0 && i.status !== "Completed";
  }).length;
}

/**
 * Share of items completed in the range that were finished on or before
 * their due date. Items with no due date count as on time.
 */
export function onTimeRate(items: Item[], days: number, now: Date = new Date()): number | null {
  const done = completedInRange(items, days, now);
  if (done.length === 0) return null;
  const onTime = done.filter((i) => !i.due_date || toDateKey(new Date(i.updated_at)) <= i.due_date).length;
  return onTime / done.length;
}

export function dailyCompletionTrend(items: Item[], days: number, now: Date = new Date()): { date: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.status !== "Completed") continue;
    const key = toDateKey(new Date(item.updated_at));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const start = cutoff(days, now);
  const result: { date: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = toDateKey(d);
    result.push({ date: key, count: counts.get(key) ?? 0 });
  }
  return result;
}

/**
 * Consecutive days, ending today, with any study activity — a completed
 * School item or a focus session tied to School. If today has nothing yet the
 * streak counts back from yesterday (there's still time left to extend it).
 */
export function studyStreak(items: Item[], sessions: FocusSession[], now: Date = new Date()): { current: number; best: number } {
  const days = new Set<string>();
  for (const i of items) if (i.category === "School" && i.status === "Completed") days.add(toDateKey(new Date(i.updated_at)));
  for (const s of sessions) if (s.category === "School" && (s.actual_duration_seconds ?? 0) > 0) days.add(toDateKey(new Date(s.started_at)));

  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (!days.has(toDateKey(day))) day.setDate(day.getDate() - 1);
  let current = 0;
  while (days.has(toDateKey(day))) {
    current += 1;
    day.setDate(day.getDate() - 1);
  }

  const sorted = Array.from(days).sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of sorted) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    run = prev && Math.round((date.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = date;
  }
  return { current, best: Math.max(best, current) };
}
