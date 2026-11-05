import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Archive, ChevronDown, GraduationCap, Pencil, Trash2 } from "lucide-react";
import { EmptyState, Panel, SecondaryButton, TaskCheck, TopBar } from "@/components/lo/primitives";
import { QueryBoundary } from "@/components/QueryBoundary";
import { ClassDialog } from "@/components/school/ClassDialog";
import { InlineAdd } from "@/components/tasks/InlineAdd";
import { Textarea } from "@/components/ui/textarea";
import { useContexts, useUpdateContext } from "@/hooks/useContexts";
import { useItems, useUpdateItem } from "@/hooks/useItems";
import { useCreateNote, useDeleteNote, useNotesForContext } from "@/hooks/useNotes";
import { classColorHex, tint } from "@/lib/classColors";
import { daysUntil } from "@/lib/dates";
import { useGradeScale } from "@/hooks/usePreferences";
import { calculateGrade } from "@/lib/gradeCalculation";
import { compareByDue, formatDue, isDone, nextStatus } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { usePeekStore } from "@/store/peekStore";
import type { Context, Item } from "@/types";

type Tab = "assignments" | "grades" | "notes";

function score(item: Item): string {
  if (item.points_earned == null) return "—";
  return item.points_possible ? `${item.points_earned}/${item.points_possible}` : String(item.points_earned);
}

