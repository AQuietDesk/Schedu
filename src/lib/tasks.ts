import { parseDateOnly } from "@/lib/calendarGrid";
import { daysUntil } from "@/lib/dates";
import type { Item, ItemStatus, Priority } from "@/types";

export const PRIORITY_ORDER: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };

export function isDone(item: Item): boolean {
  return item.status === "Completed";
}

/** Due date, then time (untimed last within a day), then priority, then title. */
export function compareByDue(a: Item, b: Item): number {
  const ad = a.due_date ?? "9999-99-99";
  const bd = b.due_date ?? "9999-99-99";
  if (ad !== bd) return ad < bd ? -1 : 1;
  const at = a.due_time ?? "99:99";
  const bt = b.due_time ?? "99:99";
  if (at !== bt) return at < bt ? -1 : 1;
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  return p !== 0 ? p : a.title.localeCompare(b.title, undefined, { numeric: true });
}

export type DueBucket = "overdue" | "today" | "tomorrow" | "week" | "later" | "none";

export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
  none: "No date",
};

export function dueBucket(item: Item, now: Date = new Date()): DueBucket {
  const days = daysUntil(item.due_date, now);
  if (days === null) return "none";
  if (days < 0) return isDone(item) ? "today" : "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 7) return "week";
  return "later";
}

export function groupByBucket(items: Item[], now: Date = new Date()): { bucket: DueBucket; items: Item[] }[] {
  const order: DueBucket[] = ["overdue", "today", "tomorrow", "week", "later", "none"];
  const map = new Map<DueBucket, Item[]>();
  for (const item of [...items].sort(compareByDue)) {
    const b = dueBucket(item, now);
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(item);
  }
  return order.filter((b) => map.has(b)).map((bucket) => ({ bucket, items: map.get(bucket)! }));
}

/** Today's list: anything overdue and open, plus everything due today (done included, sorted last). */
export function todayItems(items: Item[], now: Date = new Date()): Item[] {
  return items
    .filter((i) => {
      const days = daysUntil(i.due_date, now);
      return days !== null && (days === 0 || (days < 0 && !isDone(i)));
    })
    .sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || compareByDue(a, b));
}

/** Open items due in the next `days` days (tomorrow onward), grouped by date. */
export function comingUp(items: Item[], days = 7, now: Date = new Date()): { date: string; items: Item[] }[] {
  const map = new Map<string, Item[]>();
  for (const item of [...items].sort(compareByDue)) {
    if (isDone(item) || !item.due_date) continue;
    const d = daysUntil(item.due_date, now);
    if (d === null || d < 1 || d > days) continue;
    if (!map.has(item.due_date)) map.set(item.due_date, []);
    map.get(item.due_date)!.push(item);
  }
  return Array.from(map.entries()).map(([date, list]) => ({ date, items: list }));
}

export function formatTime(time: string | null): string {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Short relative due label: "Yesterday", "Today", "Tomorrow", "Thu", "Nov 2". */
export function formatDue(item: Pick<Item, "due_date" | "due_time">, now: Date = new Date(), withTime = false): string {
  if (!item.due_date) return "";
  const days = daysUntil(item.due_date, now)!;
  const date = parseDateOnly(item.due_date);
  let label: string;
  if (days === -1) label = "Yesterday";
  else if (days === 0) label = "Today";
  else if (days === 1) label = "Tomorrow";
  else if (days > 1 && days < 7) label = date.toLocaleDateString(undefined, { weekday: "short" });
  else label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (withTime && item.due_time) label += ` ${formatTime(item.due_time)}`;
  return label;
}

export function nextStatus(status: ItemStatus): ItemStatus {
  // The checkbox toggles done/not-done. "In Progress" is set explicitly from
  // the task peek, and completing an in-progress task works the same way.
  return status === "Completed" ? "Not Started" : "Completed";
}

export function formatMinutes(mins: number | null): string {
  if (!mins) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
