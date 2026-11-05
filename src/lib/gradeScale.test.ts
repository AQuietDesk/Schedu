import { describe, expect, it } from "vitest";
import { bandFor, DEFAULT_GRADE_SCALE, effectiveScale, parseGradeScale } from "./gradeScale";
import type { Context } from "@/types";

const ctx = (grade_cutoffs: Record<string, number> | null) => ({ grade_cutoffs }) as Context;
const plusMinus = [
  { letter: "A+", min: 97, points: 4.3 },
  { letter: "A", min: 93, points: 4 },
  { letter: "B-", min: 80, points: 2.7 },
];

describe("grade scale", () => {
  it("falls back to default on missing or bad pref", () => {
    expect(parseGradeScale(undefined)).toBe(DEFAULT_GRADE_SCALE);
    expect(parseGradeScale("nope")).toBe(DEFAULT_GRADE_SCALE);
  });
  it("maps percent to the right band", () => {
    expect(bandFor(97, plusMinus)?.letter).toBe("A+");
    expect(bandFor(85, plusMinus)?.letter).toBe("B-");
    expect(bandFor(10, plusMinus)).toBeNull();
  });
  it("class cutoffs override the school scale, points by letter", () => {
    const scale = effectiveScale(ctx({ A: 85, B: 70 }), plusMinus);
    expect(scale.map((b) => b.letter)).toEqual(["A", "B"]);
    expect(scale[0].points).toBe(4);
    expect(effectiveScale(ctx(null), plusMinus)).toBe(plusMinus);
  });
});
