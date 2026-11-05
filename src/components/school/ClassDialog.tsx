import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import { ColorSwatchPicker } from "@/components/ColorSwatchPicker";
import { PrimaryButton, SecondaryButton } from "@/components/lo/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { GradeScaleEditor } from "@/components/school/GradeScaleEditor";
import { Switch } from "@/components/ui/switch";
import { useCreateContext, useUpdateContext } from "@/hooks/useContexts";
import { useGradeScale } from "@/hooks/usePreferences";
import { effectiveScale, type GradeBand } from "@/lib/gradeScale";
import type { Context } from "@/types";

const DEFAULT_GRADE_SCALE: [string, number][] = [
  ["Homework", 20],
  ["Quiz", 20],
  ["Exam", 40],
  ["Project", 20],
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] text-fg3">
      {label}
      {children}
    </label>
  );
}

/** Create or edit a class. One dialog for both, opened from the sidebar's + and a class page's Edit. */
export function ClassDialog({
  open,
  onOpenChange,
  context,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context?: Context;
}) {
  const navigate = useNavigate();
  const createContext = useCreateContext();
  const updateContext = useUpdateContext();
  const [name, setName] = useState("");
  const [term, setTerm] = useState("");
  const [schedule, setSchedule] = useState("");
  const [owner, setOwner] = useState("");
  const [color, setColor] = useState<string | null>("blue");
  const [scale, setScale] = useState<[string, number][]>(DEFAULT_GRADE_SCALE);
  const schoolScale = useGradeScale();
  const [cutoffs, setCutoffs] = useState<GradeBand[] | null>(null); // null = use the school scale

  useEffect(() => {
    if (!open) return;
    setName(context?.name ?? "");
    setTerm(context?.term ?? "");
    setSchedule(context?.schedule ?? "");
    setOwner(context?.owner ?? "");
    setColor(context?.color ?? "blue");
    setScale(context ? Object.entries(context.grade_scale ?? {}) : DEFAULT_GRADE_SCALE);
    setCutoffs(context?.grade_cutoffs && Object.keys(context.grade_cutoffs).length ? effectiveScale(context, schoolScale) : null);
  }, [open, context]); // eslint-disable-line react-hooks/exhaustive-deps -- schoolScale only seeds the editor when the dialog opens

  const total = scale.reduce((sum, [, w]) => sum + (Number.isFinite(w) ? w : 0), 0);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const fields = {
      name: name.trim(),
      term: term.trim() || null,
      schedule: schedule.trim() || null,
      owner: owner.trim() || null,
      color,
      grade_scale: Object.fromEntries(scale.filter(([k]) => k.trim()).map(([k, w]) => [k.trim(), w])),
      grade_cutoffs: cutoffs && cutoffs.some((b) => b.letter.trim()) ? Object.fromEntries(cutoffs.filter((b) => b.letter.trim()).map((b) => [b.letter.trim(), b.min])) : null,
    };
    if (context) {
      await updateContext.mutateAsync({ ...context, ...fields });
    } else {
      const created = await createContext.mutateAsync({ type: "Class", ...fields });
      navigate(`/school/${created.id}`);
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{context ? "Edit class" : "New class"}</DialogTitle>
            <DialogDescription>Classes appear under School in the sidebar.</DialogDescription>
          </DialogHeader>

          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro to Biology" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Term">
              <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Fall 2026" />
            </Field>
            <Field label="Schedule">
              <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="Mon, Wed · 10:00–11:50" />
            </Field>
          </div>
          <Field label="Instructor">
            <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Optional" />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-fg3">Color</span>
            <ColorSwatchPicker value={color} onChange={setColor} />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-fg3">Grade weights</span>
              <span className={total === 100 ? "text-xs text-fg3" : "text-xs text-danger"}>{total}% of 100%</span>
            </div>
            <div className="space-y-1.5">
              {scale.map(([key, weight], i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label="Assignment type"
                    value={key}
                    onChange={(e) => setScale(scale.map((row, j) => (j === i ? [e.target.value, row[1]] : row)))}
                  />
                  <Input
                    aria-label="Weight percent"
                    type="number"
                    className="w-24 shrink-0"
                    value={weight}
                    onChange={(e) => setScale(scale.map((row, j) => (j === i ? [row[0], Number(e.target.value)] : row)))}
                  />
                  <span className="text-sm text-fg3">%</span>
                  <button
                    type="button"
                    aria-label={`Remove ${key || "row"}`}
                    onClick={() => setScale(scale.filter((_, j) => j !== i))}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-fg3 hover:bg-hover"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setScale([...scale, ["", 0]])}
              className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-fg2 hover:bg-hover"
            >
              <Plus className="size-3.5" />
              Add type
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] text-fg3">Letter grades</span>
              <label className="flex items-center gap-2 text-xs text-fg3">
                Custom for this class
                <Switch aria-label="Custom letter grades" checked={cutoffs !== null} onCheckedChange={(c) => setCutoffs(c ? schoolScale : null)} />
              </label>
            </div>
            {cutoffs ? (
              <GradeScaleEditor value={cutoffs} onChange={setCutoffs} showPoints={false} />
            ) : (
              <p className="text-xs text-fg3">Uses the school scale from Settings → School.</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <SecondaryButton onClick={() => onOpenChange(false)}>Cancel</SecondaryButton>
            <PrimaryButton type="submit" disabled={!name.trim() || createContext.isPending || updateContext.isPending}>
              {context ? "Save" : "Create class"}
            </PrimaryButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
