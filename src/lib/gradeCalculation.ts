import { bandFor, DEFAULT_GRADE_SCALE, effectiveScale, type GradeBand } from "@/lib/gradeScale";
import type { Context, Item } from "@/types";

export interface CategoryBreakdown {
  category: string;
  percent: number;
  weight: number;
  itemCount: number;
}

export interface GradeResult {
  currentGrade: number | null;
  letter: string | null;
  gpaPoints: number | null;
  categoryBreakdown: CategoryBreakdown[];
}


/**
 * Spec §7.3:
 * 1. Group graded Items (points_earned not null) by assignment_type.
 * 2. category_percent = sum(points_earned) / sum(points_possible) per group.
 * 3. current_grade = weighted average of category_percent by grade_scale weight,
 *    excluding categories with zero graded items from the denominator.
 * 4. Map current_grade to a letter using grade_cutoffs.
 */
export function calculateGrade(items: Item[], context: Context, schoolScale: GradeBand[] = DEFAULT_GRADE_SCALE): GradeResult {
  const gradeScale = context.grade_scale ?? {};

  const byCategory = new Map<string, { earned: number; possible: number; count: number }>();
  for (const item of items) {
    if (item.points_earned == null || !item.assignment_type) continue;
    const entry = byCategory.get(item.assignment_type) ?? { earned: 0, possible: 0, count: 0 };
    entry.earned += item.points_earned;
    entry.possible += item.points_possible ?? 0;
    entry.count += 1;
    byCategory.set(item.assignment_type, entry);
  }

  let weightedSum = 0;
  let weightTotal = 0;
  const categoryBreakdown: CategoryBreakdown[] = [];

  for (const [category, weight] of Object.entries(gradeScale)) {
    const entry = byCategory.get(category);
    if (!entry || entry.count === 0) continue;
    const percent = entry.possible > 0 ? (entry.earned / entry.possible) * 100 : 0;
    weightedSum += percent * weight;
    weightTotal += weight;
    categoryBreakdown.push({ category, percent, weight, itemCount: entry.count });
  }

  if (weightTotal === 0) {
    return { currentGrade: null, letter: null, gpaPoints: null, categoryBreakdown };
  }

  const currentGrade = weightedSum / weightTotal;
  const band = bandFor(currentGrade, effectiveScale(context, schoolScale));
  return { currentGrade, letter: band?.letter ?? "F", gpaPoints: band?.points ?? 0, categoryBreakdown };
}
