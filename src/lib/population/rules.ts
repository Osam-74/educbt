/**
 * Enrolled students by class and gender, for the dashboard chart. Rules only (no database, no drawing), so each one is
 * easy to prove. Ported from the plugin's PopulationService and its chart.
 *
 * Only students ENROLLED in the CURRENT session count, because the chart answers "how many students do we have in each
 * class right now". A blank or unrecognised gender is counted as "not stated", never dropped, so the bars always add up
 * to the school's real enrolment.
 */

export type Gender = 'male' | 'female' | 'unknown';

/** Male, female or not stated, however it was typed or imported ("Male", " F ", "m", "FEMALE", "girl"). */
export function normaliseGender(raw: string | null | undefined): Gender {
  const g = (raw ?? '').trim().toLowerCase();
  if (g === 'male' || g === 'm' || g === 'boy') return 'male';
  if (g === 'female' || g === 'f' || g === 'girl') return 'female';
  return 'unknown';
}

export type PopulationRow = { classId: number; className: string; gender: string | null; n: number };
export type ClassPopulation = { classId: number; name: string; male: number; female: number; unknown: number; total: number };

/** One row per (class, stored gender) becomes one entry per class, in the order the classes first appear. */
export function fold(rows: PopulationRow[]): ClassPopulation[] {
  const out = new Map<number, ClassPopulation>();
  for (const r of rows) {
    const id = Number(r.classId);
    let c = out.get(id);
    if (!c) { c = { classId: id, name: r.className, male: 0, female: 0, unknown: 0, total: 0 }; out.set(id, c); }
    const n = Math.max(0, Math.trunc(Number(r.n) || 0));
    c[normaliseGender(r.gender)] += n;
    c.total += n;
  }
  return [...out.values()];
}

export function totals(classes: ClassPopulation[]): { male: number; female: number; unknown: number; total: number } {
  const t = { male: 0, female: 0, unknown: 0, total: 0 };
  for (const c of classes) { t.male += c.male; t.female += c.female; t.unknown += c.unknown; t.total += c.total; }
  return t;
}

/** A "nice" top for the axis (5, 10, 20, 25, 50, 100 ...) so the tallest bar never touches the roof. */
export function axisTop(max: number): number {
  const m = Math.max(1, Math.ceil(max));
  for (const step of [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) if (step >= m) return step;
  return Math.ceil(m / 100) * 100;
}

/** Long class names are shortened on the axis only; the tooltip and the screen-reader table keep the full name. */
export const LABEL_MAX = 22;
export function shortLabel(name: string, max = LABEL_MAX): string {
  const chars = [...name];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : name;
}

/** The sentence a screen reader hears for one bar. */
export function barLabel(c: ClassPopulation): string {
  return `${c.name}: ${c.total} student${c.total === 1 ? '' : 's'}, ${c.male} male, ${c.female} female${c.unknown ? `, ${c.unknown} not stated` : ''}`;
}
