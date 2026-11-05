// Pure decision engine for the in-app "Upcoming" notification layer (the
// launch-time notification center) — deliberately separate from
// notifications.rs's background OS-toast scheduler, which fires actual OS
// notifications on its own poll loop and is untouched by this file. This
// engine only answers "what should the notification center show right now,
// given the live items and what's already been shown", with no side effects
// of its own — callers (useUpcomingNotifications) own persisting the result.
import { parseDateOnly, toDateKey } from "@/lib/calendarGrid";
import { daysUntil } from "@/lib/dates";
import type { Item, Priority } from "@/types";

export type NotificationWindowDays = 0 | 1 | 3 | 5 | 7;

export interface UpcomingNotificationSettings {
  windowDays: NotificationWindowDays;
  priorityOverrideEnabled: boolean;
  repeatDailyEnabled: boolean;
}

export const UPCOMING_NOTIFICATION_DEFAULTS: UpcomingNotificationSettings = {
  windowDays: 7,
  priorityOverrideEnabled: true,
  repeatDailyEnabled: true,
};

export const NOTIFICATION_WINDOW_OPTIONS: { value: NotificationWindowDays; label: string }[] = [
  { value: 0, label: "Same day" },
  { value: 1, label: "1 day ahead" },
  { value: 3, label: "3 days ahead" },
  { value: 5, label: "5 days ahead" },
  { value: 7, label: "7 days ahead" },
];

// Priorities that extend past a shorter user-selected window (spec: "High
// and Critical items may override a shorter user-selected window"). Item's
// priority is only Low/Medium/High (see types/index.ts) — there's no
// separate Critical tier in this app's data model, so there's nothing to
// invent a score for; High alone carries the extended-lookahead behavior the
// spec describes for High/Critical.
const PRIORITY_MIN_WINDOW_DAYS: Partial<Record<Priority, number>> = { High: 5 };

export type Urgency = "overdue" | "today" | "tomorrow" | "soon" | "upcoming";

/** Per-item notification history, persisted by the caller (see useUpcomingNotifications). */
export interface ItemNotificationRecord {
  firstNotifiedAt: string;
  lastNotifiedAt: string;
  /** toDateKey(lastNotifiedAt) in local time — the daily-repeat dedup key. */
  lastNotifiedDay: string;
  dismissedAt: string | null;
  /** due_date+due_time at the time this was recorded; a reschedule invalidates history. */
  dueKey: string;
}

export type NotificationState = Record<string, ItemNotificationRecord>;

export interface NotificationCandidate {
  item: Item;
  days: number;
  urgency: Urgency;
  kind: string;
}

export interface EvaluateResult {
  candidates: NotificationCandidate[];
  nextState: NotificationState;
}

function dueKeyFor(item: Item): string {
  return `${item.due_date ?? ""}T${item.due_time ?? ""}`;
}

function effectiveWindowDays(priority: Priority, settings: UpcomingNotificationSettings): number {
  const minWindow = settings.priorityOverrideEnabled ? PRIORITY_MIN_WINDOW_DAYS[priority] : undefined;
  return minWindow != null ? Math.max(settings.windowDays, minWindow) : settings.windowDays;
}

export function urgencyForDays(days: number): Urgency {
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 3) return "soon";
  return "upcoming";
}

// Completion is read live off the item on every evaluation, never cached —
// so marking an item Completed removes it from consideration the very next
// time this runs, and un-completing it makes it eligible again exactly like
// any other incomplete item. The item table is the only source of truth for
// this; the engine keeps no notion of "done" of its own. This app's Item
// model has no separate cancelled state (see types/index.ts), so due_date +
// status is the complete eligibility check.
function isNotifiable(item: Item): boolean {
  return item.due_date != null && item.status !== "Completed";
}

