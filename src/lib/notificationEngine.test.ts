import { describe, expect, it } from "vitest";
import { addDays, toDateKey } from "@/lib/calendarGrid";
import {
  evaluateNotifications,
  notificationItemKind,
  relativeDueLabel,
  summarizeCandidates,
  UPCOMING_NOTIFICATION_DEFAULTS,
  type ItemNotificationRecord,
  type NotificationState,
  type UpcomingNotificationSettings,
} from "@/lib/notificationEngine";
import type { Item } from "@/types";

const NOW = new Date(2026, 8, 16, 10, 0, 0); // Wed 2026-09-16, 10:00 local

function dueIn(days: number, base: Date = NOW): string {
  return toDateKey(addDays(base, days));
}

let nextId = 0;
function makeItem(overrides: Partial<Item> = {}): Item {
  nextId += 1;
  return {
    id: `item-${nextId}`,
    title: `Item ${nextId}`,
    description: null,
    category: "School",
    subcategory_id: null,
    subcategory_text: null,
    due_date: dueIn(3),
    due_time: null,
    estimated_duration: null,
    priority: "Medium",
    status: "Not Started",
    repeat_settings: null,
    color: null,
    notes: null,
    tags: null,
    attachments: null,
    location: null,
    google_calendar_id: null,
    google_task_id: null,
    last_synced_at_calendar: null,
    last_synced_at_tasks: null,
    last_sync_error: null,
    last_sync_attempted_at: null,
    sync_failure_count: 0,
    assignment_type: null,
    points_earned: null,
    points_possible: null,
    obsidian_source_id: null,
    obsidian_vault_path: null,
    obsidian_source_folder: null,
    obsidian_source_file: null,
    obsidian_source_section: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

const DEFAULT_SETTINGS: UpcomingNotificationSettings = UPCOMING_NOTIFICATION_DEFAULTS;

function settings(overrides: Partial<UpcomingNotificationSettings>): UpcomingNotificationSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("evaluateNotifications", () => {
  it("1. excludes an item outside the notification window", () => {
    const item = makeItem({ priority: "Medium", due_date: dueIn(10) });
    const { candidates } = evaluateNotifications([item], {}, settings({ windowDays: 7 }), NOW);
    expect(candidates).toHaveLength(0);
  });

  it("2. includes an item inside the notification window", () => {
    const item = makeItem({ priority: "Medium", due_date: dueIn(5) });
    const { candidates } = evaluateNotifications([item], {}, settings({ windowDays: 7 }), NOW);
    expect(candidates.map((c) => c.item.id)).toEqual([item.id]);
  });

  it("3. excludes a completed item regardless of due date or priority", () => {
    const item = makeItem({ priority: "High", status: "Completed", due_date: dueIn(1) });
    const { candidates } = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(candidates).toHaveLength(0);
  });

  it("4. excludes items with no due date (the shape a cancelled/non-actionable item takes here)", () => {
    // This app's Item model has no separate "cancelled" status (see
    // types/index.ts) — a cancelled Google Calendar event never becomes an
    // Item row in the first place (google/sync.rs skips status === "cancelled"
    // during sync), so due_date presence is the only relevant gate here.
    const item = makeItem({ due_date: null });
    const { candidates } = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(candidates).toHaveLength(0);
  });

  it("5. a High priority item notifies outside the user's shorter selected window", () => {
    const item = makeItem({ priority: "High", due_date: dueIn(5) });
    const { candidates } = evaluateNotifications(
      [item],
      {},
      settings({ windowDays: 3, priorityOverrideEnabled: true }),
      NOW,
    );
    expect(candidates.map((c) => c.item.id)).toEqual([item.id]);
  });

  it("6. priority override is what extends the window — disabling it removes the extension (this app has no separate Critical tier; High is the top tier and carries the spec's High/Critical override behavior, see notificationEngine.ts)", () => {
    const item = makeItem({ priority: "High", due_date: dueIn(6) });
    const withOverride = evaluateNotifications(
      [item],
      {},
      settings({ windowDays: 3, priorityOverrideEnabled: true }),
      NOW,
    );
    const withoutOverride = evaluateNotifications(
      [item],
      {},
      settings({ windowDays: 3, priorityOverrideEnabled: false }),
      NOW,
    );
    expect(withoutOverride.candidates).toHaveLength(0);
    expect(withOverride.candidates).toHaveLength(0); // 6 days still exceeds High's 5-day extension
  });

  it("7. an already-notified item does not notify again the same day", () => {
    const item = makeItem({ priority: "Medium", due_date: dueIn(5) });
    const first = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(first.candidates).toHaveLength(1);

    const second = evaluateNotifications([item], first.nextState, DEFAULT_SETTINGS, NOW);
    expect(second.candidates).toHaveLength(0);
  });

  it("8. a Medium/High item notifies again once a new day has passed", () => {
    const item = makeItem({ priority: "High", due_date: dueIn(5) });
    const day1 = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(day1.candidates).toHaveLength(1);

    const nextDay = addDays(NOW, 1);
    const day2 = evaluateNotifications([item], day1.nextState, DEFAULT_SETTINGS, nextDay);
    expect(day2.candidates).toHaveLength(1);
  });

  it("9. a same-day deadline gets 'today' urgency", () => {
    const item = makeItem({ due_date: dueIn(0) });
    const { candidates } = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(candidates[0].urgency).toBe("today");
    expect(relativeDueLabel(item, candidates[0].days)).toBe("Due today");
  });

  it("10. an overdue item gets flagged overdue regardless of the window", () => {
    const item = makeItem({ due_date: dueIn(-2), priority: "Low" });
    const { candidates } = evaluateNotifications([item], {}, settings({ windowDays: 0 }), NOW);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].urgency).toBe("overdue");
    expect(relativeDueLabel(item, candidates[0].days)).toBe("Overdue");
  });

  it("11. multiple candidates sort by urgency, then priority, then proximity", () => {
    const overdueHigh = makeItem({ priority: "High", due_date: dueIn(-1) });
    const dueTodayMedium = makeItem({ priority: "Medium", due_date: dueIn(0) });
    const dueSoonLow = makeItem({ priority: "Low", due_date: dueIn(2) });
    const dueLaterHigh = makeItem({ priority: "High", due_date: dueIn(6) });

    const { candidates } = evaluateNotifications(
      [dueLaterHigh, dueSoonLow, dueTodayMedium, overdueHigh],
      {},
      DEFAULT_SETTINGS,
      NOW,
    );

    expect(candidates.map((c) => c.item.id)).toEqual([
      overdueHigh.id,
      dueTodayMedium.id,
      dueSoonLow.id,
      dueLaterHigh.id,
    ]);
  });

  it("12. changing the notification window preference changes eligibility", () => {
    const item = makeItem({ priority: "Medium", due_date: dueIn(5) });
    const narrow = evaluateNotifications([item], {}, settings({ windowDays: 3 }), NOW);
    const wide = evaluateNotifications([item], {}, settings({ windowDays: 7 }), NOW);
    expect(narrow.candidates).toHaveLength(0);
    expect(wide.candidates).toHaveLength(1);
  });

  it("13. reopening the app immediately after does not duplicate the notification", () => {
    const item = makeItem({ priority: "Low", due_date: dueIn(2) });
    const first = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    const momentsLater = new Date(NOW.getTime() + 5 * 60 * 1000);
    const second = evaluateNotifications([item], first.nextState, DEFAULT_SETTINGS, momentsLater);
    expect(first.candidates).toHaveLength(1);
    expect(second.candidates).toHaveLength(0);
  });

  it("14. completing an item after it was notified stops all future notifications for it", () => {
    let item = makeItem({ priority: "Medium", due_date: dueIn(5) });
    const day1 = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(day1.candidates).toHaveLength(1);

    item = { ...item, status: "Completed" };
    const nextDay = addDays(NOW, 1);
    const day2 = evaluateNotifications([item], day1.nextState, DEFAULT_SETTINGS, nextDay);
    expect(day2.candidates).toHaveLength(0);

    const dayAfter = addDays(NOW, 2);
    const day3 = evaluateNotifications([item], day1.nextState, DEFAULT_SETTINGS, dayAfter);
    expect(day3.candidates).toHaveLength(0);
  });

  it("15. the daily-repeat boundary follows the local calendar day, not a 24h timer", () => {
    const item = makeItem({ priority: "Medium", due_date: dueIn(5) });
    const lateNight = new Date(2026, 8, 16, 23, 59, 0);
    const evaluated = evaluateNotifications([item], {}, DEFAULT_SETTINGS, lateNight);
    expect(evaluated.candidates).toHaveLength(1);

    // Two minutes later, but a new calendar day: repeat-eligible again.
    const justAfterMidnight = new Date(2026, 8, 17, 0, 1, 0);
    const nextDayResult = evaluateNotifications([item], evaluated.nextState, DEFAULT_SETTINGS, justAfterMidnight);
    expect(nextDayResult.candidates).toHaveLength(1);

    // But re-checking within the same late-night minute does not duplicate.
    const stillSameNight = new Date(2026, 8, 16, 23, 59, 30);
    const sameNightResult = evaluateNotifications([item], evaluated.nextState, DEFAULT_SETTINGS, stillSameNight);
    expect(sameNightResult.candidates).toHaveLength(0);
  });

  it("Low priority items notify once ever, not once per day", () => {
    const item = makeItem({ priority: "Low", due_date: dueIn(4) });
    const day1 = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(day1.candidates).toHaveLength(1);

    const day2 = evaluateNotifications([item], day1.nextState, DEFAULT_SETTINGS, addDays(NOW, 1));
    expect(day2.candidates).toHaveLength(0);
  });

  it("rescheduling a due date resets notification history", () => {
    const item = makeItem({ priority: "Low", due_date: dueIn(4) });
    const first = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(first.candidates).toHaveLength(1);

    const rescheduled = { ...item, due_date: dueIn(6) };
    const afterReschedule = evaluateNotifications([rescheduled], first.nextState, DEFAULT_SETTINGS, NOW);
    expect(afterReschedule.candidates).toHaveLength(1);
  });

  it("disabling High's daily repeat collapses it to notify-once", () => {
    const item = makeItem({ priority: "High", due_date: dueIn(4) });
    const day1 = evaluateNotifications([item], {}, settings({ repeatDailyEnabled: false }), NOW);
    expect(day1.candidates).toHaveLength(1);

    const day2 = evaluateNotifications(
      [item],
      day1.nextState,
      settings({ repeatDailyEnabled: false }),
      addDays(NOW, 1),
    );
    expect(day2.candidates).toHaveLength(0);
  });

  it("reopening (un-completing) an item makes it eligible again", () => {
    let item = makeItem({ priority: "Medium", due_date: dueIn(2), status: "Completed" });
    const whileCompleted = evaluateNotifications([item], {}, DEFAULT_SETTINGS, NOW);
    expect(whileCompleted.candidates).toHaveLength(0);

    item = { ...item, status: "Not Started" };
    const afterReopen = evaluateNotifications([item], whileCompleted.nextState, DEFAULT_SETTINGS, NOW);
    expect(afterReopen.candidates).toHaveLength(1);
  });

  it("drops notification-state records for items that no longer exist", () => {
    const staleState: NotificationState = {
      "deleted-item": {
        firstNotifiedAt: NOW.toISOString(),
        lastNotifiedAt: NOW.toISOString(),
        lastNotifiedDay: toDateKey(NOW),
        dismissedAt: null,
        dueKey: "2026-09-10T",
      } satisfies ItemNotificationRecord,
    };
    const { nextState } = evaluateNotifications([], staleState, DEFAULT_SETTINGS, NOW);
    expect(nextState).toEqual({});
  });
});

describe("notificationItemKind", () => {
  it("prefers assignment_type when present", () => {
    expect(notificationItemKind(makeItem({ assignment_type: "Exam" }))).toBe("Exam");
  });

  it("labels a Google-synced item as a calendar event", () => {
    expect(notificationItemKind(makeItem({ google_calendar_id: "gcal-1" }))).toBe("Calendar event");
  });

  it("falls back to Deadline for a plain task", () => {
    expect(notificationItemKind(makeItem())).toBe("Deadline");
  });
});

describe("summarizeCandidates", () => {
  it("counts overdue, high-priority, and event items", () => {
    const overdue = makeItem({ due_date: dueIn(-1), priority: "Medium" });
    const highPriority = makeItem({ due_date: dueIn(2), priority: "High" });
    const event = makeItem({ due_date: dueIn(1), priority: "Low", google_calendar_id: "gcal-2" });

    const { candidates } = evaluateNotifications([overdue, highPriority, event], {}, DEFAULT_SETTINGS, NOW);
    const summary = summarizeCandidates(candidates);

    expect(summary).toEqual({ total: 3, overdue: 1, highPriority: 1, events: 1 });
  });
});
