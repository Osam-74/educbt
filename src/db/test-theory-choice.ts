/**
 * Theory choice: the teacher decides how many theory questions each student answers, and which ones every student must
 * get. Proves authoring, hand-in, composing, each student's draw, submission, marking and the result gate. Isolated fixture schools, removed at the end. LOCAL disposable database only.
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
  const { findOrCreateSet, addQuestion, updateQuestion, submitSet, setWithQuestions } = await import('@/lib/exam/sets');
  const { startAttempt, saveAnswer, submitAttempt } = await import('@/lib/exam/engine');
  const { markingQueue, awardMarks } = await import('@/lib/exam/results');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  type Opts = { objective?: number; theory?: number; theoryStatus?: 'approved' | 'draft'; theoryQuestionApproval?: 'approved' | 'pending'; seriesType?: 'examination' | 'ca_test'; waecTheory?: boolean };
  async function fixture(o: Opts = {}) {
    const { objective = 6, theory = 3, theoryStatus = 'approved', theoryQuestionApproval = 'approved', seriesType = 'examination', waecTheory = false } = o;
    const [school] = await db.insert(schema.schools).values({ name: 'Theory choice', code: 'TC-' + randomUUID() }).returning();
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


  /** Make the fixture's theory set ask for `answerCount` and tick some questions compulsory. */
  async function choose(f: Awaited<ReturnType<typeof fixture>>, answerCount: number, compulsoryIdx: number[] = []) {
    const [q0] = await db.select({ setId: schema.questions.questionSetId }).from(schema.questions).where(eq(schema.questions.id, f.theoryIds[0]!));
    await db.update(schema.questionSets).set({ theoryAnswerCount: answerCount }).where(eq(schema.questionSets.id, q0!.setId));
    for (const i of compulsoryIdx) await db.update(schema.questions).set({ isCompulsory: true }).where(eq(schema.questions.id, f.theoryIds[i]!));
  }
  const dealtTheory = (qs: Array<{ id: number; type: string }>) => qs.filter((q) => q.type === 'theory').map((q) => q.id);

  try {
    await check('a paper whose theory set has no number is delivered exactly as before: every student gets all the theory', async () => {
      const f = await fixture({ theory: 5 }); const paper = (await openPaper(f))!;
      assert.equal(paper.theoryAnswerCount, 0);
      for (const l of ['a1', 'a2', 'a3']) { const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent(l)) as { questions: Array<{ id: number; type: string }> };
        assert.deepEqual(dealtTheory(r.questions).sort(), [...f.theoryIds].sort()); }
    });
    await check('composing copies the teacher\'s number onto the paper', async () => {
      const f = await fixture({ theory: 5 }); await choose(f, 3); const paper = (await openPaper(f))!;
      assert.equal(paper.theoryAnswerCount, 3);
    });
    await check('every student gets exactly the chosen number of theory questions, after the objective part, in authored order', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 3); const paper = (await openPaper(f))!;
      for (let i = 0; i < 12; i++) { const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent('b' + i)) as { questions: Array<{ id: number; type: string }> };
        const t = dealtTheory(r.questions); assert.equal(t.length, 3); assert.equal(new Set(t).size, 3);
        assert.deepEqual(r.questions.slice(-3).map((q) => q.type), ['theory', 'theory', 'theory'], 'theory last');
        assert.deepEqual(t, [...t].sort((x, y) => f.theoryIds.indexOf(x) - f.theoryIds.indexOf(y)), 'authored order'); }
    });
    await check('compulsory questions are in EVERY student\'s paper', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 3, [1, 4]); const paper = (await openPaper(f))!;
      for (let i = 0; i < 15; i++) { const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent('c' + i)) as { questions: Array<{ id: number; type: string; compulsory: boolean }> };
        const t = dealtTheory(r.questions); assert.ok(t.includes(f.theoryIds[1]!) && t.includes(f.theoryIds[4]!)); assert.equal(t.length, 3);
        assert.deepEqual(r.questions.filter((q) => q.compulsory).map((q) => q.id).sort(), [f.theoryIds[1]!, f.theoryIds[4]!].sort(), 'the student is told which are compulsory'); }
    });
    await check('the rest is a real random pick: students do not all get the same questions, and every question can come up', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 2, [0]); const paper = (await openPaper(f))!; const seen = new Set<string>(); const hit = new Set<number>();
      for (let i = 0; i < 40; i++) { const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent('d' + i)) as { questions: Array<{ id: number; type: string }> };
        const t = dealtTheory(r.questions); seen.add(t.join(',')); t.forEach((x) => hit.add(x)); }
      assert.ok(seen.size > 2, `only ${seen.size} different papers in 40 students`); assert.equal(hit.size, 6, 'every question reached somebody');
    });
    await check('more ticked than answered: every student gets every ticked question (a tick is never ignored)', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 2, [0, 2, 4]); const paper = (await openPaper(f))!;
      for (let i = 0; i < 6; i++) { const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent('e' + i)) as { questions: Array<{ id: number; type: string }> };
        assert.deepEqual(dealtTheory(r.questions).sort(), [f.theoryIds[0]!, f.theoryIds[2]!, f.theoryIds[4]!].sort()); }
    });
    await check('a number larger than what was written just gives every student everything', async () => {
      const f = await fixture({ theory: 3 }); await choose(f, 9); const paper = (await openPaper(f))!;
      const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent('g1')) as { questions: Array<{ id: number; type: string }> };
      assert.equal(dealtTheory(r.questions).length, 3);
    });
    await check('the objective part is untouched by the choice: same count as before', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 2); const paper = (await openPaper(f))!;
      const r = await startAttempt(f.schoolId, Number(paper.id), await f.mkStudent('h1')) as { questions: Array<{ id: number; type: string }> };
      assert.equal(r.questions.filter((q) => q.type !== 'theory').length, 4);
    });
    await check('a resumed attempt keeps the very same dealt theory questions', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 3); const paper = (await openPaper(f))!; const sid = await f.mkStudent('i1');
      const a = await startAttempt(f.schoolId, Number(paper.id), sid) as { questions: Array<{ id: number }> }; const b = await startAttempt(f.schoolId, Number(paper.id), sid) as { questions: Array<{ id: number }>; resumed: boolean };
      assert.equal(b.resumed, true); assert.deepEqual(b.questions.map((q) => q.id), a.questions.map((q) => q.id));
    });

    await check('submitting makes unmarked answer rows ONLY for the theory questions the student was dealt', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 3); const paper = (await openPaper(f))!; const sid = await f.mkStudent('j1');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number; questions: Array<{ id: number; type: string }> };
      assert.ok((await submitAttempt(f.schoolId, r.attemptId, sid)).ok);
      const rows = await db.select().from(schema.attemptAnswers).where(and(eq(schema.attemptAnswers.attemptId, r.attemptId), inArray(schema.attemptAnswers.questionId, f.theoryIds)));
      assert.deepEqual(rows.map((x) => Number(x.questionId)).sort(), dealtTheory(r.questions).sort(), 'rows for the dealt 3, none for the 3 never seen');
    });
    await check('the teacher\'s marking queue lists only what each student was dealt', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 2); const paper = (await openPaper(f))!;
      for (const l of ['k1', 'k2', 'k3']) { const sid = await f.mkStudent(l); const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number }; await submitAttempt(f.schoolId, r.attemptId, sid); }
      assert.equal((await markingQueue(f.teacher.actor)).length, 3 * 2, '3 students x 2 dealt, not 3 x 6');
    });

    await check('MARKS: a student dealt 3 of 6 is scored out of those 3 only (what they could not see never counts)', async () => {
      const f = await fixture({ theory: 6 }); await choose(f, 3); const paper = (await openPaper(f))!; const sid = await f.mkStudent('l1');
      const r = await startAttempt(f.schoolId, Number(paper.id), sid) as { attemptId: number; questions: Array<{ id: number; type: string }> }; await submitAttempt(f.schoolId, r.attemptId, sid);
      const queue = await markingQueue(f.teacher.actor); assert.equal(queue.length, 3);
      for (const item of queue) assert.deepEqual(await awardMarks(f.teacher.actor, item.answerId, 10), { ok: true });
      assert.equal((await markingQueue(f.teacher.actor)).length, 0, 'nothing left to mark once the 3 dealt are marked');
      const rows = await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, r.attemptId));
      const answered = new Set(rows.filter((x) => x.awardedMarks !== null).map((x) => Number(x.questionId)));
      assert.ok(dealtTheory(r.questions).every((id) => answered.has(id)), 'every dealt theory question is marked');
      assert.equal(rows.filter((x) => f.theoryIds.includes(Number(x.questionId))).length, 3, 'no row exists for the 3 not dealt');
    });

    // ---- AUTHORING: the teacher's own screens (findOrCreateSet / addQuestion / updateQuestion / submitSet) ----
    const { saveCollection } = await import('@/lib/exam/collection');
    async function authoring(quotaTheory = 2) {
      const f = await fixture({ theory: 0, objective: 0 });
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      await db.update(schema.examSeries).set({ questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).where(eq(schema.examSeries.id, Number(f.series.id)));
      await saveCollection(f.officer.actor, { objective: 1, theory: quotaTheory, seriesId: Number(f.series.id) });
      const scope = { sessionId: Number(session!.id), termId: Number(term!.id), subjectId: f.subjectId, levelId: f.levelId, departmentId: null as number | null, seriesId: 0, waecMode: false };
      return { f, scope };
    }
    const write = (a: Awaited<ReturnType<typeof authoring>>, setId: number, n: number, extra: { isCompulsory?: boolean } = {}) =>
      addQuestion(a.f.teacher.actor, setId, { text: `Explain topic number ${n} in detail`, marks: 10, ...extra });

    // The fixture pre-creates a theory set; remove it so findOrCreateSet makes the set itself, the way a teacher's first visit does.
    const freshAuthoring = async (quota = 2) => {
      const a = await authoring(quota);
      // Both pre-made sets are already approved; a teacher's own first visit starts from none.
      await db.delete(schema.questionSets).where(eq(schema.questionSets.schoolId, a.f.schoolId));
      return a;
    };
    await check('AUTHORING: a new theory set is NOT held to the school quota (a quota of 5 needs only one question to exist)', async () => {
      const a = await freshAuthoring(5); const set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' });
      assert.equal(set.minRequired, 1); assert.equal(set.theoryAnswerCount, 0);
    });
    await check('HAND-IN: a theory set made BEFORE this change (still carrying an old quota of 4) can be handed in with 2 questions', async () => {
      const a = await freshAuthoring(4); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' });
      await db.update(schema.questionSets).set({ minRequired: 4 }).where(eq(schema.questionSets.id, th.id));
      await write(a, Number(th.id), 1); await write(a, Number(th.id), 2);
      const ob = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective' });
      await addQuestion(a.f.teacher.actor, Number(ob.id), { text: 'What is two plus two?', marks: 1, options: [{ text: '4', isCorrect: true }, { text: '5', isCorrect: false }] });
      const res = await submitSet(a.f.teacher.actor, Number(ob.id)) as { success: boolean; shortfall?: string[] }; assert.equal(res.success, true, String(res.shortfall));
    });
    await check('HAND-IN: a theory set with NO questions is still refused ("theory: 0 of 1")', async () => {
      const a = await freshAuthoring(4); await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' });
      const ob = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective' });
      await addQuestion(a.f.teacher.actor, Number(ob.id), { text: 'What is two plus two?', marks: 1, options: [{ text: '4', isCorrect: true }, { text: '5', isCorrect: false }] });
      const res = await submitSet(a.f.teacher.actor, Number(ob.id)) as { success: boolean; shortfall?: string[] };
      assert.equal(res.success, false); assert.ok(res.shortfall!.some((x) => /theory: 0 of 1/.test(x)), String(res.shortfall));
    });
    await check('AUTHORING: an objective set still keeps the school quota exactly as before', async () => {
      const a = await freshAuthoring(5); const set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective' });
      assert.equal(set.minRequired, 1, 'the quota fixture asked for 1 objective question');
    });
    await check('AUTHORING: the teacher\'s number is saved on the set, and can be changed or cleared while it is a draft', async () => {
      const a = await freshAuthoring(); let set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 3 }); assert.equal(set.theoryAnswerCount, 3);
      set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 5 }); assert.equal(set.theoryAnswerCount, 5);
      set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' }); assert.equal(set.theoryAnswerCount, 5, 'not sent = left as it is');
      set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 0 }); assert.equal(set.theoryAnswerCount, 0);
    });
    await check('AUTHORING: nonsense for the number (negative, text, decimal) means "every student answers all"', async () => {
      const a = await freshAuthoring();
      for (const bad of [-4, 2.5, Number.NaN]) { const set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: bad }); assert.equal(set.theoryAnswerCount, 0, String(bad)); }
    });
    await check('AUTHORING: an objective set can never carry a number', async () => {
      const a = await freshAuthoring(); const set = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective', theoryAnswerCount: 4 }); assert.equal(set.theoryAnswerCount, 0);
    });
    await check('AUTHORING: a question can be written as compulsory, and ticking it is ignored on an objective set', async () => {
      const a = await freshAuthoring(); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' });
      const q1 = await write(a, Number(th.id), 1, { isCompulsory: true }); const q2 = await write(a, Number(th.id), 2); assert.equal(q1.isCompulsory, true); assert.equal(q2.isCompulsory, false);
      const ob = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective' });
      const o1 = await addQuestion(a.f.teacher.actor, Number(ob.id), { text: 'What is two plus two?', marks: 1, isCompulsory: true, options: [{ text: '4', isCorrect: true }, { text: '5', isCorrect: false }] });
      assert.equal(o1.isCompulsory, false, 'an objective question is never compulsory');
    });
    await check('AUTHORING: a question can be ticked and unticked later, without sending it back for review', async () => {
      const a = await freshAuthoring(); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' }); const q = await write(a, Number(th.id), 1);
      await db.update(schema.questions).set({ approvalStatus: 'approved' }).where(eq(schema.questions.id, q.id));
      const on = await updateQuestion(a.f.teacher.actor, Number(q.id), { isCompulsory: true }); assert.equal(on.isCompulsory, true); assert.equal(on.approvalStatus, 'approved', 'choosing who gets it is not a change to the question');
      const off = await updateQuestion(a.f.teacher.actor, Number(q.id), { isCompulsory: false }); assert.equal(off.isCompulsory, false);
    });
    await check('AUTHORING: once a set is handed in the tick can no longer change', async () => {
      const a = await freshAuthoring(); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory' }); const q = await write(a, Number(th.id), 1);
      await db.update(schema.questionSets).set({ status: 'submitted' }).where(eq(schema.questionSets.id, th.id));
      await assert.rejects(updateQuestion(a.f.teacher.actor, Number(q.id), { isCompulsory: true }), /can no longer be edited/);
      const after = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 9 }); assert.equal(after.theoryAnswerCount, 0, 'the number is locked too');
    });
    await check('AUTHORING: the teacher\'s view of a set carries each question\'s compulsory tick and the number', async () => {
      const a = await freshAuthoring(); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 2 });
      await write(a, Number(th.id), 1, { isCompulsory: true }); await write(a, Number(th.id), 2);
      const view = (await setWithQuestions(a.f.teacher.actor, Number(th.id)))!; assert.equal(view.set.theoryAnswerCount, 2); assert.deepEqual(view.questions.map((x) => x.isCompulsory), [true, false]);
    });
    await check('HAND-IN: students asked to answer more theory than the teacher wrote is refused, in plain words, and nothing is submitted', async () => {
      const a = await freshAuthoring(); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 5 }); await write(a, Number(th.id), 1); await write(a, Number(th.id), 2);
      const ob = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective' });
      await addQuestion(a.f.teacher.actor, Number(ob.id), { text: 'What is two plus two?', marks: 1, options: [{ text: '4', isCorrect: true }, { text: '5', isCorrect: false }] });
      const res = await submitSet(a.f.teacher.actor, Number(ob.id)) as { success: boolean; shortfall?: string[] };
      assert.equal(res.success, false); assert.ok(res.shortfall!.some((x) => /answers 5 theory questions, but only 2 are written/.test(x)), String(res.shortfall));
      const [still] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, th.id)); assert.equal(still!.status, 'draft');
    });
    await check('HAND-IN: a teacher who wrote MORE than the school quota hands in fine, and the set is then delivered', async () => {
      const a = await freshAuthoring(2); const th = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'theory', theoryAnswerCount: 3 });
      for (let i = 1; i <= 7; i++) await write(a, Number(th.id), i, { isCompulsory: i === 1 });
      const ob = await findOrCreateSet(a.f.teacher.actor, { ...a.scope, examType: 'objective' });
      await addQuestion(a.f.teacher.actor, Number(ob.id), { text: 'What is two plus two?', marks: 1, options: [{ text: '4', isCorrect: true }, { text: '5', isCorrect: false }] });
      const res = await submitSet(a.f.teacher.actor, Number(ob.id)) as { success: boolean; shortfall?: string[] }; assert.equal(res.success, true, String(res.shortfall));
      const [t] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, th.id)); assert.equal(t!.status, 'submitted');
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
