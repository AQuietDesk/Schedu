import { describe, expect, it } from "vitest";
import { applyInlineDefaults, draftToItemInput, parseQuickAdd, type InlineAddDefaults } from "@/lib/quickAdd";
import type { Context } from "@/types";

function cls(id: string, name: string): Context {
  return {
    id,
    type: "Class",
    name,
    color: "blue",
    status: "Active",
    term: null,
    schedule: null,
    owner: null,
    grade_scale: null,
    grade_cutoffs: null,
  };
}

const CONTEXTS = [cls("fm", "Intro to Biology"), cls("py", "Chemistry Lab")];
// Saturday, October 17 2026, 9:35 PM local
const NOW = new Date(2026, 9, 17, 21, 35);

describe("parseQuickAdd", () => {
  it("pulls out a date and time and leaves a clean title", () => {
    const d = parseQuickAdd("Cello prep tomorrow 4pm", CONTEXTS, [], NOW);
    expect(d.title).toBe("Cello prep");
    expect(d.dueDate).toBe("2026-10-18");
    expect(d.dueTime).toBe("16:00");
    expect(d.category).toBe("Personal");
    expect(d.classId).toBeNull();
  });

  it("matches a class by #tag prefix", () => {
    const d = parseQuickAdd("Lab 5 #chem tue", CONTEXTS, [], NOW);
    expect(d.category).toBe("School");
    expect(d.classId).toBe("py");
    expect(d.title).toBe("Lab 5");
    expect(d.dueDate).toBe("2026-10-20");
    expect(d.dueTime).toBeNull();
  });

  it("matches a class written in plain text", () => {
    const d = parseQuickAdd("Midterm review for intro to biology", CONTEXTS, [], NOW);
    expect(d.classId).toBe("fm");
    expect(d.category).toBe("School");
  });

  it("files an unknown #tag as a Personal list, reusing a known list's casing", () => {
    expect(parseQuickAdd("Rosin #cello", CONTEXTS, ["Cello"], NOW).list).toBe("Cello");
    const fresh = parseQuickAdd("Pay rent #bills", CONTEXTS, [], NOW);
    expect(fresh.list).toBe("Bills");
    expect(fresh.category).toBe("Personal");
    expect(draftToItemInput(fresh)).toMatchObject({ category: "Personal", subcategory_text: "Bills", subcategory_id: null });
  });

  it("reads priority shorthands", () => {
    expect(parseQuickAdd("Renew passport !high", CONTEXTS, [], NOW).priority).toBe("High");
    expect(parseQuickAdd("Renew passport !!", CONTEXTS, [], NOW).priority).toBe("High");
    expect(parseQuickAdd("Water plants !low", CONTEXTS, [], NOW).priority).toBe("Low");
    expect(parseQuickAdd("Water plants", CONTEXTS, [], NOW).priority).toBe("Medium");
  });

  it("treats school keywords without a class as School", () => {
    const d = parseQuickAdd("Study for quiz", CONTEXTS, [], NOW);
    expect(d.category).toBe("School");
    expect(d.classId).toBeNull();
  });

  it("never returns an empty title", () => {
    expect(parseQuickAdd("tomorrow", CONTEXTS, [], NOW).title).toBe("tomorrow");
  });
});

describe("applyInlineDefaults", () => {
  const place = (text: string, defaults: InlineAddDefaults) => {
    const draft = parseQuickAdd(text, CONTEXTS, ["Errands"]);
    return applyInlineDefaults(draftToItemInput(draft), draft, defaults);
  };

  it("files into the list even when the title contains a school keyword", () => {
    const input = place("Study module 2 of the learning path", { list: "Errands" });
    expect(input.category).toBe("Personal");
    expect(input.subcategory_text).toBe("Errands");
  });

  it("files plain titles into the list", () => {
    const input = place("Watch DAX video", { list: "Errands" });
    expect(input.category).toBe("Personal");
    expect(input.subcategory_text).toBe("Errands");
  });

  it("lets an explicit #list override the page default", () => {
    const input = place("Buy milk #groceries", { list: "Errands" });
    expect(input.subcategory_text).toBe("Groceries");
  });

  it("keeps a class match instead of the list default", () => {
    const input = place("Exam prep for intro to biology", { list: "Errands" });
    expect(input.category).toBe("School");
    expect(input.subcategory_id).toBe("fm");
  });

  it("applies the class default on a class page", () => {
    const input = place("Case study 3", { classId: "py" });
    expect(input.category).toBe("School");
    expect(input.subcategory_id).toBe("py");
  });

  it("does not mutate the input", () => {
    const draft = parseQuickAdd("Study DAX", CONTEXTS, []);
    const original = draftToItemInput(draft);
    const snapshot = { ...original };
    applyInlineDefaults(original, draft, { list: "Errands" });
    expect(original).toEqual(snapshot);
  });
});
