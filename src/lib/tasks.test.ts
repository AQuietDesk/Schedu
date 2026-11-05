import { describe, expect, it } from "vitest";
import { comingUp, dueBucket, formatDue, groupByBucket, todayItems } from "@/lib/tasks";
import type { Item } from "@/types";

const NOW = new Date(2026, 9, 17, 21, 35); // Sat Oct 17 2026

function item(id: string, due: string | null, status: Item["status"] = "Not Started", time: string | null = null): Item {
  return {
    id,
    title: id,
    description: null,
    category: "Personal",
    subcategory_id: null,
    subcategory_text: null,
    due_date: due,
    due_time: time,
    estimated_duration: null,
    priority: "Medium",
    status,
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
    created_at: "",
    updated_at: "",
    deleted_at: null,
  };
}

describe("task grouping", () => {
  it("buckets by due date relative to now", () => {
    expect(dueBucket(item("a", "2026-10-16"), NOW)).toBe("overdue");
    expect(dueBucket(item("a", "2026-10-16", "Completed"), NOW)).toBe("today");
    expect(dueBucket(item("a", "2026-10-17"), NOW)).toBe("today");
    expect(dueBucket(item("a", "2026-10-18"), NOW)).toBe("tomorrow");
    expect(dueBucket(item("a", "2026-10-24"), NOW)).toBe("week");
    expect(dueBucket(item("a", "2026-10-25"), NOW)).toBe("later");
    expect(dueBucket(item("a", null), NOW)).toBe("none");
  });

  it("orders groups and items", () => {
    const groups = groupByBucket(
      [item("later", "2026-11-02"), item("today-b", "2026-10-17", "Not Started", "18:00"), item("today-a", "2026-10-17", "Not Started", "09:00"), item("late", "2026-10-15")],
      NOW,
    );
    expect(groups.map((g) => g.bucket)).toEqual(["overdue", "today", "later"]);
    expect(groups[1].items.map((i) => i.id)).toEqual(["today-a", "today-b"]);
  });

  it("today list: open overdue + due today, done items last", () => {
    const list = todayItems(
      [item("done", "2026-10-17", "Completed"), item("open", "2026-10-17"), item("old", "2026-10-10"), item("old-done", "2026-10-10", "Completed"), item("tmrw", "2026-10-18")],
      NOW,
    );
    expect(list.map((i) => i.id)).toEqual(["old", "open", "done"]);
  });

  it("coming up groups the next 7 days by date", () => {
    const groups = comingUp([item("a", "2026-10-19"), item("b", "2026-10-19"), item("c", "2026-10-24"), item("d", "2026-10-25"), item("e", "2026-10-17")], 7, NOW);
    expect(groups.map((g) => [g.date, g.items.length])).toEqual([
      ["2026-10-19", 2],
      ["2026-10-24", 1],
    ]);
  });

  it("formats relative due labels", () => {
    expect(formatDue(item("a", "2026-10-16"), NOW)).toBe("Yesterday");
    expect(formatDue(item("a", "2026-10-17"), NOW)).toBe("Today");
    expect(formatDue(item("a", "2026-10-18"), NOW)).toBe("Tomorrow");
    expect(formatDue(item("a", ""), NOW)).toBe("");
  });
});
