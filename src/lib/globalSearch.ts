import { itemContextInfo } from "@/lib/areas";
import type { Context, Item, Note, ObsidianNote, QuickNote } from "@/types";

export type SearchResultType = "item" | "context" | "note" | "quickNote" | "obsidian";

export interface SearchResult {
  key: string;
  type: SearchResultType;
  title: string;
  subtitle: string | null;
  /** Route to open, for results that live on a page. */
  path: string;
  /** Set on "item" results — opening one shows the task's side peek. */
  itemId?: string;
  /** Dot color shown beside the result (class / Personal). */
  color?: string;
  haystack: string;
  /** Vault-relative path, set only on "obsidian" results (previewed inline). */
  vaultPath?: string;
}

export const SEARCH_GROUP_LABEL: Record<SearchResultType, string> = {
  item: "Tasks",
  context: "Classes",
  note: "Class notes",
  quickNote: "Notes",
  obsidian: "Obsidian vault",
};

export function obsidianNoteToSearchResult(note: ObsidianNote): SearchResult {
  return {
    key: `obsidian:${note.path}`,
    type: "obsidian",
    title: note.title,
    subtitle: note.snippet,
    path: "",
    haystack: "",
    vaultPath: note.path,
  };
}

function normalize(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export interface GlobalSearchSources {
  items: Item[];
  contexts: Context[];
  notes: Note[];
  quickNotes: QuickNote[];
}

export function buildSearchIndex(sources: GlobalSearchSources): SearchResult[] {
  const contextsById = new Map(sources.contexts.map((c) => [c.id, c]));
  const results: SearchResult[] = [];

  for (const item of sources.items) {
    if (item.deleted_at) continue;
    const info = itemContextInfo(item, contextsById);
    results.push({
      key: `item:${item.id}`,
      type: "item",
      title: item.title,
      subtitle: [info.label, item.due_date].filter(Boolean).join(" · ") || null,
      path: "/tasks",
      itemId: item.id,
      color: info.color,
      haystack: normalize(item.title, item.description, item.notes, info.label, item.tags?.join(" ")),
    });
  }

  for (const context of sources.contexts) {
    if (context.type !== "Class") continue;
    results.push({
      key: `context:${context.id}`,
      type: "context",
      title: context.name,
      subtitle: [context.term, context.owner].filter(Boolean).join(" · ") || null,
      path: `/school/${context.id}`,
      haystack: normalize(context.name, context.term, context.owner, context.schedule),
    });
  }

  for (const note of sources.notes) {
    const owner = contextsById.get(note.context_id);
    if (!owner || owner.type !== "Class") continue;
    results.push({
      key: `note:${note.id}`,
      type: "note",
      title: note.body.slice(0, 80),
      subtitle: owner.name,
      path: `/school/${owner.id}?tab=notes`,
      haystack: normalize(note.body, owner.name),
    });
  }

  for (const qn of sources.quickNotes) {
    results.push({
      key: `quickNote:${qn.id}`,
      type: "quickNote",
      title: qn.body.slice(0, 80),
      subtitle: "Today · Notes",
      path: "/",
      haystack: normalize(qn.body),
    });
  }

  return results;
}

const MAX_RESULTS = 30;

export function searchIndex(index: SearchResult[], rawQuery: string): SearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const scored = index
    .map((result) => {
      const titleLower = result.title.toLowerCase();
      let score: number;
      if (titleLower === query) score = 0;
      else if (titleLower.startsWith(query)) score = 1;
      else if (titleLower.includes(query)) score = 2;
      else if (result.haystack.includes(query)) score = 3;
      else score = -1;
      return { result, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => a.score - b.score || a.result.title.length - b.result.title.length);

  return scored.slice(0, MAX_RESULTS).map((r) => r.result);
}
