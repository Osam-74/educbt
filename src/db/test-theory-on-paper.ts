/**
 * Theory answered on paper: the flag lives on theory sets only and can change only while the set is with its teacher; a
 * paper is on paper only when EVERY attached theory question comes from a flagged set; the server refuses typed theory
 * for such a paper (objective answers unaffected); submit still creates one unmarked row per theory question so the
 * teacher can enter the marks. Isolated fixture schools, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { createSeries, composeSeries } = await import('@/lib/exam/compose');
  const { findOrCreateSet } = await import('@/lib/exam/sets');
  const { saveCollection } = await import('@/lib/exam/collection');
  const { startAttempt, saveAnswer, submitAttempt } = await import('@/lib/exam/engine');
  const { markingQueue, awardMarks } = await import('@/lib/exam/results');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  /** theorySets: one entry per theory set on the paper (a second set needs a second department, so the flags differ). */
  async function fixture(theoryFlags: boolean[] = [true]) {
    const [school] = await db.insert(schema.schools).values({ name: 'Theory on paper', code: 'TP-' + randomUUID() }).returning();
    const schoolId = school!.id; schools.push(schoolId);
    const mkStaff = async (role: 'exam_officer' | 'teacher', login: string) => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [s] = await db.insert(schema.staff).values({ schoolId, userId: u!.id, role, staffNumber: login, firstName: login, lastName: 'X' }).returning();
      return { staff: s!, actor: { schoolId, userId: u!.id, role, staffId: s!.id, studentId: null, loginId: login } as Actor };
    };
    const officer = await mkStaff('exam_officer', 'officer'), teacher = await mkStaff('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', stage: 'junior', levelOrder: 1 } as never).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, arm: 'A', displayName: 'JSS1 A' } as never).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staff.id, subjectId: subject!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const series = await createSeries(officer.actor, { title: 'Term exam', seriesType: 'examination', sessionId: session!.id, termId: term!.id, questionsPerStudent: 3, durationMinutes: 60 } as never);
    // Open the question bank the way the exam office does (a submission window on the series, then the collection).
    await db.update(schema.examSeries).set({ questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).where(eq(schema.examSeries.id, Number(series.id)));
    await saveCollection(officer.actor, { objective: 1, theory: 1, seriesId: Number(series.id) });
    const scope = { sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, departmentId: null as number | null, seriesId: 0, waecMode: false };
    const base0 = { schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, seriesId: 0, teacherId: teacher.staff.id };
    const [oset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'objective', status: 'approved' }).returning();
    for (let i = 1; i <= 4; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: oset!.id, questionText: `OBJ ${i}?`, sequence: i, approvalStatus: 'approved', status: 'active', marks: '2' } as never).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
    }
    const theorySets: Array<{ id: number }> = []; const theoryIds: number[] = [];
    for (let i = 0; i < theoryFlags.length; i++) {
      // The scope key has no spare field, so a second theory set is told apart by its series bank: one set lives in the
      // terminal bank (seriesId 0). Extra sets are exercised by flipping the SAME set between runs instead.
      const [tset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'theory', status: 'approved', theoryOnPaper: theoryFlags[i]! }).returning();
      theorySets.push({ id: Number(tset!.id) });
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: tset!.id, questionText: `THEORY ${i + 1}`, questionType: 'theory', sequence: 100 + i, approvalStatus: 'approved', status: 'active', marks: '10' } as never).returning();
      theoryIds.push(Number(q!.id));
      break; // only one theory set can exist per scope; see note above
    }
    const mkStudent = async (label: string) => {
      const [u] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: label, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [st] = await db.insert(schema.students).values({ schoolId, userId: u!.id, admissionNumber: label + randomUUID().slice(0, 6), firstName: label, lastName: 'S', gender: 'Male' } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId: room!.id, sessionId: session!.id, status: 'active' } as never);
      await db.insert(schema.studentSubjects).values({ schoolId, studentId: st!.id, subjectId: subject!.id, sessionId: session!.id } as never);
      return Number(st!.id);
    };
    return { schoolId, officer, teacher, series, scope, theorySet: theorySets[0]!, theoryIds, mkStudent };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  const openPaper = async (f: F) => {
    await composeSeries(f.officer.actor, Number(f.series.id));
    const [paper] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(f.series.id)));
    await db.update(schema.examSeries).set({ status: 'published', sittingOpensAt: new Date(Date.now() - 3600_000), sittingClosesAt: new Date(Date.now() + 3600_000) }).where(eq(schema.examSeries.id, Number(f.series.id)));
    await db.update(schema.examPapers).set({ status: 'published' }).where(eq(schema.examPapers.id, paper!.id));
    return paper!;
  };
  const setRow = async (id: number) => (await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, id)))[0]!;

  try {
    await check('migration default: a set and a paper that existed before are NOT on paper', async () => {
      const f = await fixture([false]); assert.equal((await setRow(f.theorySet.id)).theoryOnPaper, false);
      const paper = await openPaper(f); assert.equal(paper.theoryOnPaper, false);
    });
    await check('a paper whose theory set is flagged is composed as on paper', async () => {
      const f = await fixture([true]); const paper = await openPaper(f); assert.equal(paper.theoryOnPaper, true);
    });
    await check('re-composing after the flag is turned off puts the paper back to typed theory', async () => {
      const f = await fixture([true]); await openPaper(f);
      await db.update(schema.questionSets).set({ theoryOnPaper: false }).where(eq(schema.questionSets.id, f.theorySet.id));
      await db.delete(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(f.series.id)));
      await composeSeries(f.officer.actor, Number(f.series.id));
      assert.equal((await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(f.series.id))))[0]!.theoryOnPaper, false);
    });
    await check('a paper with NO theory is never on paper, even though "every" of nothing is vacuously true', async () => {
      const f = await fixture([true]); await db.delete(schema.questionSets).where(eq(schema.questionSets.id, f.theorySet.id));
      const paper = await openPaper(f); assert.equal(paper.theoryOnPaper, false);
    });

    await check('findOrCreateSet: a NEW theory set can be created on paper', async () => {
      const f = await fixture([false]); await db.delete(schema.questionSets).where(eq(schema.questionSets.id, f.theorySet.id));
      const s = await findOrCreateSet(f.teacher.actor, { ...f.scope, examType: 'theory', theoryOnPaper: true }); assert.equal(s.theoryOnPaper, true);
    });
    await check('findOrCreateSet: an OBJECTIVE set can never be on paper', async () => {
      const f = await fixture([false]); await db.delete(schema.questionSets).where(and(eq(schema.questionSets.schoolId, f.schoolId), eq(schema.questionSets.examType, 'objective')));
      const s = await findOrCreateSet(f.teacher.actor, { ...f.scope, examType: 'objective', theoryOnPaper: true }); assert.equal(s.theoryOnPaper, false);
    });
    await check('the flag can be changed while the set is with its teacher (draft)', async () => {
      const f = await fixture([false]); await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.id, f.theorySet.id));
      assert.equal((await findOrCreateSet(f.teacher.actor, { ...f.scope, examType: 'theory', theoryOnPaper: true })).theoryOnPaper, true);
      assert.equal((await findOrCreateSet(f.teacher.actor, { ...f.scope, examType: 'theory', theoryOnPaper: false })).theoryOnPaper, false);
    });
    await check('once the set is handed in the flag is left alone', async () => {
      for (const status of ['submitted', 'approved'] as const) {
        const f = await fixture([false]); await db.update(schema.questionSets).set({ status }).where(eq(schema.questionSets.id, f.theorySet.id));
        assert.equal((await findOrCreateSet(f.teacher.actor, { ...f.scope, examType: 'theory', theoryOnPaper: true })).theoryOnPaper, false, status);
        assert.equal((await setRow(f.theorySet.id)).theoryOnPaper, false, status + ' (stored)');
      }
    });
    await check('leaving theoryOnPaper out of the scope does not touch the stored flag', async () => {
      const f = await fixture([true]); await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.id, f.theorySet.id));
      assert.equal((await findOrCreateSet(f.teacher.actor, { ...f.scope, examType: 'theory' })).theoryOnPaper, true);
    });

    await check('on an on-paper paper the server REFUSES a typed theory answer and stores nothing', async () => {
      const f = await fixture([true]); const paper = await openPaper(f); const sid = await f.mkStudent('ann');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number };
      const res = await saveAnswer(f.schoolId, r.attemptId, sid, { questionId: f.theoryIds[0]!, text: 'typed anyway' });
      assert.deepEqual([res.ok, res.reason], [false, 'on_paper']);
      assert.equal((await db.select().from(schema.attemptAnswers).where(and(eq(schema.attemptAnswers.attemptId, r.attemptId), eq(schema.attemptAnswers.questionId, f.theoryIds[0]!)))).length, 0);
    });
    await check('...but an objective answer on the same paper is still saved', async () => {
      const f = await fixture([true]); const paper = await openPaper(f); const sid = await f.mkStudent('ben');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number; questions: Array<{ id: number; type: string }> };
      const obj = r.questions.find((q) => q.type !== 'theory')!; const opt = (await db.select().from(schema.questionOptions).where(eq(schema.questionOptions.questionId, obj.id)))[0]!;
      assert.equal((await saveAnswer(f.schoolId, r.attemptId, sid, { questionId: obj.id, optionId: Number(opt.id) })).ok, true);
    });
    await check('on an ordinary paper typed theory is still accepted', async () => {
      const f = await fixture([false]); const paper = await openPaper(f); const sid = await f.mkStudent('cat');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number };
      assert.equal((await saveAnswer(f.schoolId, r.attemptId, sid, { questionId: f.theoryIds[0]!, text: 'typed' })).ok, true);
    });
    await check('the student still gets every theory question to read, after the objective part', async () => {
      const f = await fixture([true]); const paper = await openPaper(f); const sid = await f.mkStudent('dan');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { questions: Array<{ id: number; type: string }> };
      assert.equal(r.questions.length, 3 + 1); assert.equal(r.questions[3]!.type, 'theory'); assert.equal(r.questions[3]!.id, f.theoryIds[0]);
    });

    await check('submitting an on-paper paper gives the teacher an unmarked row per theory question (nothing typed)', async () => {
      const f = await fixture([true]); const paper = await openPaper(f); const sid = await f.mkStudent('eli');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; assert.equal((await submitAttempt(f.schoolId, r.attemptId, sid)).ok, true);
      const rows = await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, r.attemptId));
      assert.equal(rows.length, 1); assert.equal(rows[0]!.awardedMarks, null); assert.equal(rows[0]!.textAnswer, null);
    });
    await check('the marking queue flags the script as on paper, and the teacher enters the mark in the ordinary way', async () => {
      const f = await fixture([true]); const paper = await openPaper(f); const sid = await f.mkStudent('fay');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; await submitAttempt(f.schoolId, r.attemptId, sid);
      const q = await markingQueue(f.teacher.actor); assert.equal(q.length, 1); assert.equal(q[0]!.onPaper, true);
      assert.deepEqual(await awardMarks(f.teacher.actor, q[0]!.answerId, 7.5), { ok: true }); assert.equal((await markingQueue(f.teacher.actor)).length, 0);
      assert.equal((await awardMarks(f.teacher.actor, q[0]!.answerId, 11)).ok, false);
    });
    await check('on an ordinary paper the queue says the script was NOT on paper', async () => {
      const f = await fixture([false]); const paper = await openPaper(f); const sid = await f.mkStudent('gus');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; await submitAttempt(f.schoolId, r.attemptId, sid);
      assert.equal((await markingQueue(f.teacher.actor))[0]!.onPaper, false);
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
