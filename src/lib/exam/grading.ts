/**
 * The grading scale.
 *
 * Deliberately free of database imports so it can be reasoned about, and tested,
 * on its own. A grading boundary is the kind of thing that should be provable
 * without standing up a database.
 *
 * Bands are the WAEC nine-point scale. A school may override them, but the
 * override is stored per school and applied at COMPILATION time — the computed
 * grade is then written onto the result row, so editing the scale next term
 * cannot rewrite a report card already issued.
 */

export type Band = { min: number; grade: string; remark: string };

export const DEFAULT_SCALE: Band[] = [
  { min: 75, grade: 'A1', remark: 'Excellent' },
  { min: 70, grade: 'B2', remark: 'Very Good' },
  { min: 65, grade: 'B3', remark: 'Good' },
  { min: 60, grade: 'C4', remark: 'Credit' },
  { min: 55, grade: 'C5', remark: 'Credit' },
  { min: 50, grade: 'C6', remark: 'Credit' },
  { min: 45, grade: 'D7', remark: 'Pass' },
  { min: 40, grade: 'E8', remark: 'Pass' },
  { min: 0, grade: 'F9', remark: 'Fail' },
];

export function gradeFor(total: number, scale: Band[] = DEFAULT_SCALE): { grade: string; remark: string } {
  const band = scale.find((b) => total >= b.min);
  return { grade: band?.grade ?? 'F9', remark: band?.remark ?? 'Fail' };
}

/**
 * Rank a cohort, sharing positions on equal totals.
 *
 * Ranked in one pass AFTER every total is known. Ranking as results are computed
 * gives a position based on however many students happened to be processed
 * first, which is why the WordPress version produced positions that changed
 * between compilations.
 */
export function positions(
  totals: Array<{ studentId: number; total: number }>,
): Map<number, number> {
  const ranked = [...totals].sort((a, b) => b.total - a.total);
  const out = new Map<number, number>();

  // 1st, 2nd, 2nd, 4th — the position after a tie skips, as a school expects.
  ranked.forEach((row) => {
    out.set(row.studentId, ranked.findIndex((r) => r.total === row.total) + 1);
  });

  return out;
}

/** A mark outside the question's range is a typo, not a decision. */
export function marksWithinBounds(marks: number, max: number): boolean {
  return Number.isFinite(marks) && marks >= 0 && marks <= max;
}
