import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { GradeBand } from "@/lib/gradeScale";

/** Editable letter-grade rows: letter, lowest percent that earns it, and (optionally) GPA points. */
export function GradeScaleEditor({ value, onChange, showPoints = true }: { value: GradeBand[]; onChange: (next: GradeBand[]) => void; showPoints?: boolean }) {
  const patch = (i: number, change: Partial<GradeBand>) => onChange(value.map((b, j) => (j === i ? { ...b, ...change } : b)));
  return (
    <div className="flex flex-col gap-1.5">
      {value.map((b, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input aria-label="Letter" className="w-20 shrink-0" value={b.letter} onChange={(e) => patch(i, { letter: e.target.value })} />
          <span className="text-sm text-fg3">from</span>
          <Input aria-label="Minimum percent" type="number" className="w-20 shrink-0" value={b.min} onChange={(e) => patch(i, { min: Number(e.target.value) })} />
          <span className="text-sm text-fg3">%</span>
          {showPoints && (
            <>
              <Input aria-label="GPA points" type="number" step="0.1" className="w-20 shrink-0" value={b.points} onChange={(e) => patch(i, { points: Number(e.target.value) })} />
              <span className="text-sm text-fg3">pts</span>
            </>
          )}
          <button
            type="button"
            aria-label={`Remove ${b.letter || "row"}`}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-lg text-fg3 hover:bg-hover"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...value, { letter: "", min: 0, points: 0 }])}
        className="inline-flex w-fit items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-fg2 hover:bg-hover"
      >
        <Plus className="size-3.5" />
        Add grade
      </button>
    </div>
  );
}
