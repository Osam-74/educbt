/**
 * Domain verification — NO DATABASE.
 *
 *   npm run test:domain
 *
 * Runs in under a second with no Postgres, no connection string, no fixtures.
 * That is the point: a grading boundary or a tie policy is what a school will
 * challenge, and it should be answerable on a laptop with no environment.
 */

import {
  gradeFor, WAEC_NINE_POINT, computeTotal, rank, DEFAULT_RANKING,
  canTransition, requiresReason, isVisibleToFamily, isEditable,
  type GradingScale, type RankingPolicy,
} from './academic';

let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

// ── Grading ──────────────────────────────────────────────────────────────────
check('75 is A1', gradeFor(75).grade === 'A1');
check('74 is B2 — the boundary is inclusive at its minimum only', gradeFor(74).grade === 'B2');
check('40 is E8, a pass', gradeFor(40).grade === 'E8' && gradeFor(40).remark === 'Pass');
check('39 is F9, a fail', gradeFor(39).grade === 'F9');
check('0 does not fall through', gradeFor(0).grade === 'F9');
check('100 is A1', gradeFor(100).grade === 'A1');

const outcome = gradeFor(72);
check(
  'the grade carries its scale id and version',
  outcome.scaleId === 'waec-9' && outcome.scaleVersion === 1,
  'without it, nobody can later explain how a B2 was reached',
);

// A school scale supplied out of order must still work — an admin screen will
// not sort bands for us.
const unordered: GradingScale = {
  id: 'house', name: 'House scale', version: 3,
  bands: [
    { min: 0, grade: 'F', remark: 'Fail' },
    { min: 80, grade: 'A', remark: 'Excellent' },
    { min: 50, grade: 'C', remark: 'Pass' },
  ],
};

check('an unsorted scale still grades correctly', gradeFor(85, unordered).grade === 'A');
check('an unsorted scale picks the right lower band', gradeFor(55, unordered).grade === 'C');
check('a custom scale reports its own version', gradeFor(85, unordered).scaleVersion === 3);

// ── Totals ───────────────────────────────────────────────────────────────────
const components = [
  { key: 'ca1', label: 'First CA', maxScore: 20, isExam: false },
  { key: 'ca2', label: 'Second CA', maxScore: 20, isExam: false },
  { key: 'exam', label: 'Examination', maxScore: 60, isExam: true },
];

const full = computeTotal(components, [
  { key: 'ca1', score: 18 }, { key: 'ca2', score: 15 }, { key: 'exam', score: 45 },
]);

check('CA and exam are separated', full.caTotal === 33 && full.examTotal === 45);
check('the total is their sum', full.total === 78);
check('the maximum comes from the components', full.maxTotal === 100);
check('a full set of scores is complete', full.complete);

const partial = computeTotal(components, [{ key: 'ca1', score: 18 }]);

check('a partial result is NOT complete', !partial.complete);
check('the missing components are named', partial.missing.length === 2, partial.missing.join(', '));

const over = computeTotal(components, [
  { key: 'ca1', score: 999 }, { key: 'ca2', score: 20 }, { key: 'exam', score: 60 },
]);

check(
  'a score above the component maximum is clamped',
  over.caTotal === 40 && over.total === 100,
  'one typo would otherwise produce 105%',
);

// ── Ranking ──────────────────────────────────────────────────────────────────
const cohort = [
  { studentId: 1, total: 80, examTotal: 50, complete: true },
  { studentId: 2, total: 72, examTotal: 45, complete: true },
  { studentId: 3, total: 72, examTotal: 40, complete: true },
  { studentId: 4, total: 65, examTotal: 35, complete: true },
];

const noBreaker: RankingPolicy = { tiePolicy: 'competition', tiebreakers: ['none'], rankIncomplete: false };
const competition = rank(cohort, noBreaker);
const posOf = (rows: ReturnType<typeof rank>, id: number) =>
  rows.find((r) => r.studentId === id)?.position;

check('competition: highest is 1st', posOf(competition, 1) === 1);
check('competition: equal totals share 2nd', posOf(competition, 2) === 2 && posOf(competition, 3) === 2);
check('competition: the next position skips to 4th', posOf(competition, 4) === 4);

const dense = rank(cohort, { ...noBreaker, tiePolicy: 'dense' });
check('dense: no gap after a tie — 1, 2, 2, 3', posOf(dense, 4) === 3);

