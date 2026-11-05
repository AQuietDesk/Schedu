import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useContexts } from "@/hooks/useContexts";
import { useItems } from "@/hooks/useItems";
import { useQuickNotes } from "@/hooks/useQuickNotes";
import { commands } from "@/lib/commands";
import { buildSearchIndex, type SearchResult } from "@/lib/globalSearch";
import type { Note } from "@/types";

// Notes are stored per-context in the backend (list_notes_for_context), so the
// index fans out across every class rather than calling a "list all notes"
// endpoint that doesn't exist.
export function useGlobalSearchIndex(enabled: boolean): { index: SearchResult[] } {
  const { data: items = [] } = useItems();
  const { data: contexts = [] } = useContexts();
  const { data: quickNotes = [] } = useQuickNotes();

  const classes = contexts.filter((c) => c.type === "Class");
  const noteQueries = useQueries({
    queries: classes.map((context) => ({
      queryKey: ["notes", context.id],
      queryFn: () => commands.listNotesForContext(context.id),
      enabled,
    })),
  });

  const notesKey = noteQueries.map((q) => q.dataUpdatedAt).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const notes = useMemo<Note[]>(() => noteQueries.flatMap((q) => q.data ?? []), [notesKey]);

  const index = useMemo(() => buildSearchIndex({ items, contexts, notes, quickNotes }), [items, contexts, notes, quickNotes]);
  return { index };
}
