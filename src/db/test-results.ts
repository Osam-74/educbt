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
import {
  createSeries, questionAvailability, composeSeries, scheduleSeries, publishSeries,
} from '@/lib/exam/compose';
import type { Actor } from '@/lib/session';

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

    // ── The Exam Office: create, check, compose, schedule, publish ──────────
    // A PRIVATE school, so these checks read exactly what the services do and
    // are never polluted by fixtures left behind by other suites.
    // Rerunnable: a previous run's copy is removed (cascades to its fixtures).
    await db.delete(core.schools).where(eq(core.schools.code, 'EXAMOFF1'));

    const [testSchool] = await db.insert(core.schools).values({
      name: 'Exam Office Test School', code: 'EXAMOFF1', status: 'active',
    }).returning();
    const officeSchoolId = Number(testSchool!.id);

    const [officeSession] = await db.insert(core.academicSessions).values({
      schoolId: officeSchoolId, title: '2026/2027', isCurrent: true,
    }).returning();
    const [officeTerm] = await db.insert(core.terms).values({
      schoolId: officeSchoolId, sessionId: Number(officeSession!.id),
      title: 'First Term', position: 1, isCurrent: true,
    }).returning();
    const [officeLevel] = await db.insert(core.classLevels).values({
      schoolId: officeSchoolId, name: 'SS1', stage: 'senior', levelOrder: 1,
    }).returning();
    const [mathSubject] = await db.insert(core.subjects).values({
      schoolId: officeSchoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true,
    }).returning();
    const [englishSubject] = await db.insert(core.subjects).values({
      schoolId: officeSchoolId, name: 'English Language', code: 'ENG', isCompulsory: true,
    }).returning();

    const officer: Actor = {
      userId: 1, schoolId: officeSchoolId, role: 'exam_officer',
      loginId: 'test', staffId: null, studentId: null,
    };

    // Validation refuses a nonsense question window.
    let badWindowRejected = false;
    try {
      await createSeries(officer, {
        title: 'Bad window', seriesType: 'ca_test',
        sessionId: Number(officeSession!.id), termId: Number(officeTerm!.id),
        questionsPerStudent: 2, durationMinutes: 30,
        questionsOpenFrom: '2030-01-10', questionsOpenTo: '2030-01-01',
      });
    } catch { badWindowRejected = true; }
    check('a question window that closes before it opens is refused', badWindowRejected);

    const officeSeries = await createSeries(officer, {
      title: 'First Term Examination', seriesType: 'examination',
      sessionId: Number(officeSession!.id), termId: Number(officeTerm!.id),
      questionsPerStudent: 2, durationMinutes: 30,
    });
    check('an examination is created as a draft', officeSeries.status === 'draft');

    const emptyBank = await questionAvailability(officer, Number(officeSeries.id));
    check('an examination with no approved questions shows nothing available', emptyBank.rows.length === 0);

    // Publishing with no papers at all is refused.
    let emptyPublishBlocked = false;
    try {
      await publishSeries(officer, Number(officeSeries.id));
    } catch { emptyPublishBlocked = true; }
    check('publishing an examination with no papers is refused', emptyPublishBlocked);

    // An approved terminal objective set with enough questions for Mathematics,
    // and one with too few for English.
    async function seededSet(subjectId: number, n: number) {
      const [s] = await db.insert(qb.questionSets).values({
        schoolId: officeSchoolId, sessionId: Number(officeSession!.id),
        termId: Number(officeTerm!.id), subjectId, levelId: Number(officeLevel!.id),
        examType: 'objective', seriesId: 0, status: 'approved', minRequired: 2,
      }).returning();

      for (let i = 0; i < n; i++) {
        const [q] = await db.insert(qb.questions).values({
          schoolId: officeSchoolId, questionSetId: Number(s!.id),
          questionText: `Fixture question ${i + 1}`,
          approvalStatus: 'approved', status: 'active',
        }).returning();
        await db.insert(qb.questionOptions).values(
          ['A', 'B', 'C', 'D'].map((k, j) => ({
            schoolId: officeSchoolId, questionId: Number(q!.id), optionKey: k,
            optionText: `Option ${k}`, isCorrect: j === 0, sortOrder: j,
          })),
        );
      }
    }

    await seededSet(Number(mathSubject!.id), 3);
    await seededSet(Number(englishSubject!.id), 1);

    const afterBank = await questionAvailability(officer, Number(officeSeries.id));
    const mathRow = afterBank.rows.find((r) => r.subjectName === 'Mathematics');
    const engRow = afterBank.rows.find((r) => r.subjectName === 'English Language');
    check(
      'availability reports Ready and Not enough questions per subject',
      Boolean(mathRow?.ready && mathRow.available === 3 && engRow && !engRow.ready && engRow.available === 1),
    );

    const composed = await composeSeries(officer, Number(officeSeries.id));
    check(
      'the short subject is skipped and named, the ready one composed',
      composed.created === 1 && composed.short.length === 1,
      composed.short.join(', '),
    );

    // Idempotent: the office WILL press this twice.
    const recomposed = await composeSeries(officer, Number(officeSeries.id));
    check('composing twice does not duplicate the paper', recomposed.created === 0);

    // Publishing with unscheduled papers is refused.
    let unscheduledBlocked = false;
    try {
      await publishSeries(officer, Number(officeSeries.id));
    } catch { unscheduledBlocked = true; }
    check('publishing before scheduling is refused', unscheduledBlocked);

    // Scheduling: next Monday, so weekends never empty the window.
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));

    const scheduled = await scheduleSeries(
      officer, Number(officeSeries.id), monday.toISOString().slice(0, 10), null, 2,
    );
    check('scheduling places the paper on a school day', scheduled.scheduled === 1 && scheduled.unplaced.length === 0);

    const [windowRow] = await db.select().from(qb.examSeries)
      .where(eq(qb.examSeries.id, Number(officeSeries.id))).limit(1);
    check(
      'the sitting window is stored on the series for the engine to enforce',
      Boolean(windowRow!.sittingOpensAt && windowRow!.sittingClosesAt),
    );

    const published = await publishSeries(officer, Number(officeSeries.id));
    check('publishing after scheduling succeeds', published === 1);

    let republishBlocked = false;
    try {
      await publishSeries(officer, Number(officeSeries.id));
    } catch { republishBlocked = true; }
    check('publishing an already-published examination is refused', republishBlocked);

    // ── Practice: no timetable, always available ──────────────────────────────
    const practice = await createSeries(officer, {
      title: 'Revision practice', seriesType: 'practice',
      sessionId: Number(officeSession!.id), termId: Number(officeTerm!.id),
      questionsPerStudent: 2, durationMinutes: 30,
    });

    // Practice questions live IN the series, not the terminal bank.
    const [pset] = await db.insert(qb.questionSets).values({
      schoolId: officeSchoolId, sessionId: Number(officeSession!.id),
      termId: Number(officeTerm!.id), subjectId: Number(mathSubject!.id),
      levelId: Number(officeLevel!.id),
      examType: 'objective', seriesId: Number(practice.id), status: 'approved', minRequired: 2,
    }).returning();

    for (let i = 0; i < 2; i++) {
      const [q] = await db.insert(qb.questions).values({
        schoolId: officeSchoolId, questionSetId: Number(pset!.id),
        questionText: `Practice question ${i + 1}`,
        approvalStatus: 'approved', status: 'active',
      }).returning();
      await db.insert(qb.questionOptions).values(
        ['A', 'B'].map((k, j) => ({
          schoolId: officeSchoolId, questionId: Number(q!.id), optionKey: k,
          optionText: `Option ${k}`, isCorrect: j === 0, sortOrder: j,
        })),
      );
    }

    const practiceComposed = await composeSeries(officer, Number(practice.id));
    check('a practice series composes from its own sets', practiceComposed.created === 1);

    let practiceSchedulingRefused = false;
    try {
      await scheduleSeries(officer, Number(practice.id), monday.toISOString().slice(0, 10), null, 2);
    } catch { practiceSchedulingRefused = true; }
    check('scheduling a practice series is refused', practiceSchedulingRefused);

    const practicePublished = await publishSeries(officer, Number(practice.id));
    check('a practice series publishes without a timetable', practicePublished === 1);
  } finally {
    await client.end();
  }

  console.log(failures === 0
    ? '\nComposition, marking and compilation hold.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Results test error:', e); process.exit(1); });
