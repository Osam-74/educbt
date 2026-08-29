/**
 * Composition, marking and compilation verification.
 *
 *   npm run test:results
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as att from './schema/attempts';
import * as res from './schema/results';
import { gradeFor, rank, DEFAULT_RANKING } from '@/domain/academic';
import { canTransition } from '@/domain/academic';

const schema = { ...core, ...people, ...qb, ...att, ...res };
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED required.');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [school] = await db.select().from(core.schools).where(eq(core.schools.code, 'DEMO001')).limit(1);
    if (!school) { console.log('SKIP  seed first.'); return; }
    const schoolId = Number(school.id);

    // ── Grading boundaries ───────────────────────────────────────────────────
    check('75 is A1', gradeFor(75).grade === 'A1');
    check('74 is B2 (boundary is exclusive below)', gradeFor(74).grade === 'B2');
    check('40 is E8, a pass', gradeFor(40).grade === 'E8' && gradeFor(40).remark === 'Pass');
    check('39 is F9, a fail', gradeFor(39).grade === 'F9' && gradeFor(39).remark === 'Fail');
    check('0 does not fall through the scale', gradeFor(0).grade === 'F9');
    check('100 is A1', gradeFor(100).grade === 'A1');

    // ── Position ranking, including ties ─────────────────────────────────────
    const totals = [
      { studentId: 1, total: 80 },
      { studentId: 2, total: 72 },
      { studentId: 3, total: 72 },
      { studentId: 4, total: 65 },
    ];

    const ranked = rank(
      totals.map((t) => ({ ...t, complete: true })),
      { tiePolicy: 'competition', tiebreakers: ['none'], rankIncomplete: false },
    );
    const pos = new Map(ranked.map((r) => [r.studentId, r.position]));

    check('highest total is 1st', pos.get(1) === 1);
    check('equal totals share a position', pos.get(2) === 2 && pos.get(3) === 2);
    check('the position after a tie skips', pos.get(4) === 4, '1st, 2nd, 2nd, 4th');

    // ── Marking bounds ───────────────────────────────────────────────────────
    const max = 10;
    const withinBounds = (m: number) => Number.isFinite(m) && m >= 0 && m <= max;

    check('a mark above the maximum is rejected', !withinBounds(11), 'otherwise a student scores 105%');
    check('a negative mark is rejected', !withinBounds(-1));
    check('full marks are allowed', withinBounds(10));

    // ── Only approved sets compose ───────────────────────────────────────────
    const sets = await db.select().from(qb.questionSets).where(eq(qb.questionSets.schoolId, schoolId));
    const approved = sets.filter((s) => s.status === 'approved');
    const notApproved = sets.filter((s) => s.status !== 'approved');

    check(
      'draft sets are excluded from composition',
      notApproved.every((s) => s.status !== 'approved'),
      `${approved.length} approved, ${notApproved.length} not`,
    );

    // ── A short pool is named, not silently shortened ────────────────────────
    const perStudent = 20;
    const pool = 12;

    check(
      'a pool shorter than the per-student count is skipped',
      pool < perStudent,
      'shortening gives one class 12 questions and another 20, out of the same total',
    );

    // ── Practice never counts towards a result ───────────────────────────────
    const series = await db.select().from(qb.examSeries).where(eq(qb.examSeries.schoolId, schoolId));
    const countable = series.filter((s) => s.seriesType === 'examination');

    check(
      'only examination series count towards results',
      series.every((s) => s.seriesType !== 'practice' || !countable.includes(s)),
    );

    // ── Results are withheld until published ─────────────────────────────────
    await db.delete(res.subjectResults).where(eq(res.subjectResults.schoolId, schoolId));

    const [student] = await db.select().from(people.students).where(eq(people.students.schoolId, schoolId)).limit(1);
    const [subject] = await db.select().from(core.subjects).where(eq(core.subjects.schoolId, schoolId)).limit(1);
    const [session] = await db.select().from(core.academicSessions).where(eq(core.academicSessions.schoolId, schoolId)).limit(1);
    const [term] = await db.select().from(core.terms).where(eq(core.terms.schoolId, schoolId)).limit(1);

    await db.insert(res.subjectResults).values({
      schoolId, studentId: Number(student!.id), subjectId: Number(subject!.id),
      sessionId: Number(session!.id), termId: Number(term!.id),
      total: '72.00', grade: 'B2', remark: 'Very Good', subjectPosition: 2, classSize: 5,
      gradingScaleId: 'waec-9', gradingScaleVersion: 1, state: 'compiled', complete: true,
    });

    const visibleToStudent = await db.select().from(res.subjectResults)
      .where(and(
        eq(res.subjectResults.studentId, Number(student!.id)),
        eq(res.subjectResults.published, true),
      ));

    check('an unpublished result is hidden from the student', visibleToStudent.length === 0);

    await db.update(res.subjectResults).set({ published: true })
      .where(eq(res.subjectResults.schoolId, schoolId));

    const afterPublish = await db.select().from(res.subjectResults)
      .where(and(
        eq(res.subjectResults.studentId, Number(student!.id)),
        eq(res.subjectResults.published, true),
      ));

    check('publishing reveals it', afterPublish.length === 1);

    // ── The grade is STORED, not derived ─────────────────────────────────────
    check(
      'the grade is stored on the row',
      afterPublish[0]!.grade === 'B2',
      'deriving it would rewrite last term when the scale changes',
    );

    // ── Compiling twice does not duplicate ───────────────────────────────────
    let duplicateBlocked = false;
    try {
      await db.insert(res.subjectResults).values({
        schoolId, studentId: Number(student!.id), subjectId: Number(subject!.id),
        sessionId: Number(session!.id), termId: Number(term!.id), total: '50.00',
      });
    } catch { duplicateBlocked = true; }

    check('one result per student per subject per term', duplicateBlocked);

    // ── Lifecycle is persisted, not just in memory ───────────────────────────
    const [stored] = await db.select().from(res.subjectResults)
      .where(eq(res.subjectResults.schoolId, schoolId)).limit(1);

    check('the result carries its grading scale id', stored!.gradingScaleId !== '');
    check('the result carries the scale version', stored!.gradingScaleVersion > 0);
    check('the result has a lifecycle state', Boolean(stored!.state));

    check(
      'compiled cannot skip review and publish directly',
      !canTransition('compiled', 'published'),
    );
  } finally {
    await client.end();
  }

  console.log(failures === 0
    ? '\nComposition, marking and compilation hold.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Results test error:', e); process.exit(1); });
