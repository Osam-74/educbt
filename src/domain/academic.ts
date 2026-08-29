/**
 * Academic calculation — the deterministic core.
 *
 * NO DATABASE IMPORTS IN THIS FILE, AND NONE BELONGS HERE.
 *
 * Totals, grading, ranking and result state are the rules a school argues about.
 * They should be provable on their own — a grading boundary or a tie policy is
 * exactly the kind of thing that must be demonstrable without standing up
 * Postgres, and exactly the kind of thing a school will ask you to prove.
 *
 * Everything here takes plain values and returns plain values. The persistence
 * layer calls in; nothing here calls out.
 */

// ════════════════════════════════════════════════════════════════════════════
// Grading
// ════════════════════════════════════════════════════════════════════════════

export type Band = { min: number; grade: string; remark: string };

export type GradingScale = {
  /**
   * Identifies the scale that produced a grade.
   *
   * Stored ALONGSIDE the result. A school that revises its scale in 2027 must
   * not retroactively change a report card issued in 2026 — and without knowing
   * which scale produced a grade, nobody can later explain how a B3 was reached.
   */
  id: string;
  name: string;
  version: number;
  bands: Band[];
};

export const WAEC_NINE_POINT: GradingScale = {
  id: 'waec-9',
  name: 'WAEC nine-point scale',
  version: 1,
  bands: [
    { min: 75, grade: 'A1', remark: 'Excellent' },
    { min: 70, grade: 'B2', remark: 'Very Good' },
    { min: 65, grade: 'B3', remark: 'Good' },
    { min: 60, grade: 'C4', remark: 'Credit' },
    { min: 55, grade: 'C5', remark: 'Credit' },
    { min: 50, grade: 'C6', remark: 'Credit' },
    { min: 45, grade: 'D7', remark: 'Pass' },
    { min: 40, grade: 'E8', remark: 'Pass' },
    { min: 0, grade: 'F9', remark: 'Fail' },
  ],
};

export type GradeOutcome = {
  grade: string;
  remark: string;
  /** Written onto the result so the grade can always be explained later. */
  scaleId: string;
  scaleVersion: number;
};

