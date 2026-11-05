import type { Context } from "@/types";

/** One letter grade: the lowest percent that earns it, and its GPA points. */
export interface GradeBand {
  letter: string;
  min: number;
  points: number;
}

export const GRADE_SCALE_PREF_KEY = "grade_scale";

// Matches the cutoffs the app used before the scale became editable.
export const DEFAULT_GRADE_SCALE: GradeBand[] = [
  { letter: "A", min: 90, points: 4 },
  { letter: "B", min: 80, points: 3 },
  { letter: "C", min: 70, points: 2 },
  { letter: "D", min: 60, points: 1 },
  { letter: "F", min: 0, points: 0 },
];

export const PLUS_MINUS_GRADE_SCALE: GradeBand[] = [
  { letter: "A+", min: 97, points: 4.0 },
  { letter: "A", min: 93, points: 4.0 },
  { letter: "A-", min: 90, points: 3.7 },
  { letter: "B+", min: 87, points: 3.3 },
  { letter: "B", min: 83, points: 3.0 },
  { letter: "B-", min: 80, points: 2.7 },
  { letter: "C+", min: 77, points: 2.3 },
  { letter: "C", min: 73, points: 2.0 },
  { letter: "C-", min: 70, points: 1.7 },
  { letter: "D+", min: 67, points: 1.3 },
  { letter: "D", min: 63, points: 1.0 },
  { letter: "D-", min: 60, points: 0.7 },
  { letter: "F", min: 0, points: 0 },
];

const byMinDesc = (a: GradeBand, b: GradeBand) => b.min - a.min;

/** Reads the school-wide scale pref; anything missing or malformed falls back to the default. */
export function parseGradeScale(raw: string | undefined): GradeBand[] {
  if (!raw) return DEFAULT_GRADE_SCALE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_GRADE_SCALE;
    const bands = parsed.filter(
      (b): b is GradeBand =>
        !!b && typeof b.letter === "string" && b.letter.trim() !== "" && Number.isFinite(b.min) && Number.isFinite(b.points),
    );
    return bands.length ? [...bands].sort(byMinDesc) : DEFAULT_GRADE_SCALE;
  } catch {
    return DEFAULT_GRADE_SCALE;
  }
}

/**
 * A class's own cutoffs (letter → min percent) override the school scale.
 * ponytail: overrides store no GPA points, so they come from the school scale by letter (0 if absent).
 */
export function effectiveScale(context: Context, school: GradeBand[]): GradeBand[] {
  const own = Object.entries(context.grade_cutoffs ?? {});
  if (own.length === 0) return school;
  return own
    .map(([letter, min]) => ({ letter, min, points: school.find((b) => b.letter === letter)?.points ?? 0 }))
    .sort(byMinDesc);
}

/** The band a percent falls in, or null when it's below every cutoff. */
export function bandFor(percent: number, bands: GradeBand[]): GradeBand | null {
  return [...bands].sort(byMinDesc).find((b) => percent >= b.min) ?? null;
}
