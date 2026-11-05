import * as chrono from "chrono-node";
import type { Category, Context, ItemInput, Priority } from "@/types";

/**
 * One-line capture, parsed as you type. Recognises:
 *  - a date/time anywhere ("tomorrow 4pm", "fri", "oct 22 at 1")
 *  - `#name` — a class or Personal list (prefix match, case-insensitive);
 *    an unknown `#name` creates/uses a Personal list of that name
 *  - a class name written plainly ("…for intro to biology")
 *  - `!high` / `!h` / `!!` (and `!low` / `!l`) for priority
 * Anything it can't place goes to Personal with no list — there's no Inbox
 * to triage later; every field is fixable from the task's side peek.
 */
export interface QuickAddDraft {
  title: string;
  category: Category;
  classId: string | null;
  className: string | null;
  list: string | null;
  dueDate: string | null;
  dueTime: string | null;
  priority: Priority;
}

const SCHOOL_KEYWORDS = ["assignment", "homework", "exam", "midterm", "final", "quiz", "lecture", "study", "lab", "essay", "reading"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function cleanSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function parseQuickAdd(
  input: string,
  contexts: Context[],
  knownLists: string[] = [],
  now: Date = new Date(),
): QuickAddDraft {
  let text = input;
  const classes = contexts.filter((c) => c.type === "Class" && c.status === "Active");

  // --- priority ---------------------------------------------------------
  let priority: Priority = "Medium";
  const prio = text.match(/(^|\s)(!high|!h|!!|!low|!l)(?=\s|$)/i);
  if (prio) {
    priority = /!l/i.test(prio[2]) ? "Low" : "High";
    text = text.replace(prio[0], " ");
  }

  // --- #tag: class or list ----------------------------------------------
  let classId: string | null = null;
  let className: string | null = null;
  let list: string | null = null;
  const tag = text.match(/(^|\s)#([\p{L}\p{N}_&'-]+)/u);
  if (tag) {
    const needle = tag[2].toLowerCase().replace(/[-_]/g, " ");
    const cls = classes.find((c) => c.name.toLowerCase().startsWith(needle) || c.name.toLowerCase().replace(/\s+/g, "").startsWith(needle.replace(/\s+/g, "")));
    if (cls) {
      classId = cls.id;
      className = cls.name;
    } else {
      const known = knownLists.find((l) => l.toLowerCase().startsWith(needle));
      list = known ?? tag[2].replace(/[-_]/g, " ");
      list = list.charAt(0).toUpperCase() + list.slice(1);
    }
    text = text.replace(tag[0], " ");
  }

  // --- date / time ------------------------------------------------------
  let dueDate: string | null = null;
  let dueTime: string | null = null;
  const result = chrono.parse(text, now, { forwardDate: true })[0];
  if (result) {
    const d = result.start.date();
    dueDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (result.start.isCertain("hour")) dueTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    text = text.slice(0, result.index) + " " + text.slice(result.index + result.text.length);
  }

  // --- plain class name -------------------------------------------------
  const lower = text.toLowerCase();
  if (!classId && !list) {
    const cls = classes
      .slice()
      .sort((a, b) => b.name.length - a.name.length)
      .find((c) => lower.includes(c.name.toLowerCase()));
    if (cls) {
      classId = cls.id;
      className = cls.name;
    }
  }

  let title = cleanSpaces(text).replace(/\s+(for|at|on|by|due)$/i, "");
  if (!title) title = cleanSpaces(input);

  let category: Category = "Personal";
  if (classId) category = "School";
  else if (!list && SCHOOL_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(title))) category = "School";

  return { title, category, classId, className, list, dueDate, dueTime, priority };
}

export function draftToItemInput(draft: QuickAddDraft): ItemInput {
  return {
    title: draft.title,
    category: draft.category,
    subcategory_id: draft.category === "School" ? draft.classId : null,
    subcategory_text: draft.category === "School" ? null : draft.list,
    due_date: draft.dueDate,
    due_time: draft.dueTime,
    priority: draft.priority,
  };
}

export interface InlineAddDefaults {
  dueToday?: boolean;
  classId?: string;
  list?: string;
  school?: boolean;
  extra?: Partial<ItemInput>;
}

/**
 * Where an inline-added task lands, given the page it was typed on. An explicit
 * `#tag` or a plain class-name match in the text wins; otherwise the page's
 * class/school/list default applies. The list default deliberately ignores the
 * School *keyword* guess ("study", "exam", "lab"…) — typing into a list page is
 * explicit intent, and a title like "Study module 2" must not leave that list.
 */
export function applyInlineDefaults(input: ItemInput, draft: QuickAddDraft, defaults?: InlineAddDefaults): ItemInput {
  if (!defaults || draft.classId || draft.list) return input;
  if (defaults.classId) return { ...input, category: "School", subcategory_id: defaults.classId, subcategory_text: null };
  if (defaults.school) return { ...input, category: "School", subcategory_text: null };
  if (defaults.list) return { ...input, category: "Personal", subcategory_id: null, subcategory_text: defaults.list };
  return input;
}
