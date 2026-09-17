/**
 * Marking Status overview + Test/Exam Sessions checks.
 * Run with a disposable LOCAL database; never at production.
 *   npx tsx src/db/test-marking-sessions.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema } = await import('@/db');
  const { schoolMarkingStatus, caProgressByTeacher, completedExamsMarkingStatus } = await import('@/lib/exam/marking-overview');
  const { searchSessions, sessionFilterOptions, grantReattempt } = await import('@/lib/exam/sessions');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const ids: number[] = [];
  let checks = 0;
  async function check(name: string, test: () => Promise<unknown> | unknown) { await test(); checks++; console.log('PASS  ' + name); }

  const settings = {
    assessmentComponents: [
      { key: 'ca1', label: 'First CA Test', maxScore: 15, isExam: false },
      { key: 'ca2', label: 'Second CA Test', maxScore: 15, isExam: false },
      { key: 'assignment', label: 'Assignment', maxScore: 10, isExam: false },
      { key: 'exam', label: 'Examination', maxScore: 60, isExam: true },
    ],
    gradingScale: { id: 'default', name: 'Default', version: 1, bands: [{ min: 0, grade: 'F', remark: 'Fail' }, { min: 50, grade: 'P', remark: 'Pass' }] },
    rankingPolicy: { tiePolicy: 'competition', tiebreakers: ['exam'], rankIncomplete: true },
  };

  async function fixture() {
    const code = 'MS-' + randomUUID().slice(0, 8);
    const [school] = await db.insert(schema.schools).values({ name: 'Marking/sessions test', code, settings }).returning();
    const schoolId = school!.id; ids.push(schoolId);

    const [principalUser] = await db.insert(schema.users).values({
      schoolId, role: 'principal', loginId: 'principal-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const [principalStaff] = await db.insert(schema.staff).values({
      schoolId, userId: principalUser!.id, role: 'principal', staffNumber: 'P1', firstName: 'Prin', lastName: 'Cipal', status: 'active',
    }).returning();
    const principal: Actor = { schoolId, userId: principalUser!.id, role: 'principal', staffId: principalStaff!.id, studentId: null, loginId: principalUser!.loginId };

    const [teacherUser] = await db.insert(schema.users).values({
      schoolId, role: 'teacher', loginId: 'teacher-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const [teacherStaff] = await db.insert(schema.staff).values({
      schoolId, userId: teacherUser!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Efo', lastName: 'Riro', status: 'active',
    }).returning();
    const teacher: Actor = { schoolId, userId: teacherUser!.id, role: 'teacher', staffId: teacherStaff!.id, studentId: null, loginId: teacherUser!.loginId };

    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A', arm: 'A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();

    await db.insert(schema.staffAssignments).values({
      schoolId, staffId: teacherStaff!.id, classId: klass!.id, subjectId: subject!.id, assignmentType: 'subject_teacher', status: 'active',
    });

    const [student] = await db.insert(schema.students).values({
      schoolId, admissionNumber: 'S1-' + code, firstName: 'Sam', lastName: 'Pupil', status: 'active',
    }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: student!.id, classId: klass!.id, sessionId: session!.id, status: 'active' });

    return { schoolId, principal, teacher, teacherStaff: teacherStaff!, session: session!, term: term!, klass: klass!, subject: subject!, student: student! };
  }

  // ── Empty state ─────────────────────────────────────────────────────────
  await check('empty school: no pending marking, no CA progress rows (but teachers/subjects listed), no completed exams', async () => {
    const { principal } = await fixture();
    const status = await schoolMarkingStatus(principal);
    assert.equal(status.total, 0);
    assert.deepEqual(status.rows, []);

    const progress = await caProgressByTeacher(principal);
    assert.equal(progress.rows.length, 1); // the one staff assignment created in fixture()
    assert.equal(progress.rows[0]!.doneCount, 0);
    assert.equal(progress.rows[0]!.status, 'not_started');
    assert.equal(progress.components.length, 4);

    const completed = await completedExamsMarkingStatus(principal);
    assert.deepEqual(completed, []);
  });

  // ── CA progress: partial then full recording ───────────────────────────
  await check('CA progress reflects recorded components and flips status as they fill in', async () => {
    const { principal, session, term, klass, subject, student } = await fixture();

    let progress = await caProgressByTeacher(principal);
    assert.equal(progress.rows[0]!.status, 'not_started');

    await db.insert(schema.assessmentScores).values({
      schoolId: klass.schoolId,
      studentId: student.id, subjectId: subject.id, sessionId: session.id, termId: term.id,
      componentKey: 'ca1', score: '12', maxScore: '15',
    });
    progress = await caProgressByTeacher(principal);
    assert.equal(progress.rows[0]!.doneCount, 1);
    assert.equal(progress.rows[0]!.status, 'in_progress');
    assert.equal(progress.rows[0]!.recorded.find(r => r.key === 'ca1')!.done, true);
    assert.equal(progress.rows[0]!.recorded.find(r => r.key === 'ca2')!.done, false);

    await db.insert(schema.assessmentScores).values([
      { schoolId: klass.schoolId, studentId: student.id, subjectId: subject.id, sessionId: session.id, termId: term.id, componentKey: 'ca2', score: '10', maxScore: '15' },
      { schoolId: klass.schoolId, studentId: student.id, subjectId: subject.id, sessionId: session.id, termId: term.id, componentKey: 'assignment', score: '8', maxScore: '10' },
    ]);
    await db.insert(schema.subjectResults).values({
      schoolId: klass.schoolId, studentId: student.id, subjectId: subject.id, sessionId: session.id, termId: term.id,
      caTotal: '30', examTotal: '55', total: '85', grade: 'P', remark: 'Pass', complete: true, state: 'compiled',
    });

    progress = await caProgressByTeacher(principal);
    assert.equal(progress.rows[0]!.doneCount, 4);
    assert.equal(progress.rows[0]!.status, 'all_recorded');

    // Filters narrow correctly.
    const filtered = await caProgressByTeacher(principal, { subjectId: subject.id + 999 });
    assert.equal(filtered.rows.length, 0);
  });

  // Shared helper: a theory question, on a real paper, ready to attempt.
  async function theoryQuestionOn(f: Awaited<ReturnType<typeof fixture>>) {
    const [set] = await db.insert(schema.questionSets).values({
      schoolId: f.klass.schoolId, sessionId: f.session.id, termId: f.term.id, subjectId: f.subject.id,
      levelId: f.klass.levelId, classId: f.klass.id, examType: 'theory', deliveryMode: 'cbt',
      teacherId: f.teacherStaff.id, status: 'approved',
    }).returning();
    const [question] = await db.insert(schema.questions).values({
      schoolId: f.klass.schoolId, questionSetId: set!.id, questionType: 'theory',
      questionText: 'Explain X.', marks: '10',
    }).returning();
    const [series] = await db.insert(schema.examSeries).values({
      schoolId: f.klass.schoolId, sessionId: f.session.id, termId: f.term.id, title: 'First CA Test', seriesType: 'ca_test',
    }).returning();
    const [paper] = await db.insert(schema.examPapers).values({
      schoolId: f.klass.schoolId, seriesId: series!.id, subjectId: f.subject.id, classId: f.klass.id,
      questionCount: 1, durationSeconds: 1800,
    }).returning();
    return { question: question!, paper: paper!, series: series! };
  }

  // ── Marking status: pending theory answers surface by teacher/subject ──
  await check('schoolMarkingStatus counts unmarked theory answers, grouped by teacher and subject', async () => {
    const f = await fixture();
    const { question, paper } = await theoryQuestionOn(f);
    const [attempt] = await db.insert(schema.attempts).values({
      schoolId: f.klass.schoolId, paperId: paper.id, studentId: f.student.id, status: 'submitted',
      expiresAt: new Date(), submittedAt: new Date(),
    }).returning();
    await db.insert(schema.attemptAnswers).values({
      schoolId: f.klass.schoolId, attemptId: attempt!.id, questionId: question.id, textAnswer: 'My answer.',
    });

    const status = await schoolMarkingStatus(f.principal);
    assert.equal(status.total, 1);
    assert.equal(status.rows.length, 1);
    assert.equal(status.rows[0]!.subjectName, f.subject.name);
    assert.equal(status.rows[0]!.count, 1);
  });

  // ── Sessions: search requires a filter, honours them, and grants reattempt ──
  await check('searchSessions is empty with no filter, then finds by name/admission/status', async () => {
    const f = await fixture();
    const empty = await searchSessions(f.principal, {});
    assert.deepEqual(empty, []);

    const { paper } = await theoryQuestionOn(f);
    const [attempt] = await db.insert(schema.attempts).values({
      schoolId: f.klass.schoolId, paperId: paper.id, studentId: f.student.id, status: 'submitted',
      expiresAt: new Date(), submittedAt: new Date(), score: '8', maxScore: '10',
    }).returning();

    const byName = await searchSessions(f.principal, { q: 'Pupil' });
    assert.equal(byName.length, 1);
    assert.equal(byName[0]!.attemptId, attempt!.id);
    assert.equal(byName[0]!.canReattempt, true);

    const byAdmission = await searchSessions(f.principal, { q: f.student.admissionNumber });
    assert.equal(byAdmission.length, 1);

    const byStatus = await searchSessions(f.principal, { status: 'in_progress' });
    assert.equal(byStatus.length, 0);

    const options = await sessionFilterOptions(f.principal);
    assert.ok(options.subjects.some(x => x.id === f.subject.id));
  });

  await check('grantReattempt resets a submitted attempt and clears its answers; rejects without a reason or on an in-progress attempt', async () => {
    const f = await fixture();
    const { question, paper } = await theoryQuestionOn(f);
    const [attempt] = await db.insert(schema.attempts).values({
      schoolId: f.klass.schoolId, paperId: paper.id, studentId: f.student.id, status: 'submitted',
      expiresAt: new Date(), submittedAt: new Date(), score: '5', maxScore: '5',
    }).returning();
    await db.insert(schema.attemptAnswers).values({
      schoolId: f.klass.schoolId, attemptId: attempt!.id, questionId: question.id, textAnswer: 'A',
    });

    const noReason = await grantReattempt(f.principal, attempt!.id, '');
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, 'reason_required');

    const granted = await grantReattempt(f.principal, attempt!.id, 'Server crashed mid-paper.');
    assert.equal(granted.ok, true);

    const [refreshed] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, attempt!.id)).limit(1);
    assert.equal(refreshed!.status, 'in_progress');
    assert.equal(refreshed!.submittedAt, null);
    assert.equal(refreshed!.score, null);

    const answers = await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, attempt!.id));
    assert.equal(answers.length, 0);

    const [logRow] = await db.select().from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'exam.attempt_reattempt_granted')).limit(1);
    assert.ok(logRow);

    const again = await grantReattempt(f.principal, attempt!.id, 'Trying again.');
    assert.equal(again.ok, false);
    assert.equal(again.error, 'not_eligible'); // already in_progress
  });

  console.log(`\n${checks} marking/sessions checks passed.`);

  for (const id of ids) await db.delete(schema.schools).where(eq(schema.schools.id, id));
  await owner.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
