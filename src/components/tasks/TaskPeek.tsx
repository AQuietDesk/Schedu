import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CalendarClock, FileText, Timer, Trash2, X } from "lucide-react";
import { Dot, Segmented, TaskCheck } from "@/components/lo/primitives";
import { SyncStatusCell } from "@/components/SyncStatusCell";
import { useContexts } from "@/hooks/useContexts";
import { useGoogleConnected, useItemSyncStatuses } from "@/hooks/useGoogle";
import { useItems, useSoftDeleteItem, useUpdateItem } from "@/hooks/useItems";
import { activeClasses, contextsMap, itemArea, itemContextInfo, personalList, personalLists } from "@/lib/areas";
import { nextStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { usePeekStore } from "@/store/peekStore";
import type { Item, ItemStatus, Priority } from "@/types";

export const fieldClass =
  "h-8 w-full rounded-md border border-transparent bg-transparent px-2 text-sm outline-none transition-colors hover:bg-sunken focus:border-line2 focus:bg-card";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_1fr] items-center gap-2">
      <span className="text-sm text-fg3">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const STATUS_OPTIONS: { value: ItemStatus; label: string }[] = [
  { value: "Not Started", label: "To do" },
  { value: "In Progress", label: "In progress" },
  { value: "Completed", label: "Done" },
];

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: "Low", label: "Low" },
  { value: "Medium", label: "Medium" },
  { value: "High", label: "High" },
];

