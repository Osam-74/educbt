/**
 * Subject Results (lib/exam/analysis.ts) integration checks.
 * Run with a disposable LOCAL database; never at production.
 *   npx tsx src/db/test-analysis.ts
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
  const { analysisOptions, subjectAnalysis, attemptResponses } = await import('@/lib/exam/analysis');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const ids: number[] = [];
  let checks = 0;
  async function check(name: string, test: () => Promise<unknown> | unknown) { await test(); checks++; console.log('PASS  ' + name); }

  const settings = {
    assessmentComponents: [
      { key: 'ca1', label: 'First CA Test', maxScore: 20, isExam: false },
      { key: 'exam', label: 'Examination', maxScore: 60, isExam: true },
    ],
    gradingScale: { id: 'default', name: 'Default', version: 1, bands: [{ min: 0, grade: 'F', remark: 'Fail' }, { min: 50, grade: 'P', remark: 'Pass' }] },
    rankingPolicy: { tiePolicy: 'competition', tiebreakers: ['exam'], rankIncomplete: true },
  };

  async function fixture() {
    const code = 'AN-' + randomUUID().slice(0, 8);
    const [school] = await db.insert(schema.schools).values({ name: 'Analysis test', code, settings }).returning();
    const schoolId = school!.id; ids.push(schoolId);

    const [teacherUser] = await db.insert(schema.users).values({
      schoolId, role: 'teacher', loginId: 'teacher-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const [teacherStaff] = await db.insert(schema.staff).values({
      schoolId, userId: teacherUser!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Efo', lastName: 'Riro', status: 'active',
    }).returning();
    const teacher: Actor = { schoolId, userId: teacherUser!.id, role: 'teacher', staffId: teacherStaff!.id, studentId: null, loginId: teacherUser!.loginId };

    const [outsiderUser] = await db.insert(schema.users).values({
      schoolId, role: 'teacher', loginId: 'outsider-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const [outsiderStaff] = await db.insert(schema.staff).values({
      schoolId, userId: outsiderUser!.id, role: 'teacher', staffNumber: 'T2', firstName: 'Not', lastName: 'Assigned', status: 'active',
    }).returning();
    const outsider: Actor = { schoolId, userId: outsiderUser!.id, role: 'teacher', staffId: outsiderStaff!.id, studentId: null, loginId: outsiderUser!.loginId };

    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A', arm: 'A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();

    await db.insert(schema.staffAssignments).values({
      schoolId, staffId: teacherStaff!.id, classId: klass!.id, subjectId: subject!.id, assignmentType: 'subject_teacher', status: 'active',
    });

    const students = await db.insert(schema.students).values([
      { schoolId, admissionNumber: 'S1-' + code, firstName: 'Ada', lastName: 'Bello', status: 'active' },
      { schoolId, admissionNumber: 'S2-' + code, firstName: 'Bala', lastName: 'Chinedu', status: 'active' },
      { schoolId, admissionNumber: 'S3-' + code, firstName: 'Chi', lastName: 'Adeyemi', status: 'active' },
    ]).returning();
    for (const s of students) {
      await db.insert(schema.enrollments).values({ schoolId, studentId: s.id, classId: klass!.id, sessionId: session!.id, status: 'active' });
      await db.insert(schema.studentSubjects).values({ schoolId, studentId: s.id, subjectId: subject!.id, sessionId: session!.id });
    }

    return { schoolId, teacher, outsider, session: session!, term: term!, level: level!, klass: klass!, subject: subject!, students };
  }

  // ── Options and access ───────────────────────────────────────────────────
  await check('analysisOptions lists the assigned pair and both components; a stranger sees nothing', async () => {
    const f = await fixture();
    const opts = await analysisOptions(f.teacher);
    assert.equal(opts!.pairs.length, 1);
    assert.equal(opts!.pairs[0]!.classId, f.klass.id);
    assert.equal(opts!.components.length, 2);

    const outsiderOpts = await analysisOptions(f.outsider);
    assert.equal(outsiderOpts!.pairs.length, 0);
  });

  // ── CA component ranking ─────────────────────────────────────────────────
  await check('CA component: ranks by percentage, ties share a position, only recorded students appear', async () => {
    const f = await fixture();
    await db.insert(schema.assessmentScores).values([
      { schoolId: f.schoolId, studentId: f.students[0]!.id, subjectId: f.subject.id, sessionId: f.session.id, termId: f.term.id, componentKey: 'ca1', score: '18', maxScore: '20' },
      { schoolId: f.schoolId, studentId: f.students[1]!.id, subjectId: f.subject.id, sessionId: f.session.id, termId: f.term.id, componentKey: 'ca1', score: '18', maxScore: '20' },
      // students[2] has no score recorded — must not appear in the ranking.
    ]);

    const result = await subjectAnalysis(f.teacher, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'ca1' });
    assert.ok(result && !('noTerm' in result) && !('noConfig' in result) && !('noComponent' in result));
    const r = result as Exclude<typeof result, { noTerm: true } | { noConfig: true } | { noComponent: true } | null>;
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0]!.position, 1);
    assert.equal(r.rows[1]!.position, 1); // tied at 90%
    assert.equal(r.stats.count, 2);
    assert.equal(r.stats.average, 90);
    assert.equal(r.rows.every((row) => !row.cbt && row.attemptId === null), true);
  });

  await check('an unconfigured component and a component key that does not exist are both reported distinctly', async () => {
    const f = await fixture();
    await db.update(schema.schools).set({ settings: { ...settings, assessmentComponents: [] } }).where(eq(schema.schools.id, f.schoolId));
    const noConfig = await subjectAnalysis(f.teacher, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'ca1' });
    assert.ok(noConfig && 'noConfig' in noConfig);

    await db.update(schema.schools).set({ settings }).where(eq(schema.schools.id, f.schoolId));
    const noComponent = await subjectAnalysis(f.teacher, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'does-not-exist' });
    assert.ok(noComponent && 'noComponent' in noComponent);
  });

  await check('a teacher not assigned to the class/subject gets null, not someone else\'s data', async () => {
    const f = await fixture();
    const result = await subjectAnalysis(f.outsider, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'ca1' });
    assert.equal(result, null);
  });

  // Shared exam fixture: two objective questions + one theory question, on a
  // published examination paper for the class/subject/term.
  async function examFixture(f: Awaited<ReturnType<typeof fixture>>) {
    const [qset] = await db.insert(schema.questionSets).values({
      schoolId: f.schoolId, sessionId: f.session.id, termId: f.term.id, subjectId: f.subject.id,
      levelId: f.level.id, classId: f.klass.id, examType: 'objective', deliveryMode: 'cbt', status: 'approved',
    }).returning();
    const [q1] = await db.insert(schema.questions).values({
      schoolId: f.schoolId, questionSetId: qset!.id, questionType: 'single_choice', questionText: 'Easy one', marks: '10',
    }).returning();
    const [q2] = await db.insert(schema.questions).values({
      schoolId: f.schoolId, questionSetId: qset!.id, questionType: 'single_choice', questionText: 'Hard one', marks: '10',
    }).returning();
    const [q3] = await db.insert(schema.questions).values({
      schoolId: f.schoolId, questionSetId: qset!.id, questionType: 'theory', questionText: 'Explain it', marks: '10',
    }).returning();
    const [q1right] = await db.insert(schema.questionOptions).values({ schoolId: f.schoolId, questionId: q1!.id, optionText: 'Right', isCorrect: true, sortOrder: 1 }).returning();
    await db.insert(schema.questionOptions).values({ schoolId: f.schoolId, questionId: q1!.id, optionText: 'Wrong', isCorrect: false, sortOrder: 2 });
    const [q2right] = await db.insert(schema.questionOptions).values({ schoolId: f.schoolId, questionId: q2!.id, optionText: 'Right', isCorrect: true, sortOrder: 1 }).returning();
    await db.insert(schema.questionOptions).values({ schoolId: f.schoolId, questionId: q2!.id, optionText: 'Wrong', isCorrect: false, sortOrder: 2 });

    const [series] = await db.insert(schema.examSeries).values({
      schoolId: f.schoolId, sessionId: f.session.id, termId: f.term.id, title: 'Term exam', seriesType: 'examination', status: 'closed',
    }).returning();
    const [paper] = await db.insert(schema.examPapers).values({
      schoolId: f.schoolId, seriesId: series!.id, subjectId: f.subject.id, classId: f.klass.id,
      questionCount: 3, durationSeconds: 3600, status: 'closed',
    }).returning();
    return { q1: q1!, q2: q2!, q3: q3!, q1right: q1right!, q2right: q2right!, paper: paper! };
  }

  await check('exam component: a fully-graded attempt (objective + theory) is ranked with the real total', async () => {
    const f = await fixture();
    const e = await examFixture(f);
    const order = [e.q1.id, e.q2.id, e.q3.id];
    const [attempt] = await db.insert(schema.attempts).values({
      schoolId: f.schoolId, paperId: e.paper.id, studentId: f.students[0]!.id, status: 'submitted',
      expiresAt: new Date(), submittedAt: new Date(), questionOrder: order,
    }).returning();
    await db.insert(schema.attemptAnswers).values([
      { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q1.id, optionId: e.q1right.id, awardedMarks: '10', markedAt: new Date() },
      { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q2.id, optionId: null, awardedMarks: '0', markedAt: new Date() },
      { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q3.id, textAnswer: 'My essay', awardedMarks: '7', markedAt: new Date() },
    ]);

    const result = await subjectAnalysis(f.teacher, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'exam' });
    const r = result as any;
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.score, 17);
    assert.equal(r.rows[0]!.maxScore, 30);
    assert.equal(r.rows[0]!.cbt, true);
    assert.equal(r.rows[0]!.attemptId, attempt!.id);
    assert.equal(r.pendingCount, 0);
  });

  await check('exam component: an attempt still awaiting theory marking is excluded from ranking and counted as pending', async () => {
    const f = await fixture();
    const e = await examFixture(f);
    const order = [e.q1.id, e.q2.id, e.q3.id];
    await db.insert(schema.attempts).values({
      schoolId: f.schoolId, paperId: e.paper.id, studentId: f.students[1]!.id, status: 'submitted',
      expiresAt: new Date(), submittedAt: new Date(), questionOrder: order,
    }).returning().then(async ([attempt]) => {
      await db.insert(schema.attemptAnswers).values([
        { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q1.id, optionId: e.q1right.id, awardedMarks: '10', markedAt: new Date() },
        { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q2.id, optionId: e.q2right.id, awardedMarks: '10', markedAt: new Date() },
        { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q3.id, textAnswer: 'Ungraded essay' }, // no awardedMarks yet
      ]);
    });

    const result = await subjectAnalysis(f.teacher, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'exam' });
    const r = result as any;
    assert.equal(r.rows.length, 0);
    assert.equal(r.pendingCount, 1);
  });

  await check('hardest questions: objective-only, sorted so the lowest correct rate comes first', async () => {
    const f = await fixture();
    const e = await examFixture(f);
    const order = [e.q1.id, e.q2.id, e.q3.id];
    // Two students get q1 right, both get q2 wrong — q2 is the hardest.
    for (const student of [f.students[0]!, f.students[1]!]) {
      const [attempt] = await db.insert(schema.attempts).values({
        schoolId: f.schoolId, paperId: e.paper.id, studentId: student.id, status: 'submitted',
        expiresAt: new Date(), submittedAt: new Date(), questionOrder: order,
      }).returning();
      await db.insert(schema.attemptAnswers).values([
        { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q1.id, optionId: e.q1right.id, awardedMarks: '10', markedAt: new Date() },
        { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q2.id, optionId: null, awardedMarks: '0', markedAt: new Date() },
        { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q3.id, textAnswer: 'x', awardedMarks: '5', markedAt: new Date() },
      ]);
    }

    const result = await subjectAnalysis(f.teacher, { classId: f.klass.id, subjectId: f.subject.id, componentKey: 'exam' });
    const r = result as any;
    assert.equal(r.hardestQuestions.length, 2); // theory (q3) excluded
    assert.equal(r.hardestQuestions[0]!.questionId, e.q2.id);
    assert.equal(r.hardestQuestions[0]!.rate, 0);
    assert.equal(r.hardestQuestions[1]!.questionId, e.q1.id);
    assert.equal(r.hardestQuestions[1]!.rate, 100);
  });

  // ── Response preview ─────────────────────────────────────────────────────
  await check('attemptResponses shows the student\'s own choice against the correct one, and refuses a teacher with no assignment', async () => {
    const f = await fixture();
    const e = await examFixture(f);
    const order = [e.q1.id, e.q2.id];
    const [attempt] = await db.insert(schema.attempts).values({
      schoolId: f.schoolId, paperId: e.paper.id, studentId: f.students[0]!.id, status: 'submitted',
      expiresAt: new Date(), submittedAt: new Date(), questionOrder: order,
    }).returning();
    await db.insert(schema.attemptAnswers).values([
      { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q1.id, optionId: e.q1right.id, awardedMarks: '10', markedAt: new Date() },
      { schoolId: f.schoolId, attemptId: attempt!.id, questionId: e.q2.id, optionId: null, awardedMarks: '0', markedAt: new Date() },
    ]);

    const seen = await attemptResponses(f.teacher, attempt!.id);
    assert.ok(seen);
    assert.equal(seen!.questions.length, 2);
    assert.equal(seen!.questions[0]!.options.find((o) => o.chosen)!.id, e.q1right.id);
    assert.equal(seen!.questions[0]!.options.find((o) => o.chosen)!.isCorrect, true);
    assert.equal(seen!.questions[1]!.options.some((o) => o.chosen), false);
    assert.equal(seen!.score, 10);
    assert.equal(seen!.maxScore, 20);

    const refused = await attemptResponses(f.outsider, attempt!.id);
    assert.equal(refused, null);
  });

  console.log(`\n${checks} analysis checks passed.`);

  for (const id of ids) await db.delete(schema.schools).where(eq(schema.schools.id, id));
  await owner.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
