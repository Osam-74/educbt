/**
 * Theory delivery: a subject's examination carries its approved THEORY questions as well as its objective ones,
 * every candidate gets all the theory after the objective part, and every theory question reaches the teacher's marking
 * queue after submission. Isolated fixture schools, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { createSeries, composeSeries } = await import('@/lib/exam/compose');
  const { startAttempt, saveAnswer, submitAttempt } = await import('@/lib/exam/engine');
  const { markingQueue, awardMarks } = await import('@/lib/exam/results');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  type Opts = { objective?: number; theory?: number; theoryStatus?: 'approved' | 'draft'; theoryQuestionApproval?: 'approved' | 'pending'; seriesType?: 'examination' | 'ca_test'; waecTheory?: boolean };
  async function fixture(o: Opts = {}) {
    const { objective = 6, theory = 3, theoryStatus = 'approved', theoryQuestionApproval = 'approved', seriesType = 'examination', waecTheory = false } = o;
    const [school] = await db.insert(schema.schools).values({ name: 'Theory delivery', code: 'TD-' + randomUUID() }).returning();
    const schoolId = school!.id; schools.push(schoolId);
    const mkUser = async (role: 'exam_officer' | 'teacher', login: string) => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [s] = await db.insert(schema.staff).values({ schoolId, userId: u!.id, role, staffNumber: login, firstName: login, lastName: 'X' }).returning();
      return { user: u!, staff: s!, actor: { schoolId, userId: u!.id, role, staffId: s!.id, studentId: null, loginId: login } as Actor };
    };
    const officer = await mkUser('exam_officer', 'officer'), teacher = await mkUser('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', stage: 'junior', levelOrder: 1 } as never).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, arm: 'A', displayName: 'JSS1 A' } as never).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staff.id, subjectId: subject!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const series = await createSeries(officer.actor, { title: 'Term exam', seriesType, sessionId: session!.id, termId: term!.id, questionsPerStudent: 4, durationMinutes: 60 } as never);
    const seriesId = seriesType === 'examination' ? 0 : Number(series.id);
    let n = 0;
    const base = { schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, seriesId, teacherId: teacher.staff.id };
    const [oset] = await db.insert(schema.questionSets).values({ ...base, examType: 'objective', status: 'approved' }).returning();
    for (let i = 0; i < objective; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: oset!.id, questionText: `OBJ ${++n}?`, sequence: n, approvalStatus: 'approved', status: 'active', marks: '2' } as never).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
    }
    const [tset] = await db.insert(schema.questionSets).values({ ...base, examType: 'theory', status: theoryStatus, waecMode: waecTheory }).returning();
    const theoryIds: number[] = [];
    for (let i = 0; i < theory; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: tset!.id, questionText: `THEORY ${i + 1}`, questionType: 'theory', sequence: 100 + i, approvalStatus: theoryQuestionApproval, status: 'active', marks: '10' } as never).returning();
      theoryIds.push(Number(q!.id));
    }
    const mkStudent = async (label: string) => {
      const [u] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: label, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [st] = await db.insert(schema.students).values({ schoolId, userId: u!.id, admissionNumber: label + randomUUID().slice(0, 6), firstName: label, lastName: 'S', gender: 'Male' } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId: room!.id, sessionId: session!.id, status: 'active' } as never);
      await db.insert(schema.studentSubjects).values({ schoolId, studentId: st!.id, subjectId: subject!.id, sessionId: session!.id } as never);
      return Number(st!.id);
    };
    return { schoolId, officer, teacher, series, theoryIds, mkStudent, subjectId: Number(subject!.id), levelId: Number(level!.id) };
  }

  /** Compose, then open the paper for sitting, the way the office does. */
  async function openPaper(f: Awaited<ReturnType<typeof fixture>>) {
    await composeSeries(f.officer.actor, Number(f.series.id));
    const [paper] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(f.series.id)));
    if (!paper) return null;
    await db.update(schema.examSeries).set({ status: 'published', sittingOpensAt: new Date(Date.now() - 3600_000), sittingClosesAt: new Date(Date.now() + 3600_000) }).where(eq(schema.examSeries.id, Number(f.series.id)));
    await db.update(schema.examPapers).set({ status: 'published' }).where(eq(schema.examPapers.id, paper.id));
    return paper;
  }
  const poolOf = async (paperId: number) => (await db.select({ id: schema.questions.id, type: schema.questions.questionType }).from(schema.paperQuestions)
    .innerJoin(schema.questions, eq(schema.questions.id, schema.paperQuestions.questionId)).where(eq(schema.paperQuestions.paperId, paperId)));

  try {
    await check('composing an examination attaches the approved theory questions after the objective pool', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!;
      const pool = await poolOf(Number(paper.id));
      assert.equal(pool.filter((q) => q.type === 'theory').length, 3); assert.equal(pool.filter((q) => q.type !== 'theory').length, 6);
    });
    await check('a theory set that is NOT approved is never attached', async () => {
      const f = await fixture({ theoryStatus: 'draft' }); const paper = (await openPaper(f))!;
      assert.equal((await poolOf(Number(paper.id))).filter((q) => q.type === 'theory').length, 0);
    });
    await check('a theory question that is not approved is left out even when its set is', async () => {
      const f = await fixture({ theoryQuestionApproval: 'pending' }); const paper = (await openPaper(f))!;
      assert.equal((await poolOf(Number(paper.id))).filter((q) => q.type === 'theory').length, 0);
    });
    await check('a CA test has no theory half: nothing is attached', async () => {
      const f = await fixture({ seriesType: 'ca_test' }); const paper = (await openPaper(f))!;
      assert.equal((await poolOf(Number(paper.id))).filter((q) => q.type === 'theory').length, 0);
    });
    await check('a WAEC theory set never reaches the school\'s ordinary examination', async () => {
      const f = await fixture({ waecTheory: true }); const paper = (await openPaper(f))!;
      assert.equal((await poolOf(Number(paper.id))).filter((q) => q.type === 'theory').length, 0);
    });
    await check('a paper with no theory set at all still composes exactly as before', async () => {
      const f = await fixture({ theory: 0 }); const paper = (await openPaper(f))!;
      const pool = await poolOf(Number(paper.id)); assert.equal(pool.length, 6); assert.ok(pool.every((q) => q.type !== 'theory'));
    });

    await check('every candidate gets the objective count asked for PLUS all the theory, theory last', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!;
      for (const label of ['alice', 'bob', 'cara']) {
        const sid = await f.mkStudent(label); const r = await startAttempt(f.schoolId, Number(paper.id), sid);
        assert.ok(r.ok, String((r as { reason?: string }).reason)); const qs = (r as { questions: Array<{ id: number; type: string }> }).questions;
        assert.equal(qs.length, 4 + 3, 'questionsPerStudent 4 objective + 3 theory'); assert.deepEqual(qs.slice(4).map((q) => q.type), ['theory', 'theory', 'theory']);
        assert.deepEqual(qs.slice(4).map((q) => q.id).sort(), [...f.theoryIds].sort());
      }
    });

    await check('submitting gives every theory question an UNMARKED answer row, even one the student never touched', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!; const sid = await f.mkStudent('dina');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number; questions: Array<{ id: number; type: string }> };
      await saveAnswer(f.schoolId, r.attemptId, sid, { questionId: f.theoryIds[0]!, text: 'My answer to the first.' });
      assert.ok((await submitAttempt(f.schoolId, r.attemptId, sid)).ok);
      const rows = await db.select().from(schema.attemptAnswers).where(and(eq(schema.attemptAnswers.attemptId, r.attemptId), inArray(schema.attemptAnswers.questionId, f.theoryIds)));
      assert.equal(rows.length, 3, 'one per theory question'); assert.ok(rows.every((x) => x.awardedMarks === null), 'none is marked yet');
      assert.equal(rows.find((x) => x.questionId === f.theoryIds[0])!.textAnswer, 'My answer to the first.');
      assert.equal(rows.find((x) => x.questionId === f.theoryIds[1])!.textAnswer, null);
    });
    await check('the typed answer and the marks of an objective question are unaffected', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!; const sid = await f.mkStudent('eve');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number; questions: Array<{ id: number; type: string; options?: Array<{ id: number; key: string }> }> };
      const first = r.questions[0]!; const correct = (await db.select().from(schema.questionOptions).where(and(eq(schema.questionOptions.questionId, first.id), eq(schema.questionOptions.isCorrect, true))))[0]!;
      await saveAnswer(f.schoolId, r.attemptId, sid, { questionId: first.id, optionId: Number(correct.id) });
      await submitAttempt(f.schoolId, r.attemptId, sid);
      const [att] = await db.select().from(schema.attempts).where(eq(schema.attempts.id, r.attemptId));
      assert.equal(Number(att!.score), 2, 'one right objective answer = 2 marks, theory adds nothing yet');
    });

    await check('the teacher\'s marking queue now lists every theory script, and marking one removes only that one', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!;
      for (const label of ['fay', 'gus']) { const sid = await f.mkStudent(label); const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number };
        await saveAnswer(f.schoolId, r.attemptId, sid, { questionId: f.theoryIds[0]!, text: label + ' wrote this' }); await submitAttempt(f.schoolId, r.attemptId, sid); }
      const queue = await markingQueue(f.teacher.actor); assert.equal(queue.length, 6, '2 students x 3 theory questions');
      const first = queue.find((x) => x.textAnswer?.includes('fay'))!;
      assert.deepEqual(await awardMarks(f.teacher.actor, first.answerId, 7), { ok: true });
      assert.equal((await markingQueue(f.teacher.actor)).length, 5);
    });
    await check('marks above the question maximum are refused (10 is the most for this theory question)', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!; const sid = await f.mkStudent('hal');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; await submitAttempt(f.schoolId, r.attemptId, sid);
      const q = (await markingQueue(f.teacher.actor))[0]!; const bad = await awardMarks(f.teacher.actor, q.answerId, 11); assert.equal(bad.ok, false);
    });
    await check('a student on a paper WITHOUT theory gets no empty answer rows at submit', async () => {
      const f = await fixture({ theory: 0 }); const paper = (await openPaper(f))!; const sid = await f.mkStudent('ivy');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; await submitAttempt(f.schoolId, r.attemptId, sid);
      assert.equal((await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, r.attemptId))).length, 0);
    });
    await check('submitting twice does not create a second set of rows', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!; const sid = await f.mkStudent('jon');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; await submitAttempt(f.schoolId, r.attemptId, sid); await submitAttempt(f.schoolId, r.attemptId, sid);
      assert.equal((await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, r.attemptId))).length, 3);
    });
    await check('a resumed attempt keeps the very same questions in the very same order, theory still last', async () => {
      const f = await fixture(); const paper = (await openPaper(f))!; const sid = await f.mkStudent('kim');
      const a = await startAttempt(f.schoolId, Number(paper.id), sid) as { questions: Array<{ id: number }> }; const b = await startAttempt(f.schoolId, Number(paper.id), sid) as { questions: Array<{ id: number }>; resumed: boolean };
      assert.equal(b.resumed, true); assert.deepEqual(b.questions.map((q) => q.id), a.questions.map((q) => q.id));
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