export function gradeFor(total: number, scale: GradingScale = WAEC_NINE_POINT): GradeOutcome {
  // Bands are matched highest-first, so they need not be pre-sorted by the
  // caller — a school editing its scale in an admin screen will not order them.
  const ordered = [...scale.bands].sort((a, b) => b.min - a.min);
  const band = ordered.find((b) => total >= b.min);

  return {
    grade: band?.grade ?? 'F9',
    remark: band?.remark ?? 'Fail',
    scaleId: scale.id,
    scaleVersion: scale.version,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Totals
// ════════════════════════════════════════════════════════════════════════════

export type AssessmentComponent = {
  key: string;
  label: string;
  maxScore: number;
  isExam: boolean;
};

export type ComponentScore = { key: string; score: number };

export type TotalOutcome = {
  caTotal: number;
  examTotal: number;
  total: number;
  maxTotal: number;
  /** True when every component has a score. An incomplete total is not a result. */
  complete: boolean;
  missing: string[];
};

/**
 * Combine continuous assessment with the examination mark.
 *
 * `complete` matters: a student with one of six subjects scored should not be
 * shown a percentage and a Fail. The WordPress system compiled anyway and
 * produced 39% / Fail from a single entry, which parents saw.
 */
export function computeTotal(
  components: AssessmentComponent[],
  scores: ComponentScore[],
): TotalOutcome {
  const byKey = new Map(scores.map((s) => [s.key, s.score]));

  let caTotal = 0;
  let examTotal = 0;
  let maxTotal = 0;
  const missing: string[] = [];

  for (const component of components) {
    maxTotal += component.maxScore;

    const raw = byKey.get(component.key);

    if (raw === undefined) {
      missing.push(component.label);
      continue;
    }

    // A score above the component maximum is a data-entry error, not a
    // decision. Clamping here keeps one typo from producing 105%.
    const score = Math.max(0, Math.min(raw, component.maxScore));

    if (component.isExam) examTotal += score;
    else caTotal += score;
  }

  return {
    caTotal: round2(caTotal),
    examTotal: round2(examTotal),
    total: round2(caTotal + examTotal),
    maxTotal: round2(maxTotal),
    complete: missing.length === 0,
    missing,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Ranking
// ════════════════════════════════════════════════════════════════════════════

/**
 * How ties are handled. A school's choice, not the algorithm's.
 *
 *   competition  1, 2, 2, 4   the next position skips. The Nigerian default.
 *   dense        1, 2, 2, 3   no gap after a tie.
 *   ordinal      1, 2, 3, 4   ties broken by the tiebreakers below, arbitrarily
 *                             if none resolve it. Some schools require a strict
 *                             order for prizes.
 */
export type TiePolicy = 'competition' | 'dense' | 'ordinal';

/**
 * What separates two students on the same total, in order of application.
 *
 * 'exam' is the common one: a school will often rank the better examination
 * performance ahead where two totals match, on the grounds that the terminal
 * paper is the harder test.
 */
export type Tiebreaker = 'exam' | 'ca' | 'none';

export type RankingPolicy = {
  tiePolicy: TiePolicy;
  tiebreakers: Tiebreaker[];
  /**
   * Whether a student with an incomplete result is ranked at all.
   *
   * Ranking someone missing four subjects against a full cohort produces a
   * position that means nothing and a parent conversation nobody wants.
   */
  rankIncomplete: boolean;
};

export const DEFAULT_RANKING: RankingPolicy = {
  tiePolicy: 'competition',
  tiebreakers: ['exam'],
  rankIncomplete: false,
};

export type Rankable = {
  studentId: number;
  total: number;
  examTotal?: number;
  caTotal?: number;
  complete?: boolean;
};

export type RankOutcome = {
  studentId: number;
  position: number | null;
  /** Null when the policy excludes them, so the caller need not guess why. */
  excluded: boolean;
};

/**
 * Rank a cohort.
 *
 * Called ONCE, with every total already known. Ranking while students are still
 * being compiled gives a position based on however many happened to be
 * processed first — which is why positions used to change between compilations
 * of the same term.
 */
export function rank(
  rows: Rankable[],
  policy: RankingPolicy = DEFAULT_RANKING,
): RankOutcome[] {
  const eligible = policy.rankIncomplete
    ? [...rows]
    : rows.filter((r) => r.complete !== false);

  const excluded = rows
    .filter((r) => !eligible.includes(r))
    .map((r) => ({ studentId: r.studentId, position: null, excluded: true }));

  const sorted = [...eligible].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;

    for (const breaker of policy.tiebreakers) {
      if (breaker === 'exam') {
        const diff = (b.examTotal ?? 0) - (a.examTotal ?? 0);
        if (diff !== 0) return diff;
      }

      if (breaker === 'ca') {
        const diff = (b.caTotal ?? 0) - (a.caTotal ?? 0);
        if (diff !== 0) return diff;
      }
    }

    return 0;
  });

  const out: RankOutcome[] = [];
  let position = 0;
  let seen = 0;
  let previous: Rankable | null = null;

  for (const row of sorted) {
    seen++;

    const tiedWithPrevious = previous !== null && !separates(previous, row, policy);

    if (!tiedWithPrevious) {
      position = policy.tiePolicy === 'dense' ? position + 1 : seen;
    }

    // 'ordinal' gives everyone a distinct position, so a tie never shares.
    out.push({
      studentId: row.studentId,
      position: policy.tiePolicy === 'ordinal' ? seen : position,
      excluded: false,
    });

    previous = row;
  }

  return [...out, ...excluded];
}

/** Do the policy's rules distinguish these two students? */
function separates(a: Rankable, b: Rankable, policy: RankingPolicy): boolean {
  if (a.total !== b.total) return true;

  for (const breaker of policy.tiebreakers) {
    if (breaker === 'exam' && (a.examTotal ?? 0) !== (b.examTotal ?? 0)) return true;
    if (breaker === 'ca' && (a.caTotal ?? 0) !== (b.caTotal ?? 0)) return true;
  }

  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// Result lifecycle
// ════════════════════════════════════════════════════════════════════════════

/**
 * A computed result is not a published one, and a published one is not final.
 *
 *   DRAFT      marks are still being entered
 *   COMPILED   totals, grades and positions calculated — staff only
 *   REVIEWED   a human has checked it; still not visible to parents
 *   PUBLISHED  visible to students and parents
 *   LOCKED     closed for the term. Corrections need an audited unlock.
 *
 * The distinction that matters most is COMPILED vs PUBLISHED. A compiled result
 * can be recompiled freely; a published one is a historical record a family has
 * already seen, and changing it silently is how trust is lost.
 */
export type ResultState = 'draft' | 'compiled' | 'reviewed' | 'published' | 'locked';

const TRANSITIONS: Record<ResultState, ResultState[]> = {
  draft: ['compiled'],
  // Recompiling is normal while a term is still open.
  compiled: ['draft', 'compiled', 'reviewed'],
  reviewed: ['compiled', 'published'],
  // Unpublishing is possible but deliberate — see requiresReason below.
  published: ['reviewed', 'locked'],
  // Only an explicit, audited unlock reopens a locked term.
  locked: ['published'],
};

export function canTransition(from: ResultState, to: ResultState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Which moves need a written reason.
 *
 * Anything that takes a result BACK from a state a family may have seen, or
 * reopens a closed term. The reason goes to the audit log, so a corrected
 * result can always be explained a year later.
 */
export function requiresReason(from: ResultState, to: ResultState): boolean {
  if (from === 'published' && to === 'reviewed') return true;
  if (from === 'locked' && to === 'published') return true;
  if (from === 'reviewed' && to === 'compiled') return true;

  return false;
}

export function isVisibleToFamily(state: ResultState): boolean {
  return state === 'published' || state === 'locked';
}

export function isEditable(state: ResultState): boolean {
  return state === 'draft' || state === 'compiled';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