function PeekBody({ item }: { item: Item }) {
  const navigate = useNavigate();
  const close = usePeekStore((s) => s.close);
  const updateItem = useUpdateItem();
  const softDelete = useSoftDeleteItem();
  const { data: contexts } = useContexts();
  const { data: items } = useItems();
  const { data: connected } = useGoogleConnected();
  const { data: syncStatuses } = useItemSyncStatuses(!!connected);

  const [title, setTitle] = useState(item.title);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [list, setList] = useState(personalList(item) ?? "");
  const [location, setLocation] = useState(item.location ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setTitle(item.title);
    setNotes(item.notes ?? "");
    setList(personalList(item) ?? "");
    setLocation(item.location ?? "");
    setConfirmDelete(false);
    // Only reset local drafts when switching to a different task, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const byId = useMemo(() => contextsMap(contexts), [contexts]);
  const classes = activeClasses(contexts);
  const lists = personalLists(items).map((l) => l.name);
  const info = itemContextInfo(item, byId);
  const area = itemArea(item);
  const cls = item.subcategory_id ? byId.get(item.subcategory_id) : undefined;
  const typeOptions = Object.keys(cls?.grade_scale ?? {});
  const sync = syncStatuses?.find((s) => s.item_id === item.id);

  const save = (patch: Partial<Item>) => updateItem.mutate({ ...item, ...patch });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-6 pt-5 text-[13px] text-fg3">
        <span className="flex min-w-0 items-center gap-1.5">
          <Dot color={info.color} />
          <span className="truncate">{area === "School" ? info.label : `Personal${personalList(item) ? ` · ${personalList(item)}` : ""}`}</span>
        </span>
        <button
          type="button"
          aria-label="Close details"
          onClick={close}
          className="flex size-8 items-center justify-center rounded-lg text-fg3 hover:bg-hover"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6 pt-3">
        <div className="flex items-start gap-3">
          <div className="pt-[7px]">
            <TaskCheck status={item.status} label={item.title} size={22} onToggle={() => save({ status: nextStatus(item.status) })} />
          </div>
          <textarea
            aria-label="Title"
            value={title}
            rows={1}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== item.title && save({ title: title.trim() })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            className={cn(
              "field-sizing-content min-w-0 flex-1 resize-none bg-transparent text-2xl font-semibold leading-tight tracking-tight outline-none",
              item.status === "Completed" && "text-fg3 line-through",
            )}
          />
        </div>

        <Segmented label="Status" value={item.status} options={STATUS_OPTIONS} onChange={(status) => save({ status })} size="sm" />

        <div className="space-y-1">
          <Row label="Due">
            <div className="flex gap-1">
              <input
                type="date"
                aria-label="Due date"
                value={item.due_date ?? ""}
                onChange={(e) => save({ due_date: e.target.value || null })}
                className={fieldClass}
              />
              <input
                type="time"
                aria-label="Due time"
                value={item.due_time ?? ""}
                onChange={(e) => save({ due_time: e.target.value || null })}
                className={cn(fieldClass, "w-[120px] shrink-0")}
              />
            </div>
          </Row>
          <Row label="Area">
            <Segmented
              label="Area"
              size="sm"
              value={area}
              options={[
                { value: "School", label: "School" },
                { value: "Personal", label: "Personal" },
              ]}
              onChange={(next) =>
                next === "School"
                  ? save({ category: "School", subcategory_text: null, subcategory_id: classes[0]?.id ?? null })
                  : save({ category: "Personal", subcategory_id: null, subcategory_text: list.trim() || null })
              }
            />
          </Row>
          {area === "School" ? (
            <>
              <Row label="Class">
                <select
                  aria-label="Class"
                  value={item.subcategory_id ?? ""}
                  onChange={(e) => save({ subcategory_id: e.target.value || null })}
                  className={fieldClass}
                >
                  <option value="">No class</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  {cls && cls.status !== "Active" && <option value={cls.id}>{cls.name} (archived)</option>}
                </select>
              </Row>
              <Row label="Type">
                <select
                  aria-label="Assignment type"
                  value={item.assignment_type ?? ""}
                  onChange={(e) => save({ assignment_type: e.target.value || null })}
                  className={fieldClass}
                >
                  <option value="">—</option>
                  {typeOptions.map((t) => (
                    <option key={t} value={t}>
                      {t} · {cls?.grade_scale?.[t]}%
                    </option>
                  ))}
                  {item.assignment_type && !typeOptions.includes(item.assignment_type) && (
                    <option value={item.assignment_type}>{item.assignment_type}</option>
                  )}
                </select>
              </Row>
              <Row label="Score">
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    aria-label="Points earned"
                    placeholder="—"
                    value={item.points_earned ?? ""}
                    onChange={(e) => save({ points_earned: e.target.value === "" ? null : Number(e.target.value) })}
                    className={cn(fieldClass, "w-20")}
                  />
                  <span className="text-fg3">/</span>
                  <input
                    type="number"
                    aria-label="Points possible"
                    placeholder="—"
                    value={item.points_possible ?? ""}
                    onChange={(e) => save({ points_possible: e.target.value === "" ? null : Number(e.target.value) })}
                    className={cn(fieldClass, "w-20")}
                  />
                  {item.points_earned != null && item.points_possible ? (
                    <span className="ml-1 text-sm text-fg2">{((item.points_earned / item.points_possible) * 100).toFixed(1)}%</span>
                  ) : null}
                </div>
              </Row>
            </>
          ) : (
            <Row label="List">
              <input
                aria-label="List"
                list="lo-peek-lists"
                placeholder="No list"
                value={list}
                onChange={(e) => setList(e.target.value)}
                onBlur={() => list.trim() !== (personalList(item) ?? "") && save({ category: "Personal", subcategory_text: list.trim() || null })}
                className={fieldClass}
              />
              <datalist id="lo-peek-lists">
                {lists.map((l) => (
                  <option key={l} value={l} />
                ))}
              </datalist>
            </Row>
          )}
          <Row label="Priority">
            <Segmented label="Priority" size="sm" value={item.priority} options={PRIORITY_OPTIONS} onChange={(priority) => save({ priority })} />
          </Row>
          <Row label="Estimate">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={5}
                aria-label="Estimate in minutes"
                placeholder="—"
                value={item.estimated_duration ?? ""}
                onChange={(e) => save({ estimated_duration: e.target.value === "" ? null : Number(e.target.value) })}
                className={cn(fieldClass, "w-24")}
              />
              <span className="text-sm text-fg3">min</span>
            </div>
          </Row>
          <Row label="Location">
            <input
              aria-label="Location"
              placeholder="—"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onBlur={() => location !== (item.location ?? "") && save({ location: location.trim() || null })}
              className={fieldClass}
            />
          </Row>
          {connected && (
            <Row label="Google">
              <div className="px-2">
                {sync ? <SyncStatusCell itemId={item.id} status={sync.status} error={sync.last_sync_error} /> : <span className="text-sm text-fg3">Not synced</span>}
              </div>
            </Row>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-[13px] text-fg3" htmlFor="lo-peek-notes">
            Notes
          </label>
          <textarea
            id="lo-peek-notes"
            value={notes}
            placeholder="Add notes…"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (item.notes ?? "") && save({ notes: notes.trim() ? notes : null })}
            className="field-sizing-content min-h-24 w-full resize-none rounded-[10px] bg-sunken px-3.5 py-3 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        {item.obsidian_source_file && (
          <p className="flex items-center gap-2 text-[13px] text-fg3">
            <FileText className="size-3.5" />
            From Obsidian: {item.obsidian_source_file}
            {item.obsidian_source_section ? ` › ${item.obsidian_source_section}` : ""}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-6 py-4">
        <button
          type="button"
          onClick={() => {
            close();
            navigate(`/focus?item=${item.id}`);
          }}
          className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[10px] bg-primary text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Timer className="size-4" />
          Start focus
        </button>
        <button
          type="button"
          onClick={() => {
            close();
            navigate(`/calendar?date=${item.due_date ?? ""}`);
          }}
          className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-line2 px-4 text-sm hover:bg-hover"
        >
          <CalendarClock className="size-4" />
          Schedule
        </button>
        <button
          type="button"
          aria-label={confirmDelete ? "Confirm delete" : "Delete task"}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            softDelete.mutate(item.id);
            close();
          }}
          className={cn(
            "inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-3 text-sm transition-colors",
            confirmDelete ? "bg-danger-soft text-danger" : "text-fg3 hover:bg-hover hover:text-danger",
          )}
        >
          <Trash2 className="size-4" />
          {confirmDelete && "Delete?"}
        </button>
      </div>
    </div>
  );
}

/** Right-hand side peek; rendered once in AppLayout. */
export function TaskPeek() {
  const itemId = usePeekStore((s) => s.itemId);
  const close = usePeekStore((s) => s.close);
  const { data: items } = useItems();
  const item = itemId ? items?.find((i) => i.id === itemId) : undefined;
  const { pathname } = useLocation();

  // Moving to another page closes the peek, like Notion's side peek.
  useEffect(() => {
    usePeekStore.getState().close();
  }, [pathname]);

  useEffect(() => {
    if (!itemId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [itemId, close]);

  useEffect(() => {
    // The task was deleted (here or by sync) while open.
    if (itemId && items && !item) close();
  }, [itemId, items, item, close]);

  if (!item) return null;

  return (
    <aside
      aria-label="Task details"
      className="fixed inset-y-0 right-0 z-40 w-full max-w-[440px] border-l border-line bg-card shadow-pop [animation:lo-peek-in_160ms_ease-out]"
    >
      <PeekBody item={item} />
    </aside>
  );
}