function AssignmentTable({ items, muted = false }: { items: Item[]; muted?: boolean }) {
  const openPeek = usePeekStore((s) => s.open);
  const updateItem = useUpdateItem();
  const peekId = usePeekStore((s) => s.itemId);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <tbody>
          {items.map((item) => {
            const overdue = !isDone(item) && (daysUntil(item.due_date) ?? 0) < 0;
            return (
              <tr
                key={item.id}
                onClick={() => openPeek(item.id)}
                className={cn("cursor-default border-t border-line transition-colors", peekId === item.id ? "bg-brand-soft" : "hover:bg-sunken", muted && "text-fg2")}
              >
                <td className="w-10 py-3 pl-3">
                  <TaskCheck
                    status={item.status}
                    overdue={overdue}
                    label={item.title}
                    size={18}
                    onToggle={() => updateItem.mutate({ ...item, status: nextStatus(item.status) })}
                  />
                </td>
                <td className={cn("px-3 py-3", isDone(item) && "text-fg3 line-through")}>{item.title}</td>
                <td className="px-3 py-3 text-fg2">{item.assignment_type ?? "—"}</td>
                <td className={cn("whitespace-nowrap px-3 py-3", overdue ? "text-danger" : "text-fg2")}>{formatDue(item) || "—"}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-[13px]">{score(item)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Breakdown({ context, items, color }: { context: Context; items: Item[]; color: string }) {
  const grade = calculateGrade(items, context, useGradeScale());
  const byType = new Map(grade.categoryBreakdown.map((c) => [c.category, c]));
  const scale = Object.entries(context.grade_scale ?? {});
  return (
    <div className="flex flex-col gap-3.5 text-[13.5px]">
      {scale.length === 0 && <p className="text-fg3">No grade weights set. Edit the class to add them.</p>}
      {scale.map(([type, weight]) => {
        const row = byType.get(type);
        return (
          <div key={type} className="flex flex-col gap-1.5">
            <div className={cn("flex justify-between", !row && "text-fg3")}>
              <span>
                {type} <span className="text-fg3">{weight}%</span>
              </span>
              <span className="font-mono text-[12.5px]">{row ? `${row.percent.toFixed(0)}%` : "Not graded"}</span>
            </div>
            <div className="h-1.5 rounded-full bg-sunken">
              {row && <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, row.percent)}%`, background: color }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NotesTab({ context, items }: { context: Context; items: Item[] }) {
  const { data: notes, isLoading } = useNotesForContext(context.id);
  const createNote = useCreateNote(context.id);
  const deleteNote = useDeleteNote(context.id);
  const [body, setBody] = useState("");
  const [linked, setLinked] = useState("");
  const titleById = new Map(items.map((i) => [i.id, i.title]));

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!body.trim()) return;
          createNote.mutate({ context_id: context.id, item_id: linked || null, body });
          setBody("");
          setLinked("");
        }}
      >
        <Textarea placeholder="Write a note…" value={body} onChange={(e) => setBody(e.target.value)} rows={3} className="bg-card" />
        <div className="flex items-center gap-2">
          <select
            aria-label="Link to assignment"
            value={linked}
            onChange={(e) => setLinked(e.target.value)}
            className="h-[34px] min-w-0 flex-1 rounded-lg border border-line2 bg-transparent px-2.5 text-[13px] text-fg2 outline-none"
          >
            <option value="">Not linked to an assignment</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
          <SecondaryButton type="submit" disabled={!body.trim() || createNote.isPending}>
            Add note
          </SecondaryButton>
        </div>
      </form>
      {isLoading ? null : notes && notes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id} className="group rounded-xl border border-line p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{note.body}</p>
              <div className="mt-2 flex items-center justify-between text-xs text-fg3">
                <span>
                  {new Date(note.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  {note.item_id && ` · ${titleById.get(note.item_id) ?? "Assignment"}`}
                </span>
                <button
                  type="button"
                  aria-label="Delete note"
                  onClick={() => deleteNote.mutate(note.id)}
                  className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No notes for this class yet.</EmptyState>
      )}
    </div>
  );
}

export default function ClassPage() {
  const { contextId } = useParams();
  const [params, setParams] = useSearchParams();
  const contextsQuery = useContexts();
  const itemsQuery = useItems();
  const updateContext = useUpdateContext();
  const [editing, setEditing] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const tab = (params.get("tab") as Tab | null) ?? "assignments";

  const context = contextsQuery.data?.find((c) => c.id === contextId);
  const items = useMemo(
    () => (itemsQuery.data ?? []).filter((i) => i.subcategory_id === contextId).sort(compareByDue),
    [itemsQuery.data, contextId],
  );
  const open = items.filter((i) => !isDone(i));
  const done = items.filter(isDone).sort((a, b) => (b.due_date ?? "").localeCompare(a.due_date ?? ""));
  const color = classColorHex(context?.color);

  return (
    <QueryBoundary
      isLoading={contextsQuery.isLoading || itemsQuery.isLoading}
      isError={contextsQuery.isError || itemsQuery.isError}
      error={contextsQuery.error ?? itemsQuery.error}
      onRetry={() => {
        contextsQuery.refetch();
        itemsQuery.refetch();
      }}
    >
      {!context ? (
        <EmptyState>
          Class not found. <Link to="/" className="underline">Back to Today</Link>
        </EmptyState>
      ) : (
        <div className="flex min-h-full flex-col">
          <TopBar
            actions={
              <>
                <SecondaryButton onClick={() => setEditing(true)}>
                  <Pencil />
                  Edit
                </SecondaryButton>
                <SecondaryButton
                  onClick={() => updateContext.mutate({ ...context, status: context.status === "Active" ? "Archived" : "Active" })}
                >
                  <Archive />
                  {context.status === "Active" ? "Archive" : "Restore"}
                </SecondaryButton>
              </>
            }
          >
            <Link to="/tasks?area=School" className="text-fg3 hover:text-fg2">
              School
            </Link>
            <span className="text-fg3">/</span>
            <span>{context.name}</span>
          </TopBar>

          <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-7 px-6 pb-14 pt-10 md:px-12">
            <header className="flex flex-col gap-3.5">
              <div className="flex size-12 items-center justify-center rounded-[14px]" style={{ background: tint(color, 0.14), color }}>
                <GraduationCap className="size-6" />
              </div>
              <h1 className="text-[34px] font-semibold tracking-[-0.025em]">{context.name}</h1>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-fg2">
                {context.term && <span>{context.term}</span>}
                {context.schedule && <span>{context.schedule}</span>}
                {context.owner ? (
                  <span>{context.owner}</span>
                ) : (
                  <button type="button" className="text-fg3 hover:text-fg2" onClick={() => setEditing(true)}>
                    + Add instructor
                  </button>
                )}
                {context.status === "Archived" && <span className="text-danger">Archived</span>}
              </div>
            </header>

            <Stats context={context} items={items} open={open} color={color} />

            <div role="tablist" aria-label="Class sections" className="flex gap-6 border-b border-line text-sm">
              {(["assignments", "grades", "notes"] as Tab[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    if (t === "assignments") next.delete("tab");
                    else next.set("tab", t);
                    setParams(next, { replace: true });
                  }}
                  className={cn("-mb-px h-10 border-b-2 capitalize", tab === t ? "border-foreground font-medium" : "border-transparent text-fg3 hover:text-fg2")}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === "assignments" && (
              <div className="flex flex-wrap items-start gap-8">
                <div className="flex min-w-0 flex-[999_1_460px] flex-col">
                  <InlineAdd placeholder={`Add an assignment — e.g. “Case study 3 nov 14”`} defaults={{ classId: context.id }} />
                  {open.length === 0 ? <EmptyState>No open assignments.</EmptyState> : <AssignmentTable items={open} />}
                  {done.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowDone((s) => !s)}
                        className="mt-5 flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium text-fg3 hover:text-fg2"
                      >
                        <ChevronDown className={cn("size-3.5 transition-transform", !showDone && "-rotate-90")} />
                        Completed · {done.length}
                      </button>
                      {showDone && <AssignmentTable items={done} muted />}
                    </>
                  )}
                </div>
                <div className="flex min-w-0 flex-[1_1_280px] flex-col">
                  <Panel title="Grade breakdown" action={<button type="button" onClick={() => setEditing(true)} className="hover:text-fg2">Edit weights</button>}>
                    <Breakdown context={context} items={items} color={color} />
                  </Panel>
                </div>
              </div>
            )}

            {tab === "grades" && (
              <div className="flex flex-wrap items-start gap-8">
                <div className="min-w-0 flex-[999_1_460px]">
                  {done.filter((i) => i.points_earned != null).length + open.filter((i) => i.points_earned != null).length === 0 ? (
                    <EmptyState>No graded assignments yet. Add a score from an assignment’s details.</EmptyState>
                  ) : (
                    <AssignmentTable items={items.filter((i) => i.points_earned != null)} />
                  )}
                </div>
                <div className="min-w-0 flex-[1_1_280px]">
                  <Panel title="Grade breakdown">
                    <Breakdown context={context} items={items} color={color} />
                  </Panel>
                </div>
              </div>
            )}

            {tab === "notes" && <NotesTab context={context} items={items} />}
          </div>

          <ClassDialog open={editing} onOpenChange={setEditing} context={context} />
        </div>
      )}
    </QueryBoundary>
  );
}

function Stats({ context, items, open, color }: { context: Context; items: Item[]; open: Item[]; color: string }) {
  const grade = calculateGrade(items, context, useGradeScale());
  const totalWeight = Object.values(context.grade_scale ?? {}).reduce((a, b) => a + b, 0);
  const gradedWeight = grade.categoryBreakdown.reduce((a, c) => a + c.weight, 0);
  const completed = items.length - open.length;
  const next = open.find((i) => (daysUntil(i.due_date) ?? -1) >= 0) ?? open[0];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="flex flex-col gap-1 rounded-[14px] border border-line p-[18px]">
        <span className="text-[13px] text-fg3">Current grade</span>
        <span className="text-[28px] font-semibold tracking-tight">
          {grade.currentGrade != null ? `${grade.currentGrade.toFixed(1)}%` : "—"}
        </span>
        <span className="text-[13px] text-fg2">
          {grade.currentGrade != null
            ? `${grade.letter} · ${grade.gpaPoints?.toFixed(1)} GPA · ${totalWeight ? Math.round((gradedWeight / totalWeight) * 100) : 0}% of the course graded`
            : "No graded work yet"}
        </span>
      </div>
      <div className="flex flex-col gap-1 rounded-[14px] border border-line p-[18px]">
        <span className="text-[13px] text-fg3">Assignments</span>
        <span className="text-[28px] font-semibold tracking-tight">
          {completed} <span className="text-lg font-medium text-fg3">of {items.length}</span>
        </span>
        <div className="mt-1.5 h-1.5 rounded-full bg-sunken">
          <div className="h-1.5 rounded-full" style={{ width: `${items.length ? (completed / items.length) * 100 : 0}%`, background: color }} />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-line p-[18px]">
        <span className="text-[13px] text-fg3">Next up</span>
        <span className="truncate pt-1.5 text-xl font-semibold tracking-tight">{next?.title ?? "All caught up"}</span>
        {next && (
          <span className="text-[13px] text-fg2">
            {formatDue(next, new Date(), true) || "No date"}
            {next.assignment_type && context.grade_scale?.[next.assignment_type] ? ` · ${context.grade_scale[next.assignment_type]}%` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