const ordinal = rank(cohort, { ...noBreaker, tiePolicy: 'ordinal' });
check('ordinal: every position is distinct', new Set(ordinal.map((r) => r.position)).size === 4);

// The exam tiebreaker separates students the total cannot.
const broken = rank(cohort, DEFAULT_RANKING);
check(
  'the exam tiebreaker separates equal totals',
  posOf(broken, 2) === 2 && posOf(broken, 3) === 3,
  'the better examination is ranked ahead',
);

// Incomplete results
const withIncomplete = [...cohort, { studentId: 5, total: 30, examTotal: 20, complete: false }];
const excludedRun = rank(withIncomplete, DEFAULT_RANKING);
const five = excludedRun.find((r) => r.studentId === 5);

check(
  'an incomplete result is NOT RANKED, not zero',
  five?.state === 'not_ranked' && five?.position === null,
  'a report card showing "0 of 32" reads as last place, not as unassessed',
);
check('the reason for exclusion is stated', five?.reason === 'incomplete');
check('excluding does not shift the others', posOf(excludedRun, 1) === 1);

const includedRun = rank(withIncomplete, { ...DEFAULT_RANKING, rankIncomplete: true });
check('a school may choose to rank incomplete results', includedRun.every((r) => r.state === 'ranked'));

// ── Deterministic ordering ───────────────────────────────────────────────────
// Two students identical on total AND every tiebreaker. The order must not
// depend on the order rows arrived in.
const identical = [
  { studentId: 9, total: 60, examTotal: 30, caTotal: 30, complete: true, admissionNumber: '2026010010' },
  { studentId: 8, total: 60, examTotal: 30, caTotal: 30, complete: true, admissionNumber: '2026010009' },
];

const ordinalPolicy: RankingPolicy = { tiePolicy: 'ordinal', tiebreakers: ['exam'], rankIncomplete: false };
const forward = rank(identical, ordinalPolicy);
const reversed = rank([...identical].reverse(), ordinalPolicy);

check(
  'ordinal ordering does not depend on input order',
  posOf(forward, 8) === posOf(reversed, 8) && posOf(forward, 9) === posOf(reversed, 9),
  'otherwise two compilations of one term rank differently',
);

check(
  'the lower admission number comes first',
  posOf(forward, 8) === 1 && posOf(forward, 9) === 2,
  '2026010009 before 2026010010',
);

check(
  'admission numbers compare numerically, not as text',
  posOf(rank([
    { studentId: 1, total: 50, complete: true, admissionNumber: '100' },
    { studentId: 2, total: 50, complete: true, admissionNumber: '99' },
  ], ordinalPolicy), 2) === 1,
  '99 before 100, not "100" before "99"',
);

check('an empty cohort ranks without error', rank([], DEFAULT_RANKING).length === 0);
check('a single student is 1st', posOf(rank([cohort[0]!], DEFAULT_RANKING), 1) === 1);

// ── Lifecycle ────────────────────────────────────────────────────────────────
check('draft compiles', canTransition('draft', 'compiled'));
check('compiled may be recompiled', canTransition('compiled', 'compiled'));
check('compiled is reviewed before publication', canTransition('compiled', 'reviewed'));
check('compiled cannot skip straight to published', !canTransition('compiled', 'published'));
check('reviewed publishes', canTransition('reviewed', 'published'));
check('published locks', canTransition('published', 'locked'));
check('locked cannot silently return to draft', !canTransition('locked', 'draft'));

check('unpublishing needs a written reason', requiresReason('published', 'reviewed'));
check('unlocking needs a written reason', requiresReason('locked', 'published'));
check('compiling a draft needs no reason', !requiresReason('draft', 'compiled'));

check('a compiled result is NOT visible to families', !isVisibleToFamily('compiled'));
check('a reviewed result is still NOT visible to families', !isVisibleToFamily('reviewed'));
check('a published result is visible', isVisibleToFamily('published'));
check('a locked result remains visible', isVisibleToFamily('locked'));

check('a compiled result may still be edited', isEditable('compiled'));
check('a published result may not be edited', !isEditable('published'));

console.log(failures === 0
  ? '\nDomain rules hold — verified with no database.'
  : `\n${failures} check(s) FAILED.`);

process.exit(failures === 0 ? 0 : 1);
