import { classColorHex } from "@/lib/classColors";
import type { Context, Item } from "@/types";

/**
 * The redesign has exactly two areas. Everything that isn't School is
 * Personal — including legacy categories (Work, Gym, Finance, Health…),
 * which surface as a Personal *list* of the same name rather than being
 * rewritten in the database. Nothing is lost; it just stops being a
 * top-level concept.
 */
export type Area = "School" | "Personal";

export const PERSONAL_HEX = "#d9730d";

export function itemArea(item: Pick<Item, "category">): Area {
  return item.category === "School" ? "School" : "Personal";
}

/** The Personal list an item belongs to, or null for "no list". */
export function personalList(item: Pick<Item, "category" | "subcategory_text">): string | null {
  if (item.category === "School") return null;
  const text = item.subcategory_text?.trim();
  if (text) return text;
  if (item.category !== "Personal") return item.category; // legacy category → list
  return null;
}

/** Active classes, in name order — the sidebar's School section. */
export function activeClasses(contexts: Context[] | undefined): Context[] {
  return (contexts ?? [])
    .filter((c) => c.type === "Class" && c.status === "Active")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every Personal list name in use by an open (or recently done) item. */
export function personalLists(items: Item[] | undefined): { name: string; open: number }[] {
  const counts = new Map<string, number>();
  for (const item of items ?? []) {
    const list = personalList(item);
    if (!list) continue;
    counts.set(list, (counts.get(list) ?? 0) + (item.status === "Completed" ? 0 : 1));
  }
  return Array.from(counts.entries())
    .map(([name, open]) => ({ name, open }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ItemContextInfo {
  label: string;
  color: string;
  classId: string | null;
}

/** What to show in a task row's context chip: class name + color, or list. */
export function itemContextInfo(item: Item, contextsById: Map<string, Context>): ItemContextInfo {
  if (item.category === "School") {
    const ctx = item.subcategory_id ? contextsById.get(item.subcategory_id) : undefined;
    if (ctx) return { label: ctx.name, color: classColorHex(ctx.color), classId: ctx.id };
    return { label: "School", color: classColorHex(null), classId: null };
  }
  return { label: personalList(item) ?? "Personal", color: PERSONAL_HEX, classId: null };
}

export function contextsMap(contexts: Context[] | undefined): Map<string, Context> {
  return new Map((contexts ?? []).map((c) => [c.id, c]));
}
