import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart3,
  BookOpen,
  CalendarDays,
  CircleCheck,
  Clock,
  Flag,
  GraduationCap,
  Moon,
  Plus,
  Search,
  SlidersHorizontal,
  StickyNote,
  Sun,
  Timer,
} from "lucide-react";
import { Dot, Kbd } from "@/components/lo/primitives";
import { useToast } from "@/components/lo/Toast";
import { useContexts } from "@/hooks/useContexts";
import { useGlobalSearchIndex } from "@/hooks/useGlobalSearchIndex";
import { useCreateItem, useItems } from "@/hooks/useItems";
import { useObsidianNote, useObsidianSearch } from "@/hooks/useObsidianVault";
import { useTheme } from "@/hooks/useTheme";
import { PERSONAL_HEX, personalLists } from "@/lib/areas";
import { classColorHex } from "@/lib/classColors";
import { obsidianNoteToSearchResult, SEARCH_GROUP_LABEL, searchIndex, type SearchResult } from "@/lib/globalSearch";
import { draftToItemInput, parseQuickAdd, type QuickAddDraft } from "@/lib/quickAdd";
import { formatDue, formatTime } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { usePeekStore } from "@/store/peekStore";
import { useSearchStore } from "@/store/searchStore";

const OBSIDIAN_DEBOUNCE_MS = 200;

interface Command {
  key: string;
  label: string;
  icon: typeof Search;
  hint?: string;
  run: () => void;
}

type Row =
  | { kind: "create"; key: string; draft: QuickAddDraft }
  | { kind: "result"; key: string; result: SearchResult }
  | { kind: "command"; key: string; command: Command };

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function DraftChips({ draft, color }: { draft: QuickAddDraft; color: string }) {
  const chip = "inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-brand-soft px-2.5 text-[13px] font-medium text-brand";
  const ghost = "inline-flex h-7 items-center rounded-[7px] border border-dashed border-line2 px-2.5 text-[13px] text-fg3";
  return (
    <div className="flex flex-wrap gap-1.5 pl-8">
      {draft.dueDate ? (
        <span className={chip}>
          <CalendarDays className="size-3.5" />
          {formatDue({ due_date: draft.dueDate, due_time: null })}
        </span>
      ) : (
        <span className={ghost}>No date</span>
      )}
      {draft.dueTime && (
        <span className={chip}>
          <Clock className="size-3.5" />
          {formatTime(draft.dueTime)}
        </span>
      )}
      <span className={chip}>
        <Dot color={color} />
        {draft.category === "School" ? (draft.className ?? "School") : `Personal${draft.list ? ` · ${draft.list}` : ""}`}
      </span>
      {draft.priority !== "Medium" && (
        <span className={chip}>
          <Flag className="size-3.5" />
          {draft.priority}
        </span>
      )}
    </div>
  );
}

