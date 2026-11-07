import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { EmptyState, Panel, PrimaryButton, SecondaryButton, TopBar } from "@/components/lo/primitives";
import { QueryBoundary } from "@/components/QueryBoundary";
import { useContexts } from "@/hooks/useContexts";
import { useItems } from "@/hooks/useItems";
import { errorText, useIntakeBatch, useIntakeCommit, useIntakeDiscard, useIntakeUndo } from "@/hooks/usePro";
import { cn } from "@/lib/utils";
import type { IntakeBatch, IntakeCandidateRow, IntakeDecision, IntakeFlag } from "@/types";

type Action = IntakeDecision["action"];

interface RowState {
  action: Action;
  title: string;
  due_date: string;
  due_time: string;
  assignment_type: string;
}

const FLAG_TEXT: Record<IntakeFlag, string> = {
  missing_date: "No date in the syllabus",
  week_only: "Only a week number given",
  year_inferred: "Year filled in from the term",
  outside_term: "Falls outside the term",
  during_break: "Falls in a break",
  duplicate: "Already listed",
  category_unmatched: "No matching grade category",
};

/** Flags that mean "look at this row"; a filled-in year alone doesn't. */
const ATTENTION: IntakeFlag[] = ["missing_date", "week_only", "outside_term", "during_break", "duplicate", "category_unmatched"];

function initialRow(row: IntakeCandidateRow): RowState {
  const c = row.candidate;
  return {
    // Anything that looks like a duplicate starts unticked; the rest start ticked.
    action: c.flags.includes("duplicate") ? "skip" : "add",
    title: c.title,
    due_date: c.due_date ?? "",
    due_time: c.due_time ?? "",
    assignment_type: c.grade_category ?? "",
  };
}

const inputCls = "h-8 rounded-lg border border-line2 bg-card px-2 text-[13px] outline-none focus:border-ring";