function shouldNotify(
  priority: Priority,
  record: ItemNotificationRecord | undefined,
  dueKey: string,
  todayKey: string,
  settings: UpcomingNotificationSettings,
): boolean {
  if (!record || record.dueKey !== dueKey) return true; // never notified, or rescheduled since
  if (priority === "Low") return false; // Low: once per item+due date, ever
  if (priority === "High" && !settings.repeatDailyEnabled) return false; // repeat off: once ever
  return record.lastNotifiedDay !== todayKey; // Medium, and High with repeat on: once per day
}

function priorityRank(priority: Priority): number {
  return priority === "High" ? 0 : priority === "Medium" ? 1 : 2;
}

function urgencyRank(urgency: Urgency): number {
  switch (urgency) {
    case "overdue":
      return 0;
    case "today":
      return 1;
    case "tomorrow":
      return 2;
    case "soon":
      return 3;
    default:
      return 4;
  }
}

/** Short type label for a notification card — mirrors how MasterList/AssignmentsTab already distinguish these (assignment_type, google_calendar_id). */
export function notificationItemKind(item: Item): string {
  if (item.assignment_type) return item.assignment_type;
  if (item.google_calendar_id) return "Calendar event";
  return "Deadline";
}

export function relativeDueLabel(item: Item, days: number): string {
  if (days < 0) return "Overdue";
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days <= 6 && item.due_date) {
    return `Due ${parseDateOnly(item.due_date).toLocaleDateString(undefined, { weekday: "long" })}`;
  }
  return `Due in ${days} days`;
}

/**
 * Given the live items, prior notification state, and current settings,
 * decides which items the notification center should show right now and
 * what the persisted state should become afterward. Called once when the
 * center is about to be shown (see useUpcomingNotifications) — evaluating
 * it doesn't itself mark anything as notified until the caller persists
 * `nextState`.
 */
export function evaluateNotifications(
  items: Item[],
  state: NotificationState,
  settings: UpcomingNotificationSettings,
  now: Date,
): EvaluateResult {
  const todayKey = toDateKey(now);
  const liveIds = new Set(items.map((i) => i.id));

  // Drop records for items that no longer exist (deleted), so persisted
  // state doesn't grow without bound.
  const nextState: NotificationState = {};
  for (const [id, record] of Object.entries(state)) {
    if (liveIds.has(id)) nextState[id] = record;
  }

  const candidates: NotificationCandidate[] = [];

  for (const item of items) {
    if (!isNotifiable(item)) continue;
    const days = daysUntil(item.due_date, now);
    if (days === null) continue;

    const windowDays = effectiveWindowDays(item.priority, settings);
    if (days > windowDays) continue;

    const dueKey = dueKeyFor(item);
    const existing = state[item.id];
    if (!shouldNotify(item.priority, existing, dueKey, todayKey, settings)) continue;

    candidates.push({ item, days, urgency: urgencyForDays(days), kind: notificationItemKind(item) });

    const sameSchedule = existing?.dueKey === dueKey;
    nextState[item.id] = {
      firstNotifiedAt: sameSchedule ? existing!.firstNotifiedAt : now.toISOString(),
      lastNotifiedAt: now.toISOString(),
      lastNotifiedDay: todayKey,
      dismissedAt: sameSchedule ? existing!.dismissedAt : null,
      dueKey,
    };
  }

  candidates.sort((a, b) => {
    const byUrgency = urgencyRank(a.urgency) - urgencyRank(b.urgency);
    if (byUrgency !== 0) return byUrgency;
    const byPriority = priorityRank(a.item.priority) - priorityRank(b.item.priority);
    if (byPriority !== 0) return byPriority;
    return a.days - b.days;
  });

  return { candidates, nextState };
}

export interface NotificationSummary {
  total: number;
  overdue: number;
  highPriority: number;
  events: number;
}

export function summarizeCandidates(candidates: NotificationCandidate[]): NotificationSummary {
  let overdue = 0;
  let highPriority = 0;
  let events = 0;
  for (const c of candidates) {
    if (c.urgency === "overdue") overdue++;
    else if (c.item.priority === "High") highPriority++;
    if (c.item.google_calendar_id) events++;
  }
  return { total: candidates.length, overdue, highPriority, events };
}