export function CommandBar() {
  const { isOpen, initialQuery, open, close } = useSearchStore();
  const navigate = useNavigate();
  const openPeek = usePeekStore((s) => s.open);
  const showToast = useToast((s) => s.show);
  const { theme, setTheme } = useTheme();
  const { data: contexts = [] } = useContexts();
  const { data: items } = useItems();
  const createItem = useCreateItem();
  const { index } = useGlobalSearchIndex(isOpen);

  const [query, setQuery] = useState("");
  const [obsidianQuery, setObsidianQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ---- global shortcuts: Ctrl/Cmd+K anywhere, N when not typing --------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (useSearchStore.getState().isOpen) close();
        else open();
      } else if (!mod && !e.altKey && e.key.toLowerCase() === "n" && !isTypingTarget(e.target) && !useSearchStore.getState().isOpen) {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery(initialQuery);
    setObsidianQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen, initialQuery]);

  useEffect(() => {
    const timer = setTimeout(() => setObsidianQuery(query), OBSIDIAN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => setActiveIndex(0), [query]);

  const obsidian = useObsidianSearch(isOpen ? obsidianQuery : "");
  const lists = useMemo(() => personalLists(items).map((l) => l.name), [items]);
  const draft = useMemo(() => (query.trim() ? parseQuickAdd(query, contexts, lists) : null), [query, contexts, lists]);
  const draftColor = draft
    ? draft.category === "School"
      ? classColorHex(contexts.find((c) => c.id === draft.classId)?.color)
      : PERSONAL_HEX
    : PERSONAL_HEX;

  const go = (path: string) => () => {
    navigate(path);
    close();
  };

  const commandList: Command[] = useMemo(
    () => [
      { key: "today", label: "Today", icon: Sun, run: go("/") },
      { key: "tasks", label: "Tasks", icon: CircleCheck, run: go("/tasks") },
      { key: "calendar", label: "Calendar", icon: CalendarDays, run: go("/calendar") },
      { key: "focus", label: "Start focus…", icon: Timer, run: go("/focus") },
      { key: "stats", label: "Stats", icon: BarChart3, run: go("/stats") },
      { key: "settings", label: "Settings", icon: SlidersHorizontal, run: go("/settings") },
      {
        key: "theme",
        label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        icon: theme === "dark" ? Sun : Moon,
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          close();
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme],
  );

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    if (draft) out.push({ kind: "create", key: "create", draft });
    if (q) {
      const results = [...searchIndex(index, query), ...(obsidian.data ?? []).map(obsidianNoteToSearchResult)];
      for (const r of results) out.push({ kind: "result", key: r.key, result: r });
    }
    const cmds = q ? commandList.filter((c) => c.label.toLowerCase().includes(q)) : commandList;
    for (const c of cmds) out.push({ kind: "command", key: `cmd:${c.key}`, command: c });
    return out;
  }, [draft, query, index, obsidian.data, commandList]);

  const active = rows[activeIndex];
  const previewPath = active?.kind === "result" && active.result.type === "obsidian" ? (active.result.vaultPath ?? null) : null;
  const previewNote = useObsidianNote(previewPath);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  async function create(d: QuickAddDraft, thenOpen: boolean) {
    const created = await createItem.mutateAsync(draftToItemInput(d));
    close();
    if (thenOpen) openPeek(created.id);
    else showToast(`Added “${created.title}”`, { label: "Open", run: () => openPeek(created.id) });
  }

  function runRow(row: Row, shift = false) {
    if (row.kind === "create") void create(row.draft, shift);
    else if (row.kind === "command") row.command.run();
    else {
      const r = row.result;
      if (r.type === "obsidian") return; // previewed inline, nothing to open
      if (r.itemId) {
        close();
        openPeek(r.itemId);
        return;
      }
      navigate(r.path);
      close();
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) runRow(active, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  if (!isOpen) return null;

  let lastGroup: string | null = null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[12vh] dark:bg-black/50" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Search or add"
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          "flex max-h-[72vh] w-full overflow-hidden rounded-[18px] border border-line bg-popover shadow-pop [animation:lo-pop-in_140ms_ease-out]",
          previewPath ? "max-w-[1000px]" : "max-w-[680px]",
        )}
      >
        <div className={cn("flex min-w-0 flex-1 flex-col", previewPath && "border-r border-line")}>
          <div className="flex flex-col gap-3 border-b border-line px-5 pb-3.5 pt-[18px]">
            <label className="flex items-center gap-3">
              <Search className="size-5 shrink-0 text-fg3" />
              <input
                ref={inputRef}
                aria-label="Search or add a task"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder="Search, or type a task — “Lab 5 #chem tue 11:59pm”"
                className="min-w-0 flex-1 bg-transparent text-[19px] tracking-[-0.01em] outline-none placeholder:text-fg3"
              />
              <Kbd>Esc</Kbd>
            </label>
            {draft && <DraftChips draft={draft} color={draftColor} />}
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto p-2">
            {rows.map((row, i) => {
              const isActive = i === activeIndex;
              const base = cn(
                "flex min-h-11 w-full items-center gap-3 rounded-[10px] px-3 text-left text-sm",
                isActive ? "bg-sunken" : "hover:bg-sunken/60",
              );
              const group =
                row.kind === "create" ? "create" : row.kind === "command" ? "Go to" : SEARCH_GROUP_LABEL[row.result.type];
              const header =
                group !== lastGroup && group !== "create" ? (
                  <div className="px-3 pb-1.5 pt-3.5 text-xs font-medium text-fg3">{group}</div>
                ) : null;
              lastGroup = group;

              let content: React.ReactNode;
              if (row.kind === "create") {
                content = (
                  <>
                    <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                      <Plus className="size-4" strokeWidth={2.4} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14.5px]">
                      Create task <span className="font-semibold">“{row.draft.title}”</span>
                    </span>
                    <span className="hidden text-xs text-fg3 sm:inline">⇧↵ to open</span>
                    <Kbd>↵</Kbd>
                  </>
                );
              } else if (row.kind === "command") {
                const Icon = row.command.icon;
                content = (
                  <>
                    <span className="flex size-7 items-center justify-center rounded-lg bg-sunken text-fg2">
                      <Icon className="size-[15px]" />
                    </span>
                    <span className="flex-1">{row.command.label}</span>
                  </>
                );
              } else {
                const r = row.result;
                const Icon =
                  r.type === "context" ? GraduationCap : r.type === "obsidian" ? BookOpen : r.type === "item" ? CircleCheck : StickyNote;
                content = (
                  <>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sunken text-fg2">
                      {r.color ? <Dot color={r.color} /> : <Icon className="size-[15px]" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    {r.subtitle && <span className="max-w-[45%] shrink-0 truncate text-[12.5px] text-fg3">{r.subtitle}</span>}
                  </>
                );
              }

              return (
                <div key={row.key}>
                  {header}
                  <button
                    type="button"
                    data-row={i}
                    className={base}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={(e) => runRow(row, e.shiftKey)}
                  >
                    {content}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-sidebar px-5 py-3 text-[12.5px] text-fg3">
            <span>
              <span className="font-mono">↵</span> Open / create
            </span>
            <span>
              <span className="font-mono">↑↓</span> Move
            </span>
            <span className="ml-auto">
              <span className="font-mono">#</span> class or list · <span className="font-mono">!high</span> priority
            </span>
          </div>
        </div>

        {previewPath && (
          <div className="hidden w-[45%] min-w-0 flex-col overflow-y-auto px-5 py-4 md:flex">
            <p className="mb-2 truncate text-xs font-medium text-fg3">{previewPath}</p>
            {previewNote.isLoading ? (
              <p className="text-sm text-fg3">Loading…</p>
            ) : previewNote.isError ? (
              <p className="text-sm text-danger">{String(previewNote.error)}</p>
            ) : (
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{previewNote.data}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