function FlagChips({ row, duplicateTitle }: { row: IntakeCandidateRow; duplicateTitle?: string }) {
  const c = row.candidate;
  return (
    <div className="flex flex-wrap gap-1.5">
      {c.flags.map((f) => {
        let text = FLAG_TEXT[f];
        if (f === "duplicate") text = c.duplicate_of ? `Already in this class${duplicateTitle ? `: “${duplicateTitle}”` : ""}` : "Listed twice in the syllabus";
        if (f === "week_only" && c.week) text = `Only “Week ${c.week}” given. Add the date`;
        const strong = f !== "year_inferred";
        return (
          <span
            key={f}
            className={cn("rounded-md px-1.5 py-0.5 text-[11.5px]", strong ? "bg-danger-soft text-danger" : "bg-sunken text-fg3")}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
}

function CandidateRowView({
  row,
  state,
  onChange,
  categories,
  duplicateTitle,
}: {
  row: IntakeCandidateRow;
  state: RowState;
  onChange: (next: RowState) => void;
  categories: string[];
  duplicateTitle?: string;
}) {
  const c = row.candidate;
  const [showSource, setShowSource] = useState(false);
  const off = state.action === "skip";
  const options = Array.from(new Set([...categories, ...(state.assignment_type ? [state.assignment_type] : [])]));
  return (
    <li className={cn("flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0", off && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        {c.duplicate_of ? (
          <select
            aria-label={`What to do with ${state.title}`}
            value={state.action}
            onChange={(e) => onChange({ ...state, action: e.target.value as Action })}
            className={cn(inputCls, "w-[150px]")}
          >
            <option value="skip">Skip</option>
            <option value="merge">Update existing</option>
            <option value="add">Add as new</option>
          </select>
        ) : (
          <input
            type="checkbox"
            aria-label={`Add ${state.title}`}
            checked={!off}
            onChange={(e) => onChange({ ...state, action: e.target.checked ? "add" : "skip" })}
            className="size-4 accent-[var(--color-brand)]"
          />
        )}
        <input
          aria-label="Title"
          value={state.title}
          onChange={(e) => onChange({ ...state, title: e.target.value })}
          className={cn(inputCls, "min-w-[180px] flex-1 text-[13.5px] font-medium")}
        />
        <input
          type="date"
          aria-label="Due date"
          value={state.due_date}
          onChange={(e) => onChange({ ...state, due_date: e.target.value })}
          className={cn(inputCls, "w-[140px]", !state.due_date && "text-fg3")}
        />
        <input
          type="time"
          aria-label="Due time"
          value={state.due_time}
          disabled={!state.due_date}
          onChange={(e) => onChange({ ...state, due_time: e.target.value })}
          className={cn(inputCls, "w-[100px]")}
        />
        <select
          aria-label="Grade category"
          value={state.assignment_type}
          onChange={(e) => onChange({ ...state, assignment_type: e.target.value })}
          className={cn(inputCls, "w-[150px]")}
        >
          <option value="">No category</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {c.weight_percent != null && <span className="font-mono text-[12px] text-fg3">{c.weight_percent}%</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6">
        <FlagChips row={row} duplicateTitle={duplicateTitle} />
        <button type="button" onClick={() => setShowSource((s) => !s)} className="flex items-center gap-1 text-[12px] text-fg3 hover:text-fg2">
          <ChevronDown className={cn("size-3 transition-transform", !showSource && "-rotate-90")} />
          Source
        </button>
      </div>
      {showSource && (
        <blockquote className="ml-6 border-l-2 border-line2 pl-3 text-[12.5px] italic text-fg2">
          “{c.source_text}”{c.notes && <span className="not-italic text-fg3"> · {c.notes}</span>}
        </blockquote>
      )}
    </li>
  );
}

function SavedSummary({ batch }: { batch: IntakeBatch }) {
  const undo = useIntakeUndo();
  const added = batch.candidates.filter((c) => c.decision === "added").length;
  const merged = batch.candidates.filter((c) => c.decision === "merged").length;
  return (
    <Panel title={batch.file_name}>
      <p className="text-[13.5px] text-fg2">
        {batch.status === "committed" && `Saved ${new Date(batch.committed_at!).toLocaleString()}: ${added} added, ${merged} updated.`}
        {batch.status === "undone" && `Undone ${new Date(batch.undone_at!).toLocaleString()}.`}
        {batch.status === "discarded" && "Discarded without adding anything."}
      </p>
      {batch.status === "committed" && (
        <div>
          <SecondaryButton onClick={() => undo.mutate(batch.id)} disabled={undo.isPending}>
            {undo.isPending ? "Undoing…" : "Undo this import"}
          </SecondaryButton>
          {undo.error && <p className="mt-2 text-[13px] text-danger">{errorText(undo.error)}</p>}
        </div>
      )}
    </Panel>
  );
}

export default function ImportReview() {
  const { contextId, batchId } = useParams();
  const navigate = useNavigate();
  const batchQuery = useIntakeBatch(batchId);
  const contextsQuery = useContexts();
  const { data: items } = useItems();
  const commit = useIntakeCommit();
  const discard = useIntakeDiscard();
  const batch = batchQuery.data;
  const context = contextsQuery.data?.find((c) => c.id === contextId);

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [applyInstructor, setApplyInstructor] = useState(false);
  const [applyWeights, setApplyWeights] = useState(false);

  useEffect(() => {
    if (!batch || !context) return;
    setRows(Object.fromEntries(batch.candidates.map((r) => [r.id, initialRow(r)])));
    setApplyInstructor(!!batch.course.instructor && !context.owner);
    setApplyWeights(batch.course.grade_weights.length > 0 && Object.keys(context.grade_scale ?? {}).length === 0);
  }, [batch?.id, context?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- seed once per import

  const titleById = useMemo(() => new Map((items ?? []).map((i) => [i.id, i.title])), [items]);
  const categories = useMemo(() => {
    const fromClass = Object.keys(context?.grade_scale ?? {});
    const fromSyllabus = applyWeights || fromClass.length === 0 ? (batch?.course.grade_weights ?? []).map((w) => w.category) : [];
    return Array.from(new Set([...(applyWeights ? fromSyllabus : fromClass), ...fromSyllabus]));
  }, [context, batch, applyWeights]);

  const candidates = batch?.candidates ?? [];
  const attention = candidates.filter((r) => r.candidate.flags.some((f) => ATTENTION.includes(f)));
  const ready = candidates.filter((r) => !attention.includes(r));
  const chosen = Object.values(rows).filter((r) => r.action !== "skip" && r.title.trim()).length;

  const save = () => {
    if (!batch) return;
    const decisions: IntakeDecision[] = batch.candidates.map((r) => {
      const s = rows[r.id] ?? initialRow(r);
      return {
        candidate_id: r.id,
        action: s.title.trim() ? s.action : "skip",
        title: s.title.trim(),
        due_date: s.due_date || null,
        due_time: s.due_date && s.due_time ? s.due_time : null,
        assignment_type: s.assignment_type || null,
      };
    });
    commit.mutate(
      { batchId: batch.id, decisions, apply: { instructor: applyInstructor, grade_weights: applyWeights } },
      { onSuccess: () => navigate(`/school/${batch.context_id}`) },
    );
  };

  const renderList = (list: IntakeCandidateRow[]) => (
    <ul className="flex flex-col rounded-[14px] border border-line">
      {list.map((r) => (
        <CandidateRowView
          key={r.id}
          row={r}
          state={rows[r.id] ?? initialRow(r)}
          onChange={(next) => setRows((all) => ({ ...all, [r.id]: next }))}
          categories={categories}
          duplicateTitle={r.candidate.duplicate_of ? titleById.get(r.candidate.duplicate_of) : undefined}
        />
      ))}
    </ul>
  );

  return (
    <QueryBoundary
      isLoading={batchQuery.isLoading || contextsQuery.isLoading}
      isError={batchQuery.isError || contextsQuery.isError}
      error={batchQuery.error ?? contextsQuery.error}
      onRetry={() => {
        batchQuery.refetch();
        contextsQuery.refetch();
      }}
    >
      {!batch || !context ? (
        <EmptyState>
          Import not found. <Link to="/" className="underline">Back to Today</Link>
        </EmptyState>
      ) : (
        <div className="flex min-h-full flex-col">
          <TopBar>
            <Link to={`/school/${context.id}`} className="text-fg3 hover:text-fg2">
              {context.name}
            </Link>
            <span className="text-fg3">/</span>
            <span>Review import</span>
          </TopBar>

          <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-6 px-6 pb-28 pt-10 md:px-12">
            <header className="flex flex-col gap-1.5">
              <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Review {batch.file_name}</h1>
              <p className="text-sm text-fg2">
                {candidates.length} found
                {attention.length > 0 && ` · ${attention.length} need a look`} · read with {batch.model.includes("haiku") ? "Haiku 5.5" : "Sonnet 5.5"}
                {batch.usage.estimated_cost_cents > 0 && ` · about ${batch.usage.estimated_cost_cents.toFixed(1)}¢ on your Anthropic account`}
              </p>
            </header>

            {batch.status !== "review" ? (
              <SavedSummary batch={batch} />
            ) : (
              <div className="flex flex-wrap items-start gap-8">
                <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
                  {candidates.length === 0 && <EmptyState>No deliverables were found in this file.</EmptyState>}
                  {attention.length > 0 && (
                    <section className="flex flex-col gap-2">
                      <h2 className="ml-1 text-[13px] font-medium text-fg3">Needs a look</h2>
                      {renderList(attention)}
                    </section>
                  )}
                  {ready.length > 0 && (
                    <section className="flex flex-col gap-2">
                      <h2 className="ml-1 text-[13px] font-medium text-fg3">Ready</h2>
                      {renderList(ready)}
                    </section>
                  )}
                </div>

                <div className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
                  <Panel title="From the syllabus">
                    <div className="flex flex-col gap-3 text-[13.5px]">
                      {(batch.course.course_code || batch.course.course_title) && (
                        <p className="text-fg2">{[batch.course.course_code, batch.course.course_title].filter(Boolean).join(" · ")}</p>
                      )}
                      {batch.course.term_start && batch.course.term_end && (
                        <p className="text-fg2">
                          Term {batch.course.term_start} to {batch.course.term_end}
                        </p>
                      )}
                      {batch.course.breaks.map((b) => (
                        <p key={b.label + b.start} className="text-fg2">
                          {b.label}: {b.start}
                          {b.end !== b.start && ` to ${b.end}`}
                        </p>
                      ))}
                      {batch.course.instructor && (
                        <label className="flex items-start gap-2">
                          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand)]" checked={applyInstructor} onChange={(e) => setApplyInstructor(e.target.checked)} />
                          <span>
                            Set instructor to <span className="font-medium">{batch.course.instructor}</span>
                            {context.owner && <span className="text-fg3"> (now {context.owner})</span>}
                          </span>
                        </label>
                      )}
                      {batch.course.grade_weights.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <label className="flex items-start gap-2">
                            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand)]" checked={applyWeights} onChange={(e) => setApplyWeights(e.target.checked)} />
                            <span>
                              Use these grade weights
                              {Object.keys(context.grade_scale ?? {}).length > 0 && <span className="text-fg3"> (replaces the current ones)</span>}
                            </span>
                          </label>
                          <ul className="ml-6 flex flex-col gap-1 text-fg2">
                            {batch.course.grade_weights.map((w) => (
                              <li key={w.category} className="flex justify-between gap-3">
                                <span>{w.category}</span>
                                <span className="font-mono text-[12.5px]">{w.weight_percent}%</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </Panel>
                  <p className="ml-1 text-[12.5px] leading-snug text-fg3">
                    Check each row against the source before saving. Nothing is added to {context.name} until you press Add, and the whole import can be undone later.
                  </p>
                </div>
              </div>
            )}
          </div>

          {batch.status === "review" && (
            <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-background/95 px-7 py-3 backdrop-blur">
              {(commit.error || discard.error) && <span className="mr-auto text-[13px] text-danger">{errorText(commit.error ?? discard.error)}</span>}
              <SecondaryButton
                disabled={discard.isPending || commit.isPending}
                onClick={() => discard.mutate(batch.id, { onSuccess: () => navigate(`/school/${batch.context_id}`) })}
              >
                Discard
              </SecondaryButton>
              <PrimaryButton onClick={save} disabled={commit.isPending || (chosen === 0 && !applyInstructor && !applyWeights)}>
                {commit.isPending ? "Adding…" : chosen === 1 ? "Add 1 item" : `Add ${chosen} items`}
              </PrimaryButton>
            </div>
          )}
        </div>
      )}
    </QueryBoundary>
  );
}
