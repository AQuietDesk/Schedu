import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Kbd } from "@/components/lo/primitives";
import { useToast } from "@/components/lo/Toast";
import { useContexts } from "@/hooks/useContexts";
import { useCreateItem, useItems } from "@/hooks/useItems";
import { toDateKey } from "@/lib/calendarGrid";
import { personalLists } from "@/lib/areas";
import { applyInlineDefaults, draftToItemInput, parseQuickAdd, type InlineAddDefaults } from "@/lib/quickAdd";
import { formatDue } from "@/lib/tasks";
import { usePeekStore } from "@/store/peekStore";

/**
 * The always-there "Add a task" row. Same natural-language parsing as the
 * command bar, plus defaults from where it lives — on Today it's due today,
 * on a class page it belongs to that class, on a list it lands in that list.
 */
export function InlineAdd({
  placeholder = "Add a task",
  defaults,
  showKbd = false,
}: {
  placeholder?: string;
  defaults?: InlineAddDefaults;
  showKbd?: boolean;
}) {
  const [text, setText] = useState("");
  const { data: contexts = [] } = useContexts();
  const { data: items } = useItems();
  const createItem = useCreateItem();
  const openPeek = usePeekStore((s) => s.open);
  const showToast = useToast((s) => s.show);
  const lists = useMemo(() => personalLists(items).map((l) => l.name), [items]);

  const draft = text.trim() ? parseQuickAdd(text, contexts, lists) : null;
  const hint = draft
    ? [
        draft.dueDate ? formatDue({ due_date: draft.dueDate, due_time: draft.dueTime }, new Date(), true) : defaults?.dueToday ? "Today" : null,
        draft.className ?? draft.list,
        draft.priority === "High" ? "High priority" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  async function submit() {
    if (!draft) return;
    const placed = applyInlineDefaults(draftToItemInput(draft), draft, defaults);
    const input = defaults?.dueToday && !placed.due_date ? { ...placed, due_date: toDateKey(new Date()) } : placed;
    const created = await createItem.mutateAsync({ ...input, ...defaults?.extra });
    setText("");
    showToast(`Added “${created.title}”`, { label: "Open", run: () => openPeek(created.id) });
  }

  return (
    <label className="mb-1.5 flex h-11 items-center gap-3 rounded-[10px] bg-sunken px-3 text-fg3 focus-within:ring-2 focus-within:ring-ring/40">
      <Plus className="size-[18px] shrink-0" />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            setText("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-fg3"
      />
      {hint && <span className="hidden shrink-0 text-xs text-brand sm:inline">{hint}</span>}
      {showKbd && !text && <Kbd>N</Kbd>}
    </label>
  );
}
